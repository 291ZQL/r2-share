/**
 * store 模块离线单测（不依赖网络，可在 CI 跑）
 *
 * 用法：node scripts/test-store.mjs
 *
 * 覆盖三块最容易被后续改动破坏的逻辑：
 *   1. sanitizePath —— 路径穿越/控制字符/长度，以及「索引文件是保留 key」这条护栏
 *   2. resolveType  —— MIME 归一：扩展名优先、hint 兜底
 *   3. 索引写入     —— 条件写（CAS）与批量：冲突重试、失败不静默、批量一次成型
 */

import fs from 'node:fs';
import {
  sanitizePath,
  resolveType,
  guessType,
  upsertFiles,
  upsertFile,
  removeFiles,
  removeFile,
  removeDir,
  readIndex,
  IndexConflictError,
} from '../src/store.ts';

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      期望 ${e} / 实际 ${a}`);
  }
}
const group = (t) => console.log(`\n[${t}]`);

/* ============ sanitizePath：合法输入 ============ */
group('sanitizePath 合法路径');
eq('普通文件', sanitizePath('a.txt'), 'a.txt');
eq('多级目录', sanitizePath('文档/报告.pdf'), '文档/报告.pdf');
eq('反斜杠归一为正斜杠', sanitizePath('a\\b\\c.txt'), 'a/b/c.txt');
eq('去掉尾部斜杠', sanitizePath('docs/'), 'docs');
eq('首尾空格 trim', sanitizePath('  a.txt  '), 'a.txt');
eq('单段 255 字符（边界内）', sanitizePath('x'.repeat(255)).length, 255);

/* ============ sanitizePath：非法输入 ============ */
group('sanitizePath 拒绝非法路径');
eq('非字符串 null', sanitizePath(null), null);
eq('非字符串 number', sanitizePath(42), null);
eq('空串', sanitizePath(''), null);
eq('纯空格', sanitizePath('   '), null);
eq('POSIX 绝对路径', sanitizePath('/etc/passwd'), null);
eq('Windows 绝对路径', sanitizePath('\\windows\\sys'), null);
eq('父目录穿越', sanitizePath('../secret'), null);
eq('中间穿越', sanitizePath('a/../b'), null);
eq('当前目录段', sanitizePath('a/./b'), null);
eq('连续斜杠（空段）', sanitizePath('a//b'), null);
eq('NUL 控制字符', sanitizePath('a\u0000b'), null);
eq('换行控制字符', sanitizePath('a\nb'), null);
eq('单段 256 字符（越界）', sanitizePath('x'.repeat(256)), null);
eq('总长超 900 字节', sanitizePath('a/'.repeat(500) + 'x'), null);

/* ============ sanitizePath：保留 key 护栏 ============
 * files.json 是索引自身，若允许被用户上传/删除，一次误传同名文件就会冲掉整站目录。
 */
group('sanitizePath 保留 key 保护');
eq('顶层 files.json 被拒', sanitizePath('files.json'), null);
eq('带空格仍被拒', sanitizePath('  files.json  '), null);
eq('反斜杠形式仍被拒', sanitizePath('files.json'), null);
eq('子目录里的同名文件允许', sanitizePath('docs/files.json'), 'docs/files.json');
eq('前缀相似的文件允许', sanitizePath('files.json.bak'), 'files.json.bak');
eq('大小写不同视为不同 key（R2 区分大小写）', sanitizePath('Files.json'), 'Files.json');

/* ============ resolveType：MIME 归一 ============ */
group('resolveType 扩展名优先');
eq('7z（浏览器给不出 MIME）', resolveType('a.7z'), 'application/x-7z-compressed');
eq('dmg', resolveType('a.dmg'), 'application/x-apple-diskimage');
eq('apk', resolveType('a.apk'), 'application/vnd.android.package-archive');
eq('exe', resolveType('a.exe'), 'application/vnd.microsoft.portable-executable');
eq('epub', resolveType('a.epub'), 'application/epub+zip');
eq('txt 带 charset', resolveType('a.txt'), 'text/plain; charset=utf-8');
eq('扩展名优先于 hint（png 声称 text/plain）', resolveType('a.png', 'text/plain'), 'image/png');
eq('大写扩展名同样识别', resolveType('A.PDF'), 'application/pdf');

group('resolveType hint 兜底');
eq('无扩展名 + hint', resolveType('noext', 'text/plain'), 'text/plain');
eq('无扩展名 + 无 hint', resolveType('noext'), 'application/octet-stream');
eq('hint 首尾空格被清理', resolveType('noext', '  text/plain  '), 'text/plain');
eq('hint 为空串等同无 hint', resolveType('noext', ''), 'application/octet-stream');
eq('hint 只有空格等同无 hint', resolveType('noext', '   '), 'application/octet-stream');
eq('未知扩展名 + hint', resolveType('a.unknown', 'image/x-foo'), 'image/x-foo');
eq('未知扩展名 + 无 hint', resolveType('a.unknown'), 'application/octet-stream');
eq('hint 传 undefined', resolveType('a.unknown', undefined), 'application/octet-stream');
eq('目录占位对象', resolveType('docs/'), 'application/octet-stream');

/* ============ guessType 基础回归 ============ */
group('guessType 基础');
eq('png', guessType('x.png'), 'image/png');
eq('jpeg 与 jpg 同值', guessType('x.jpeg'), guessType('x.jpg'));
eq('未知扩展名', guessType('x.zzz'), 'application/octet-stream');
eq('无扩展名', guessType('Makefile'), 'application/octet-stream');
eq('路径带目录也能取扩展名', guessType('a/b/c.pdf'), 'application/pdf');

/* ============ 补表后的常见类型 ============
 * 这些扩展名浏览器给不出可靠 MIME（空串或 octet-stream），必须由扩展名表负责。
 */
group('resolveType 补全的常见类型');
eq('js', resolveType('app.js'), 'text/javascript; charset=utf-8');
eq('mjs', resolveType('a.mjs'), 'text/javascript; charset=utf-8');
eq('ts', resolveType('a.ts'), 'text/typescript; charset=utf-8');
eq('css', resolveType('style.css'), 'text/css; charset=utf-8');
eq('html', resolveType('index.html'), 'text/html; charset=utf-8');
eq('py', resolveType('a.py'), 'text/x-python; charset=utf-8');
eq('sh', resolveType('a.sh'), 'text/x-shellscript; charset=utf-8');
eq('yaml', resolveType('a.yml'), 'text/yaml; charset=utf-8');
eq('toml', resolveType('a.toml'), 'text/plain; charset=utf-8');
eq('xml', resolveType('a.xml'), 'text/xml; charset=utf-8');
eq('docx', resolveType('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
eq('xlsx', resolveType('a.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
eq('pptx', resolveType('a.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
eq('doc', resolveType('a.doc'), 'application/msword');
eq('rar', resolveType('a.rar'), 'application/vnd.rar');
eq('tgz', resolveType('a.tgz'), 'application/gzip');
eq('xz', resolveType('a.xz'), 'application/x-xz');
eq('bz2', resolveType('a.bz2'), 'application/x-bzip2');
eq('mkv', resolveType('a.mkv'), 'video/x-matroska');
eq('mov', resolveType('a.mov'), 'video/quicktime');
eq('aac', resolveType('a.aac'), 'audio/aac');
eq('m4a', resolveType('a.m4a'), 'audio/mp4');
eq('bmp', resolveType('a.bmp'), 'image/bmp');
eq('ico', resolveType('a.ico'), 'image/x-icon');
eq('mobi', resolveType('a.mobi'), 'application/x-mobipocket-ebook');

/* ============ 前后端类型表对齐（防再次漂移）============
 * 前端 app.js 用来判断「能不能预览 / 显示什么图标」的扩展名，
 * 服务端必须都能给出真实 MIME —— 否则 resolveType 只能退回浏览器 hint，
 * 而 rebuildIndex 完全没有 hint，索引里的 c 会一律退化成 octet-stream。
 * 这条断言把「两张表必须对齐」钉成可回归的约束。
 */
group('前端识别表 ⊆ 服务端 MIME 表');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const frontExts = new Set();
for (const re of [
  /const EXT_KIND = \{([\s\S]*?)\n\};/,
  /const TEXT_EXT = new Set\(\[([\s\S]*?)\]\);/,
  /const OFFICE_EXT = new Set\(\[([\s\S]*?)\]\);/,
]) {
  const block = appJs.match(re);
  if (!block) {
    console.error(`✗ 无法从 app.js 提取类型表，正则失配：${re}`);
    process.exit(1);
  }
  for (const m of block[1].matchAll(/'([\w]+)'/g)) frontExts.add(m[1].toLowerCase());
}
eq('前端扩展名数量合理（>80）', frontExts.size > 80, true);
const uncovered = [...frontExts]
  .filter((e) => guessType('x.' + e) === 'application/octet-stream')
  .sort();
eq('前端识别的扩展名服务端全部覆盖', uncovered, []);

/* ==================================================================
 * 索引写入：条件写（CAS）与批量
 *
 * 为什么必须有这组用例：模块级 promise 锁只能串行化同一个 isolate 内的请求，
 * 而 Cloudflare 会创建多个 isolate，多端同时改索引时两边各自「读 → 改 → 写」，
 * 后写的会把先写的盖掉（索引丢条目、文件在桶里却看不见）。
 * 修法是让提交带上 etag 条件，被别人改过就失败重试。
 *
 * 下面这个替身会**真的校验 onlyIf**：如果哪天条件写被去掉（退回无条件 put），
 * 「提交必须带 etag 条件」「持续冲突要抛错」这两条会立刻翻红。
 * ================================================================== */

class FakeBucket {
  constructor() {
    this.map = new Map(); // key -> { body, etag }
    this.seq = 0;
    /** 置为正数时，接下来 N 次 put 强制返回 null（模拟别的 isolate 抢先提交） */
    this.forceConflict = 0;
    /** 记录每次 put 的 onlyIf，供断言检查条件写是否接上了 */
    this.putLog = [];
  }
  _etag() {
    return 'etag-' + ++this.seq;
  }
  async get(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return {
      etag: o.etag,
      json: async () => JSON.parse(o.body),
      text: async () => o.body,
    };
  }
  async put(key, body, opts) {
    const text = typeof body === 'string' ? body : String(body);
    this.putLog.push(opts && opts.onlyIf);
    const cur = this.map.get(key);
    if (this.forceConflict > 0) {
      this.forceConflict--;
      // 模拟「提交瞬间别人抢先写了」：内容与 etag 都被动过 → 本次条件写失败
      this.map.set(key, { body: cur ? cur.body : '{"updated":0,"files":[]}', etag: this._etag() });
      return null;
    }
    const cond = opts && opts.onlyIf;
    if (cond) {
      if (cond.etagMatches !== undefined && (!cur || cur.etag !== cond.etagMatches)) return null;
      if (cond.etagDoesNotMatch === '*' && cur) return null;
    }
    const etag = this._etag();
    this.map.set(key, { body: text, etag });
    return { key, size: text.length, etag };
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k);
  }
  async list(opts = {}) {
    const prefix = opts.prefix || '';
    const objects = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((k) => ({ key: k, size: this.map.get(k).body.length, uploaded: new Date(0) }));
    return { objects, truncated: false, delimitedPrefixes: [] };
  }
}

const ent = (p, s = 1) => ({ p, s, t: 1, c: 'text/plain' });

group('索引写入 —— 条件写（CAS）');
{
  const b = new FakeBucket();
  await upsertFiles(b, [ent('first.txt')]);
  eq('首次创建索引用 etagDoesNotMatch:"*"', b.putLog[0] && b.putLog[0].etagDoesNotMatch, '*');

  await upsertFiles(b, [ent('second.txt')]);
  const cond = b.putLog[1];
  eq('索引已存在时提交必须带 etagMatches 条件', !!(cond && cond.etagMatches), true);
  eq('条件用的是读取时拿到的 etag', b.putLog[1].etagMatches, 'etag-1');
}

group('索引写入 —— 冲突重试');
{
  const b = new FakeBucket();
  await upsertFiles(b, [ent('a.txt')]);
  // 前两次提交都被「别人」抢先，第三次才成功
  b.forceConflict = 2;
  await upsertFiles(b, [ent('b.txt')]);
  const idx = await readIndex(b);
  eq('条件写失败后重试，改动没有丢', idx.files.some((f) => f.p === 'b.txt'), true);
  eq('原有条目没被覆盖', idx.files.some((f) => f.p === 'a.txt'), true);
  eq('重试期间没有产生重复条目', idx.files.length, 2);

  // 一直冲突 → 必须抛错，而不是静默把改动丢掉。
  // 且必须是 IndexConflictError：src/index.ts 的 onError 靠这个类型把「并发冲突」
  // 映射成 409（可重试），与真正的服务端故障（500）区分开。
  const b2 = new FakeBucket();
  await upsertFiles(b2, [ent('x.txt')]);
  b2.forceConflict = 99;
  let err = null;
  try {
    await upsertFiles(b2, [ent('y.txt')]);
  } catch (e) {
    err = e;
  }
  eq('持续冲突时抛错而不是静默丢改动', err !== null, true);
  eq('抛的是 IndexConflictError（供上层映射 409）', err instanceof IndexConflictError, true);

  // 源码契约：Worker 层必须把这个类型映射成 409 而不是 500，否则前端只能看到
  // 语焉不详的 500，不知道「重试一下就好」。
  const idxSrc = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  eq('index.ts 注册了 onError', /app\.onError\(/.test(idxSrc), true);
  eq('onError 用 instanceof IndexConflictError 判定', /err instanceof IndexConflictError/.test(idxSrc), true);
  eq('冲突被映射成 409（而非 500）', /IndexConflictError[\s\S]{0,160}?409/.test(idxSrc), true);
}

group('索引写入 —— 批量与幂等');
{
  const b = new FakeBucket();
  await upsertFiles(b, [ent('1.txt'), ent('2.txt'), ent('3.txt')]);
  eq('批量 upsert 一次写入多条', (await readIndex(b)).files.length, 3);

  // 同路径重复提交应当替换而不是追加
  await upsertFiles(b, [ent('2.txt', 999), ent('2.txt', 999)]);
  const idx = await readIndex(b);
  eq('同路径重复提交不产生重复条目', idx.files.length, 3);
  eq('同路径提交是替换语义', idx.files.find((f) => f.p === '2.txt').s, 999);

  eq('批量删除返回实际删除条数', await removeFiles(b, ['1.txt', '2.txt']), 2);
  eq('批量删除后剩余条数正确', (await readIndex(b)).files.length, 1);
  eq('删除不存在的路径返回 0', await removeFiles(b, ['nope.txt']), 0);
  eq('单条删除命中时返回 true', await removeFile(b, '3.txt'), true);
  eq('单条删除未命中时返回 false', await removeFile(b, '3.txt'), false);
  await upsertFile(b, ent('4.txt'));
  eq('旧入口 upsertFile 仍可用', (await readIndex(b)).files.length, 1);
}

group('索引写入 —— 递归删目录');
{
  const b = new FakeBucket();
  // 桶里的对象：目录占位（key 以 / 结尾）+ 真实文件 + 子目录占位
  await b.put('d/', '', {});
  await b.put('d/a.txt', 'aa', {});
  await b.put('d/sub/', '', {});
  await b.put('d/sub/b.txt', 'bb', {});
  await b.put('other.txt', 'oo', {});
  await upsertFiles(b, [
    ent('d/'),
    ent('d/a.txt'),
    ent('d/sub/'),
    ent('d/sub/b.txt'),
    ent('other.txt'),
  ]);

  const removed = await removeDir(b, 'd');
  // 目录占位对象（含嵌套子目录的）不能计入「已删除 N 个文件」
  eq('只把真实文件计入删除数', removed, 2);
  eq('对象已从桶里删掉', b.map.has('d/a.txt'), false);
  eq('嵌套子目录的对象也删掉了', b.map.has('d/sub/b.txt'), false);
  eq('目录外的文件不受影响', b.map.has('other.txt'), true);
  eq('索引里只剩目录外的条目', (await readIndex(b)).files.map((f) => f.p), ['other.txt']);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
