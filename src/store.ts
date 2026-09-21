/**
 * files.json 索引读写 + 路径安全校验
 *
 * 设计要点：
 * 1. 索引本身也存在 R2 里（公开可读），前端直接 fetch 渲染，目录页因此零 Worker 消耗
 * 2. 更新走增量（读 → 改 → 写），不做全量重建，避免超出免费版 10ms CPU 限制
 * 3. 所有路径必须过 sanitizePath，挡住 ../ 穿越与控制字符
 * 4. 所有索引写入都收敛到 mutateIndex 的「读 → 改 → 条件写」重试循环：
 *    模块级 promise 锁只在单个 isolate 内有效，而 Cloudflare 会因负载或版本更新
 *    创建多个 isolate，多端同时改索引时两边各自「读 → 改 → 写」，后写的会覆盖
 *    先写的（丢条目）。条件写（CAS）让「读出来之后被别人改过」的提交直接失败，
 *    从而重读重放，而不是把别人的改动盖掉。
 */

export interface FileEntry {
  /** 相对路径，如 "文档/报告.pdf" */
  p: string;
  /** 字节大小 */
  s: number;
  /** 上传时间戳（毫秒） */
  t: number;
  /** MIME 类型 */
  c: string;
}

export interface FileIndex {
  updated: number;
  files: FileEntry[];
}

const INDEX_KEY = 'files.json';

/** 索引对象的存储元数据：只缓存 10 秒，保证上传后能较快看到新文件 */
const INDEX_META = {
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=10',
};

/** 条件写冲突时的最大重试次数（超过则报错，交给用户重试，不静默丢改动） */
const INDEX_TRIES = 6;

/**
 * 索引条件写连续冲突：重试 INDEX_TRIES 次仍被别的 isolate 抢先。
 * 单独成类，是为了让上层能把「并发冲突」与「真正的服务端故障」区分开——
 * 前者是瞬时竞争（对象已进桶、只是没进索引），后者才是 500。
 */
export class IndexConflictError extends Error {
  name = 'IndexConflictError';
}

/**
 * 规范化并校验用户提交的路径。
 * 返回 null 表示路径非法。
 */
export function sanitizePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();

  // 拒绝绝对路径：R2 的 key 一律是相对的，开头带 / 或 \ 说明意图可疑
  if (/^[/\\]/.test(p)) return null;

  // 统一成正斜杠，去掉尾部斜杠
  p = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p) return null;

  // 索引文件是系统保留 key：绝不能通过用户接口上传/删除。
  // 否则一次误传（本地恰好有个同名文件）就会把整个目录索引冲掉。
  if (p === INDEX_KEY) return null;

  // 拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;

  // 逐段检查
  const segs = p.split('/');
  for (const seg of segs) {
    if (!seg) return null; // 空段（连续斜杠）
    if (seg === '.' || seg === '..') return null; // 路径穿越
    if (seg.length > 255) return null;
  }

  // R2 对象 key 上限 1024 字节，留余量按 900 字节校验（中文字符 UTF-8 占 3 字节）
  if (new TextEncoder().encode(p).length > 900) return null;

  return segs.join('/');
}

function emptyIndex(): FileIndex {
  return { updated: 0, files: [] };
}

/** 把从 R2 读到的 JSON 归一成 FileIndex；结构不对时退回空索引 */
function normalizeIndex(data: unknown): FileIndex {
  if (!data || !Array.isArray((data as FileIndex).files)) return emptyIndex();
  return data as FileIndex;
}

/** 读取索引；不存在或损坏时返回空索引 */
export async function readIndex(bucket: R2Bucket): Promise<FileIndex> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) return emptyIndex();
  try {
    return normalizeIndex(await obj.json());
  } catch {
    return emptyIndex();
  }
}

/**
 * 索引写入的唯一入口：读 → 改 → 条件写（CAS），冲突则重读重放。
 *
 * 约束（后续改动务必遵守）：
 *   - mutate 必须是**纯内存变换**：内部不得 await 任何存储操作。删除对象、
 *     遍历桶这类一次性副作用必须先做完，再把结果带进 mutate。
 *   - mutate 必须**可重放且幂等**：条件写冲突时会拿最新索引重新执行一次。
 *   - 返回 dirty=false 表示没有任何改动，此时不会写回。
 */
