/**
 * files.json 索引读写 + 路径安全校验
 *
 * 设计要点：
 * 1. 索引本身也存在 R2 里（公开可读），前端直接 fetch 渲染，目录页因此零 Worker 消耗
 * 2. 更新走增量（读 → 改 → 写），不做全量重建，避免超出免费版 10ms CPU 限制
 * 3. 所有路径必须过 sanitizePath，挡住 ../ 穿越与控制字符
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

/**
 * 索引更新的互斥锁：upsertFile / removeFile 都是「读 → 改 → 写」三步，
 * 并发请求会读到同一份旧索引、互相覆盖（丢更新）。用模块级 promise 链
 * 把索引写操作串行化。零依赖，Workers 单 isolate 内天然有效。
 */
let indexLock: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.catch(() => {});
  return run;
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

/** 读取索引；不存在或损坏时返回空索引 */
export async function readIndex(bucket: R2Bucket): Promise<FileIndex> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) return { updated: 0, files: [] };
  try {
    const data = (await obj.json()) as FileIndex;
    if (!data || !Array.isArray(data.files)) {
      return { updated: 0, files: [] };
    }
    return data;
  } catch {
    return { updated: 0, files: [] };
  }
}

export async function writeIndex(
  bucket: R2Bucket,
  index: FileIndex
): Promise<void> {
  index.updated = Date.now();
  await bucket.put(INDEX_KEY, JSON.stringify(index), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      // 索引会被频繁读取，缓存 10 秒保证上传后能较快看到新文件
      cacheControl: 'public, max-age=10',
    },
  });
}

/** 新增或更新一条记录（增量，不重建整个索引） */
export async function upsertFile(
  bucket: R2Bucket,
  entry: FileEntry
): Promise<void> {
  await withIndexLock(async () => {
    const index = await readIndex(bucket);
    const i = index.files.findIndex((f) => f.p === entry.p);
    if (i >= 0) index.files[i] = entry;
    else index.files.push(entry);
    await writeIndex(bucket, index);
  });
}

/** 删除一条记录 */
export async function removeFile(
  bucket: R2Bucket,
  path: string
): Promise<boolean> {
  return withIndexLock(async () => {
    const index = await readIndex(bucket);
    const next = index.files.filter((f) => f.p !== path);
    if (next.length === index.files.length) return false;
    index.files = next;
    await writeIndex(bucket, index);
    return true;
  });
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
  return withIndexLock(async () => {
    const prefix = path + '/';
    let cursor: string | undefined;
    let n = 0;
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
      cursor = page.truncated
        ? (page as unknown as { cursor?: string }).cursor
        : undefined;
    } while (cursor);

    // 占位对象（新建目录时创建的 <dir>/ 0 字节对象）已随上面的循环一并删除：
    // list({prefix}) 是前缀匹配，key 恰好等于 prefix 的对象也在返回结果里
    // （计数处的 filter(k => k !== prefix) 正是把它排除掉），无需再删一次。

    const index = await readIndex(bucket);
    const next = index.files.filter(
      (f) => f.p !== prefix && !f.p.startsWith(prefix)
    );
    if (next.length !== index.files.length) {
      index.files = next;
      await writeIndex(bucket, index);
    }
    return n;
  });
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
  // 与 upsert/remove 共用同一把锁：否则「重建期间恰好有上传提交」会互相覆盖，
  // 刚写入的新文件条目会被重建结果冲掉。多 isolate 下仍无解（已知限制）。
  return withIndexLock(async () => {
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
      cursor = page.truncated
        ? (page as unknown as { cursor?: string }).cursor
        : undefined;
    } while (cursor);
    await writeIndex(bucket, { updated: 0, files });
    return { files: files.length };
  });
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
