/**
 * r2share —— 零费用的 R2 我的仓库
 *
 * 请求消耗模型（核心设计）：
 *   浏览目录页 : 1 次 Worker（动态渲染 HTML，用于注入登录态）+ 1 次 R2 读 files.json
 *                style.css / app.js 等静态资源由 CF 边缘直接服务，0 次 Worker
 *   下载文件   : 0 次 Worker（R2 公开桶直链，出口免费）
 *   上传文件   : 数据经 Worker 中转；索引提交按「整批」合并——
 *                1 次批量签名 + N 次写入 + 1 次批量提交（单个文件是 3 次）
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { renderIndex } from './views';
import { presignPut } from './sigv4';
import {
  createSession,
  verifySession,
  checkPassword,
  SESSION_COOKIE,
} from './auth';
import {
  isProxyMode,
  isUploadProxy,
  hasSessionKey,
  sessionSecretOf,
} from './mode';
import {
  sanitizePath,
  IndexConflictError,
  upsertFiles,
  removeFile,
  removeFiles,
  removeDir,
  rebuildIndex,
  readIndex,
  resolveType,
  type FileEntry,
} from './store';

/**
 * Worker 运行时可见的环境变量。
 * 与「运行模式判定」相关的那几个（DL_DOMAIN / LOCAL_MODE / UPLOAD_VIA_WORKER /
 * ADMIN_PASSWORD / SESSION_SECRET）在 src/mode.ts 里有对应的结构化声明 ModeEnv，
 * 判据逻辑与测试都在那边。
 */
export interface Env {
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  DL_DOMAIN: string;
  SITE_NAME: string;
  SESSION_DAYS: string;
  MAX_UPLOAD: string;
  BUCKET_NAME: string;
  /** '1' 时生产环境上传改走 Worker 代理（绕开被墙的 r2.cloudflarestorage.com 直传） */
  UPLOAD_VIA_WORKER: string;
  /** '1' 强制本地代理模式 / '0' 强制生产模式；不设则由 DL_DOMAIN 是否为合法 URL 推断 */
  LOCAL_MODE: string;
  ADMIN_PASSWORD: string;
  /** 选填：不设则从 ADMIN_PASSWORD 派生（见 sessionSecretOf），部署时少配一个密钥 */
  SESSION_SECRET: string;
  /** 选填：仅当关闭 Worker 中转（UPLOAD_VIA_WORKER=0）走 presigned 直传时才需要 */
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** 选填：S3 端点就是 <account_id>.r2.cloudflarestorage.com，可与 CLOUDFLARE_ACCOUNT_ID 同值 */
  R2_ACCOUNT_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * 索引条件写连续冲突（极端并发）时返回 409 而不是 500：
 * 这不是服务端故障——对象已经写进桶，只是没进索引（点一次「重建索引」即可对齐），
 * 前端据此提示「稍后重试」。其余异常照旧记日志并返回 500。
 */
app.onError((err, c) => {
  if (err instanceof IndexConflictError) {
    return c.json({ error: '索引正被其他请求修改，请稍后重试' }, 409);
  }
  console.error('[r2share] 未处理异常:', err);
  return c.text('Internal Server Error', 500);
});

/** 单次批量提交索引的条目上限 */
const MAX_COMMIT_BATCH = 1000;
/** 单次批量删除的文件数上限（R2 单次 delete 也是 1000 个 key 一批） */
const MAX_DELETE_BATCH = 1000;

/**
 * 判断当前请求是否已登录。
 * 会话密钥与「是否具备密钥来源」的判定都在 src/mode.ts（抽出去是为了可离线测试）。
 */
async function isLogin(c: any): Promise<boolean> {
  // 两个来源都没配时，派生结果是个公开常量，不能当有效密钥 → 一律判未登录
  if (!hasSessionKey(c.env)) return false;
  return verifySession(await sessionSecretOf(c.env), getCookie(c, SESSION_COOKIE));
}

/* ---------------- 登录失败限流 ----------------
 * 用模块级 Map 而不是 KV：
 *   - KV 免费版「同一个 key 每秒只能写 1 次」且「每天 1000 次写」。爆破时同一 IP
 *     的连续写会失败，计数也就跟着失真，甚至把登录接口打成 500。
 *   - 内存计数零额度、零往返，登录路径顺带少一次 KV 读，响应更快。
 * 代价：isolate 之间不共享计数，多 isolate 下限流会被稀释。这是有意的取舍——
 * 限流只负责挡住「慢慢猜口令」这种高频尝试，真正的防线是 ADMIN_PASSWORD 本身。
 */
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 10;
/** 计数表容量上限：防止攻击者用海量不同 IP 撑爆 isolate 的 128MB 内存 */
const FAIL_KEYS_MAX = 5000;

const failTable = new Map<string, { n: number; until: number }>();

/** 当前 IP 在窗口内的失败次数（顺手清掉已过期的那条） */
function failCountOf(ip: string): number {
  const rec = failTable.get(ip);
  if (!rec) return 0;
  if (rec.until <= Date.now()) {
    failTable.delete(ip);
    return 0;
  }
  return rec.n;
}

/** 记一次失败，返回累计次数 */
function markFail(ip: string): number {
  const now = Date.now();
  const rec = failTable.get(ip);
  const n = rec && rec.until > now ? rec.n + 1 : 1;
  failTable.set(ip, { n, until: now + FAIL_WINDOW_MS });
  if (failTable.size > FAIL_KEYS_MAX) sweepFails(now);
  return n;
}

/** 登录成功后清空该 IP 的失败计数 */
function clearFail(ip: string): void {
  failTable.delete(ip);
}

/** 容量超限时先清过期项，再按插入顺序淘汰最早的，保证内存有界 */
function sweepFails(now: number): void {
  for (const [k, v] of failTable) {
    if (v.until <= now) failTable.delete(k);
  }
  while (failTable.size > FAIL_KEYS_MAX) {
    const k = failTable.keys().next().value;
    if (k === undefined) break;
    failTable.delete(k);
  }
}

/** 清洗前端传来的 MIME：去掉换行/控制字符并限长（/api/sign 与 /api/commit 口径一致） */
function cleanType(t: unknown): string {
  return String(t || '')
    .replace(/[\r\n]/g, '')
    .slice(0, 200);
}

function clientIP(c: any): string {
  // CF 边缘一定会设置 cf-connecting-ip；x-forwarded-for 只在本地 dev 等
  // 非 CF 环境下才可能命中，作为兜底保留但不作为生产判据
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    'unknown'
  );
}