async function mutateIndex<T>(
  bucket: R2Bucket,
  mutate: (index: FileIndex) => { out: T; dirty: boolean }
): Promise<T> {
  for (let attempt = 0; attempt < INDEX_TRIES; attempt++) {
    const obj = await bucket.get(INDEX_KEY);
    let index = emptyIndex();
    let etag: string | undefined;
    if (obj) {
      etag = obj.etag;
      try {
        index = normalizeIndex(await obj.json());
      } catch {
        // 索引损坏：按空索引重建，与 readIndex 的容灾语义保持一致
      }
    }

    const { out, dirty } = mutate(index);
    if (!dirty) return out;

    index.updated = Date.now();
    const opts: R2PutOptions = { httpMetadata: INDEX_META };
    // 只有「索引读出来之后没人改过它」（etag 未变）才允许提交。
    // 必须用真实 etag：etagMatches:'*' 的通配语义在 miniflare 上是反的（workers-sdk#6411）。
    // 索引还没创建时改用 etagDoesNotMatch:'*'（仅当仍不存在才创建），
    // 否则两个请求同时首次创建索引会互相覆盖。
    if (etag) opts.onlyIf = { etagMatches: etag };
    else opts.onlyIf = { etagDoesNotMatch: '*' };

    const res = await bucket.put(INDEX_KEY, JSON.stringify(index), opts);
    if (res) return out;
    // res === null：条件不满足（别的 isolate 抢先写过）→ 重读、重放、重试
  }
  throw new IndexConflictError(`索引写入冲突：重试 ${INDEX_TRIES} 次仍未成功，请重试`);
}

/**
 * 新增或更新若干条记录（增量，不重建整个索引）。
 *
 * dirty 必须「确有变化」才为 true（原来是恒 true）：原样重复提交同一批
 * ——重复建同名目录、重试一次其实已经成功的 commit——不该白白触发一次
 * 「读索引 + 写索引」，更不该平白制造一次 CAS 争用（多端同时写时，它正是
 * 409「索引正被其他请求修改」的来源之一）。
 *
 * 判定用逐字段比对 p/s/t/c：全部一致才算无变化。想让这条优化真正生效，
 * 调用方给出的 t 必须是稳定的——见 src/index.ts：commit 用 obj.uploaded，
 * mkdir 用占位对象自己的 uploaded，都不是 Date.now()。
 */
export async function upsertFiles(
  bucket: R2Bucket,
  entries: FileEntry[]
): Promise<void> {
  if (!entries.length) return;
  await mutateIndex(bucket, (index) => {
    // 先建一次位置表：批量上传几百个文件时，逐个 findIndex 会退化成 O(N×M)
    const pos = new Map<string, number>();
    index.files.forEach((f, i) => {
      if (!pos.has(f.p)) pos.set(f.p, i);
    });
    let dirty = false;
    for (const entry of entries) {
      const i = pos.get(entry.p);
      if (i === undefined) {
        pos.set(entry.p, index.files.length);
        index.files.push(entry);
        dirty = true;
        continue;
      }
      const old = index.files[i];
      if (old.s === entry.s && old.t === entry.t && old.c === entry.c) continue;
      index.files[i] = entry;
      dirty = true;
    }
    return { out: null, dirty };
  });
}

/** 新增或更新一条记录 */
export function upsertFile(bucket: R2Bucket, entry: FileEntry): Promise<void> {
  return upsertFiles(bucket, [entry]);
}

/** 批量删除记录：一次索引读写删掉多条，返回实际删掉的条数 */
export async function removeFiles(
  bucket: R2Bucket,
  paths: string[]
): Promise<number> {
  if (!paths.length) return 0;
  return mutateIndex(bucket, (index) => {
    const drop = new Set(paths);
    const next = index.files.filter((f) => !drop.has(f.p));
    const removed = index.files.length - next.length;
    if (!removed) return { out: 0, dirty: false };
    index.files = next;
    return { out: removed, dirty: true };
  });
}

/** 删除一条记录；返回是否真的删掉了 */
export async function removeFile(
  bucket: R2Bucket,
  path: string
): Promise<boolean> {
  return (await removeFiles(bucket, [path])) > 0;
}

/**
 * 递归删除目录：删掉 path/ 前缀下的所有对象 + 占位对象本身，
 * 同时把索引里以 path/ 开头的条目（含占位条目）全部移除。
 * 返回删除的对象个数（不含占位对象）。
 */
export async function removeDir(
  bucket: R2Bucket,
  path: string
): Promise<number> {
  const prefix = path + '/';

  // 副作用（删对象）必须在 CAS 循环外先做完：mutate 可能被重放，不能夹带写操作
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) {
      await bucket.delete(keys);
      // 目录占位对象的 key 一律以 / 结尾（<dir>/ 的 0 字节对象），不计入文件数。
      // 只排除 key === prefix 是不够的：嵌套子目录（_vf/sub/）的占位对象会被漏掉，
      // 让「已删除（含 N 个文件）」把子目录也算成文件。
      n += keys.filter((k) => !k.endsWith('/')).length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // 占位对象（新建目录时创建的 <dir>/ 0 字节对象）已随上面的循环一并删除：
  // list({prefix}) 是前缀匹配，key 恰好等于 prefix 的对象也在返回结果里
  // （计数处的 filter 正是把它排除掉），无需再删一次。

  await mutateIndex(bucket, (index) => {
    const next = index.files.filter(
      (f) => f.p !== prefix && !f.p.startsWith(prefix)
    );
    if (next.length === index.files.length) return { out: null, dirty: false };
    index.files = next;
    return { out: null, dirty: true };
  });
  return n;
}

