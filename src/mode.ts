/**
 * 运行模式判定 + 会话密钥派生
 *
 * 为什么单独放一个文件：这两件事都是「下载不经过 Worker」这条零成本前提的判据，
 * 原先埋在 Worker 入口 index.ts 里，而入口带副作用（`new Hono()` / `app.onError()`），
 * 测试脚本导不进来——结果架构上最关键的判定反而零测试覆盖。
 * 抽出来后 scripts/test-mode.mjs 能直接 import 本文件做离线单测。
 *
 * 本文件刻意不 import 任何东西：保持零依赖、可被 Node 直接加载。
 */

/** 本文件用到的环境变量子集（结构上兼容 index.ts 的 Env；全部可选以便测试构造） */
export interface ModeEnv {
  /** R2 公开桶下载直链域，如 https://dl.example.com */
  DL_DOMAIN?: string;
  /** '1' 强制代理模式 / '0' 强制生产模式；不设则由 DL_DOMAIN 是否合法推断 */
  LOCAL_MODE?: string;
  /** '1' 时生产环境上传改走 Worker 中转（绕开被墙的 r2.cloudflarestorage.com 直传） */
  UPLOAD_VIA_WORKER?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

/**
 * 是否为「代理模式」：下载 / 索引改走本 Worker（`/api/local-get`、`/api/local-index`），
 * 而不是 R2 公开桶直链。
 *
 * 判据不看 R2 S3 凭证是否存在。原因：上传默认走 Worker 中转（UPLOAD_VIA_WORKER=1），
 * 根本不碰 S3 凭证；若仍拿「凭证齐不齐」当判据，用户为省事不填凭证，生产站点就会被
 * 整体判成代理模式——下载全部改走 Worker，每次下载白烧一个请求，
 * 「下载不经过 Worker」这个月成本 $0 的前提直接失效。
 *
 * 优先级：LOCAL_MODE 显式开关 > DL_DOMAIN 是否为合法 URL。
 * 用「合法 URL」而非「非空」是有意的：本地 dev 直接跑模板时 DL_DOMAIN 是
 * `__DL_DOMAIN__` 占位符，非空但不是 URL，应当仍按代理模式处理。
 */
export function isProxyMode(env: ModeEnv): boolean {
  if (env.LOCAL_MODE === '1') return true;
  if (env.LOCAL_MODE === '0') return false;
  return !/^https?:\/\/[^/\s]+/i.test(String(env.DL_DOMAIN || ''));
}

/**
 * 上传是否走 Worker 代理（浏览器 PUT 打同源 `/api/local-put`，Worker 内部写 R2）：
 * - 代理模式（isProxyMode，例如没配 DL_DOMAIN 的 dev 环境），或
 * - 生产显式设置 UPLOAD_VIA_WORKER='1'
 *
 * 与 isProxyMode 的区别：此标记只决定「上传」通道，下载仍可走公开桶直链。
 * 该模式下不需要任何 R2 S3 凭证——这也是三个 R2 凭证被列为选填的原因。
 */
export function isUploadProxy(env: ModeEnv): boolean {
  return isProxyMode(env) || env.UPLOAD_VIA_WORKER === '1';
}

/**
 * 是否具备可用的会话密钥来源。
 * 两者都没配时，sessionSecretOf 会返回一个「对所有人都相同」的固定摘要，
 * 不能当有效密钥——调用方（isLogin）必须先过这道守卫。
 */
export function hasSessionKey(env: ModeEnv): boolean {
  return !!(env.SESSION_SECRET || env.ADMIN_PASSWORD);
}

/**
 * 会话签名密钥。
 * 优先用显式配置的 SESSION_SECRET；未配置时从 ADMIN_PASSWORD 确定性派生——
 * 派生结果跨 isolate / 重启 / 重新部署都一致，无状态 cookie 照常有效。
 *
 * 代价（两处，配一个 SESSION_SECRET 即可完全规避）：
 *   1. 改口令会让所有旧会话立即失效（符合直觉）；
 *   2. 会话密钥与口令绑定后，任何拿到一个有效 cookie 的人都能离线枚举口令——
 *      cookie 的 payload 就是 base64 的 {"exp":…}，签名 = HMAC(key, payload)，
 *      两边都已知，只剩口令是未知量。口令较弱时请务必配 SESSION_SECRET。
 *
 * 注意：口令为空时返回的是固定摘要，调用前请先确认 hasSessionKey(env) 为真。
 */
export async function sessionSecretOf(env: ModeEnv): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const data = new TextEncoder().encode(
    'r2share/session-key/v1:' + (env.ADMIN_PASSWORD || '')
  );
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