/* ---------------- 页面 ---------------- */

/* 运行模式判定（isProxyMode / isUploadProxy）与会话密钥派生都在 src/mode.ts：
 * 那里零依赖、可被 scripts/test-mode.mjs 直接 import 做离线单测，
 * 判据为什么这么定（不看 R2 凭证、只看公开桶下载域）也一并写在那个文件里。 */

app.get('/', async (c) => {
  const login = await isLogin(c);
  return c.html(
    renderIndex({
      siteName: c.env.SITE_NAME || '我的仓库',
      dlDomain: c.env.DL_DOMAIN || '',
      isLogin: login,
      proxyMode: isProxyMode(c.env),
    })
  );
});

/* ---------------- Worker 代理路由（路径里的 local- 是历史命名，语义见下） ----------------
 * /api/local-index 与 /api/local-get 仅在「代理模式」（isProxyMode：没配公开桶下载域
 * DL_DOMAIN）下可用，供 wrangler dev / 纯本地验证；生产配好 DL_DOMAIN 后自动返回 400。
 * /api/local-put 是例外：生产开启 UPLOAD_VIA_WORKER=1 时它就是上传主路径（见 isUploadProxy）。
 * 生产环境的下载与索引始终走 R2 公开桶直链（DL_DOMAIN），不经过这里。
 * 路径名保留 local- 前缀是为了不动前端与冒烟脚本的既有契约。
 */

app.get('/api/local-index', async (c) => {
  if (!isProxyMode(c.env)) return c.text('生产环境请直接读取公开桶的 files.json', 400);
  // 复用 readIndex 的容灾语义：索引不存在或损坏时返回空索引，可用 /api/refresh 重建
  const idx = await readIndex(c.env.BUCKET);
  return c.json(idx);
});