/**
 * 全量重建索引：遍历桶内所有对象（跳过 files.json 自身）。
 * 适用场景：用 rclone / CF 后台直接传了文件，增量索引对不上真实内容。
 * list 的等待时间不计入 CPU，JSON 组装对几千个文件也足够轻，
 * 免费版 10ms CPU 限定内可支撑数千个对象。
 */
export async function rebuildIndex(
  bucket: R2Bucket
): Promise<{ files: number }> {
  // 遍历桶是副作用，放在 CAS 循环外；mutate 只负责把算好的结果换上去（幂等）
  const files: FileEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      if (o.key === INDEX_KEY) continue;
      files.push({
        p: o.key,
        s: o.size,
        t: o.uploaded.getTime(),
        c: guessType(o.key),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await mutateIndex(bucket, (index) => {
    index.files = files;
    return { out: null, dirty: true };
  });
  return { files: files.length };
}

/**
 * 常见扩展名 → MIME（模块级常量：避免每次调用重建对象，rebuildIndex 会调用上千次）
 *
 * 覆盖面要与前端 public/app.js 的类型判定表（EXT_KIND / TEXT_EXT / OFFICE_EXT）对齐：
 * 表里查不到的扩展名，resolveType 只能回退到浏览器的 hint，而浏览器对 7z/rar/mkv
 * 这类格式常给空串或 octet-stream，落库的 Content-Type 就是错的；rebuildIndex 更是
 * 没有 hint 可用（只有扩展名），查不到会一律退化成 octet-stream。
 */
const MIME_BY_EXT: Record<string, string> = {
  /* 图片 */
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  /* 视频 */
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  /* 音频 */
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  /* 压缩包 */
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  tar: 'application/x-tar',
  /* 文档 */
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  apk: 'application/vnd.android.package-archive',
  exe: 'application/vnd.microsoft.portable-executable',
  dmg: 'application/x-apple-diskimage',
  /* 文本 / 数据 */
  txt: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  xml: 'text/xml; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  cfg: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  env: 'text/plain; charset=utf-8',
  properties: 'text/plain; charset=utf-8',
  sql: 'text/x-sql; charset=utf-8',
  diff: 'text/x-diff; charset=utf-8',
  patch: 'text/x-diff; charset=utf-8',
  nfo: 'text/plain; charset=utf-8',
  readme: 'text/plain; charset=utf-8',
  license: 'text/plain; charset=utf-8',
  gitignore: 'text/plain; charset=utf-8',
  gitattributes: 'text/plain; charset=utf-8',
  editorconfig: 'text/plain; charset=utf-8',
  dockerfile: 'text/plain; charset=utf-8',
  cmake: 'text/plain; charset=utf-8',
  gradle: 'text/plain; charset=utf-8',
  /* 代码 */
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  jsx: 'text/jsx; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  tsx: 'text/tsx; charset=utf-8',
  css: 'text/css; charset=utf-8',
  scss: 'text/x-scss; charset=utf-8',
  sass: 'text/x-sass; charset=utf-8',
  less: 'text/less; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  vue: 'text/plain; charset=utf-8',
  svelte: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  pyw: 'text/x-python; charset=utf-8',
  go: 'text/x-go; charset=utf-8',
  rs: 'text/x-rust; charset=utf-8',
  java: 'text/x-java; charset=utf-8',
  kt: 'text/plain; charset=utf-8',
  scala: 'text/plain; charset=utf-8',
  swift: 'text/plain; charset=utf-8',
  dart: 'text/plain; charset=utf-8',
  c: 'text/x-c; charset=utf-8',
  h: 'text/x-c; charset=utf-8',
  cc: 'text/x-c; charset=utf-8',
  cpp: 'text/x-c; charset=utf-8',
  hpp: 'text/x-c; charset=utf-8',
  cs: 'text/plain; charset=utf-8',
  m: 'text/x-c; charset=utf-8',
  mm: 'text/x-c; charset=utf-8',
  php: 'text/x-php; charset=utf-8',
  rb: 'text/x-ruby; charset=utf-8',
  pl: 'text/x-perl; charset=utf-8',
  lua: 'text/x-lua; charset=utf-8',
  r: 'text/plain; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  bat: 'text/plain; charset=utf-8',
  cmd: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8',
};

/** 常见扩展名 → MIME，猜不出来时回退到 octet-stream */
export function guessType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * 决定对象最终的 Content-Type：扩展名能识别时以扩展名为准，否则回退到 hint。
 *
 * 为什么不信浏览器给的 file.type：对 7z / dmg / apk / exe / flac / epub 等类型，
 * 浏览器一律给空串或 octet-stream，直传后 R2 里存的 MIME 就是错的（下载无法正确识别）；
 * 扩展名稳定可预测，且与前端预览的类型判定口径一致。
 * hint 仅在扩展名未知时兜底（例如无扩展名的自定义格式）。
 */
export function resolveType(path: string, hint?: string): string {
  const guessed = guessType(path);
  if (guessed !== 'application/octet-stream') return guessed;
  const h = typeof hint === 'string' ? hint.trim() : '';
  return h || 'application/octet-stream';
}