app.get('/api/local-get', async (c) => {
  if (!isProxyMode(c.env)) return c.text('生产环境请走 R2 公开桶直链', 400);
  const key = sanitizePath(c.req.query('key'));
  if (!key) return c.text('缺少 key', 400);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.text('文件不存在', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
});

app.put('/api/local-put', async (c) => {
  if (!isUploadProxy(c.env)) {
    return c.text('上传代理未启用，请配置 UPLOAD_VIA_WORKER=1 或使用 presigned 直传', 400);
  }
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);
  const key = sanitizePath(c.req.query('key'));
  if (!key) return c.text('缺少 key', 400);

  // 显式校验大小：/api/sign 校验的是前端「声明」的 size，实际 PUT 的 body 可以更大。
  // 这里按 content-length 兜一道，让超限请求在入口就被拒，而不是打到 R2 才失败。
  // （CF 会在请求到达 Worker 前补齐并校验 Content-Length，伪造值会被边缘直接拒绝）
  const max = parseInt(c.env.MAX_UPLOAD || '0', 10);
  const len = parseInt(c.req.header('content-length') || '0', 10) || 0;
  if (max > 0 && len > max) {
    return c.json({ error: `文件超过大小上限（${Math.floor(max / 1048576)}MB）` }, 413);
  }

  // 代理模式下 Content-Type 不参与签名，改由服务端按扩展名决定（更准，见 resolveType）
  const ctype = resolveType(key, c.req.header('content-type'));

  if (isProxyMode(c.env)) {
    // 本地 miniflare：流式 put 会落盘为 0 字节，只能读进内存再写
    const body = await c.req.arrayBuffer();
    await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: ctype } });
    return c.json({ ok: true, key, size: body.byteLength });
  }

  // 生产代理模式：流式透传 request body 到 R2，不占 Worker 内存
  // （限制同 Workers 请求体上限，与 MAX_UPLOAD 对齐）
  // 注意用 c.req.raw.body（原生 Request.body）而非 c.req.body，Hono 的类型不接受后者
  const body = c.req.raw.body;
  if (!body) return c.text('缺少请求体', 400);
  const obj = await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: ctype },
  });
  return c.json({ ok: true, key, size: obj.size });
});

/* ---------------- 鉴权 ---------------- */

app.post('/api/login', async (c) => {
  const ip = clientIP(c);
  // 已锁定的 IP 直接拒绝，连口令校验都不做，避免继续消耗 CPU
  if (failCountOf(ip) >= FAIL_MAX) {
    return c.json({ ok: false, error: '尝试次数过多，请 15 分钟后再试' }, 429);
  }

  let password: string | undefined;
  try {
    ({ password } = (await c.req.json()) as { password?: string });
  } catch {
    /* 忽略解析失败，下面按空口令处理 */
  }

  const expected = c.env.ADMIN_PASSWORD;
  if (!expected || !(await checkPassword(password ?? '', expected))) {
    markFail(ip);
    return c.json({ ok: false, error: '口令错误' }, 401);
  }

  clearFail(ip);
  const days = parseInt(c.env.SESSION_DAYS || '30', 10) || 30;
  // 与 isLogin 用同一个派生函数，保证「签发」与「校验」两侧密钥一致
  const token = await createSession(await sessionSecretOf(c.env), days);
  const secure = new URL(c.req.url).protocol === 'https:';

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: days * 86400,
  });
  return c.json({ ok: true });
});

app.post('/api/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/* ---------------- 上传：签名 + 提交 ---------------- */

/**
 * 第一步：签发上传目标地址。
 *
 * 两种请求形态：
 *   { path, size, type }                    单条（响应 url/key/ctype，兼容旧调用）
 *   { entries: [{ path, size, type }, ...] } 批量（响应 items[]，批量上传时用）
 *
 * 批量形态把「一次文件一次签名」压成一次请求：拖入 200 个文件时，
 * Worker 请求数从 200 降到 1（代理模式下签名本身几乎零成本）。
 */
app.post('/api/sign', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string; size?: number; type?: string; entries?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const batch = Array.isArray(body.entries);
  const raw = batch ? (body.entries as unknown[]) : [body];
  if (!raw.length) return c.json({ error: '没有要上传的文件' }, 400);
  if (raw.length > MAX_COMMIT_BATCH) {
    return c.json({ error: `一次最多上传 ${MAX_COMMIT_BATCH} 个文件` }, 413);
  }

  const max = parseInt(c.env.MAX_UPLOAD || '0', 10);
  const jobs: { path: string; ctype: string }[] = [];
  for (const it of raw) {
    const item = it as { path?: string; size?: number; type?: string };
    const path = sanitizePath(item.path);
    if (!path) return c.json({ error: '路径非法' }, 400);
    if (max > 0 && (item.size ?? 0) > max) {
      return c.json(
        { error: `文件超过大小上限（${Math.floor(max / 1048576)}MB）：${path}` },
        413
      );
    }
    // 防注入 + 按扩展名归一：content-type 只参与签名，不允许换行/控制字符；
    // 浏览器对 7z/dmg/apk/exe 给不出 MIME，原样签名会让 R2 存下错误的 Content-Type
    jobs.push({ path, ctype: resolveType(path, cleanType(item.type)) });
  }

  // 上传走 Worker 代理：本地开发或生产开启 UPLOAD_VIA_WORKER=1。
  // 生产场景为避免 r2.cloudflarestorage.com 被墙（ERR_ADDRESS_UNREACHABLE），
  // 上传目标改为本 Worker 的同源 /api/local-put（浏览器无需 CORS、不依赖被墙端点）。
  if (isUploadProxy(c.env)) {
    const items = jobs.map(({ path, ctype }) => ({
      path,
      url: `/api/local-put?key=${encodeURIComponent(path)}`,
      ctype,
    }));
    if (!batch) {
      // 响应字段名沿用 local（既有契约），语义同 isUploadProxy
      return c.json({ ok: true, url: items[0].url, key: items[0].path, ctype: items[0].ctype, local: true });
    }
    return c.json({ ok: true, items, local: true });
  }

  // 走到这里说明上传走 presigned 直传（UPLOAD_VIA_WORKER != '1'），必须有 S3 凭证。
  // 凭证本身是选填项（代理上传用不到），因此缺了要给出可操作的报错，
  // 而不是让浏览器在 PUT 时吃一个语焉不详的 403。
  const accessKeyId = c.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = c.env.R2_SECRET_ACCESS_KEY;
  // S3 端点即 <account_id>.r2.cloudflarestorage.com，两个名字同值，所以允许只配一个。
  // 正常路径是 CI 的 sync 步骤把 CLOUDFLARE_ACCOUNT_ID 的值写进 R2_ACCOUNT_ID 这个
  // secret（见 .github/workflows/deploy.yml）；后面的 CLOUDFLARE_ACCOUNT_ID 只是兜底，
  // 仅当有人手动把它也配成 Worker 变量时才取得到——Worker 运行时不会自带这个名字。
  const accountId = c.env.R2_ACCOUNT_ID || c.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accessKeyId || !secretAccessKey || !accountId) {
    return c.json(
      {
        error:
          '未配置 R2 S3 凭证，无法使用 presigned 直传。' +
          '请设置 UPLOAD_VIA_WORKER=1 改走 Worker 中转，或补齐 R2_ACCESS_KEY_ID / ' +
          'R2_SECRET_ACCESS_KEY / R2_ACCOUNT_ID',
      },
      500
    );
  }
  const cred = { accessKeyId, secretAccessKey, accountId, bucket: c.env.BUCKET_NAME };
  const items = await Promise.all(
    jobs.map(async ({ path, ctype }) => ({
      path,
      // 回传 ctype：前端 PUT 与 commit 必须与签名用的值完全一致，否则 R2 判签名不匹配（403）
      ctype,
      url: await presignPut(cred, path, 3600, new Date(), ctype),
    }))
  );
  if (!batch) {
    return c.json({ ok: true, url: items[0].url, key: items[0].path, ctype: items[0].ctype });
  }
  return c.json({ ok: true, items });
});

/**
 * 第二步：上传成功后，把文件信息增量写入 files.json。
 *
 * 两种请求形态：
 *   { path, type }                          单条（兼容旧调用）
 *   { entries: [{ path, type }, ...] }       批量（响应含写入的 entries 供前端增量更新）
 *
 * 批量提交把 N 次「读索引 → 改 → 写索引」压成 1 次，这是上传链路里最贵的一环。
 */
app.post('/api/commit', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string; type?: string; entries?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const batch = Array.isArray(body.entries);
  const raw = batch ? (body.entries as unknown[]) : [body];
  if (!raw.length) return c.json({ error: '没有要提交的文件' }, 400);
  if (raw.length > MAX_COMMIT_BATCH) {
    return c.json({ error: `一次最多提交 ${MAX_COMMIT_BATCH} 个文件` }, 413);
  }

  const paths: string[] = [];
  for (const it of raw) {
    const path = sanitizePath((it as { path?: string }).path);
    if (!path) return c.json({ error: '路径非法' }, 400);
    paths.push(path);
  }

  // 校验对象真实存在，以桶里的实际大小为准（防止伪造 commit 污染索引）。
  // 并行 head：串行会把批量提交拖成 N 个往返，正好抵消批量化的收益。
  const heads = await Promise.all(paths.map((p) => c.env.BUCKET.head(p)));

  const items: FileEntry[] = [];
  const missing: string[] = [];
  const now = Date.now();
  for (let i = 0; i < paths.length; i++) {
    const obj = heads[i];
    if (!obj) {
      missing.push(paths[i]);
      continue;
    }
    items.push({
      p: paths[i],
      s: obj.size,
      t: now,
      // 与 /api/sign、/api/local-put 同一口径：保证索引里的 MIME 与对象实际存储一致
      c: resolveType(paths[i], cleanType((raw[i] as { type?: string }).type)),
    });
  }

  if (items.length) await upsertFiles(c.env.BUCKET, items);
  return c.json({ ok: missing.length === 0, count: items.length, entries: items, missing });
});

/** 删除单个文件：删对象 + 从索引移除 */
app.delete('/api/file', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  await c.env.BUCKET.delete(path);
  await removeFile(c.env.BUCKET, path);
  return c.json({ ok: true });
});

/**
 * 批量删除文件：一次请求删掉多个对象 + 一次索引读写。
 * 前端批量删除原本是逐个串行调用 /api/file，删 100 个就是 100 次 Worker
 * 和 100 次索引读改写；合并成一次后只剩 1 次请求 + 1 次索引写。
 */
app.delete('/api/files', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { paths?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const raw = Array.isArray(body.paths) ? body.paths : [];
  const paths: string[] = [];
  for (const p of raw) {
    const s = sanitizePath(p);
    if (!s) return c.json({ error: '路径非法' }, 400);
    paths.push(s);
  }
  if (!paths.length) return c.json({ error: '没有要删除的文件' }, 400);
  if (paths.length > MAX_DELETE_BATCH) {
    return c.json({ error: `一次最多删除 ${MAX_DELETE_BATCH} 个文件` }, 413);
  }

  // R2 的 delete 单次最多 1000 个 key，按上限分批（正常一批就够）
  for (let i = 0; i < paths.length; i += 1000) {
    await c.env.BUCKET.delete(paths.slice(i, i + 1000));
  }
  const removed = await removeFiles(c.env.BUCKET, paths);
  return c.json({ ok: true, removed, requested: paths.length });
});

/* ---------------- 目录：新建 + 删除 ---------------- */

/**
 * 新建目录：创建 <path>/ 的 0 字节占位对象并写入索引。
 * R2 没有原生目录，前端 listDir 靠路径推导；占位对象保证
 * 空目录在索引里可见，且 rebuildIndex 后依然存在。
 * 幂等：目录已存在时直接返回 ok。
 */
app.post('/api/mkdir', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  const prefix = path + '/';

  // 幂等：对象已存在时也要补写一次索引条目。否则「占位对象在、索引条目丢失」
  // （索引被清空过、或手工删过条目）时，点新建同名目录只返回 ok，目录却始终不显示。
  if (!(await c.env.BUCKET.head(prefix))) {
    await c.env.BUCKET.put(prefix, new Uint8Array(0), {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
  }

  await upsertFiles(c.env.BUCKET, [
    {
      p: prefix,
      s: 0,
      t: Date.now(),
      c: 'application/octet-stream',
    },
  ]);
  return c.json({ ok: true });
});

/** 删除目录（递归）：删掉该前缀下所有对象 + 占位对象，并清理索引 */
app.delete('/api/dir', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);

  let body: { path?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const path = sanitizePath(body.path);
  if (!path) return c.json({ error: '路径非法' }, 400);

  const n = await removeDir(c.env.BUCKET, path);
  return c.json({ ok: true, removed: n });
});

/** 全量重建索引：rclone / 后台直传文件后，把 files.json 对齐到桶的真实内容 */
app.post('/api/refresh', async (c) => {
  if (!(await isLogin(c))) return c.json({ error: '未登录' }, 401);
  const r = await rebuildIndex(c.env.BUCKET);
  return c.json({ ok: true, files: r.files });
});

/* ---------------- 静态资源兜底 ---------------- */

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
