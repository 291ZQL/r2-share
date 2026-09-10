/**
 * store 模块离线单测（不依赖网络，可在 CI 跑）
 *
 * 用法：node scripts/test-store.mjs
 *
 * 覆盖两块最容易被后续改动破坏的逻辑：
 *   1. sanitizePath —— 路径穿越/控制字符/长度，以及「索引文件是保留 key」这条新护栏
 *   2. resolveType  —— MIME 归一：扩展名优先、hint 兜底
 */

import { sanitizePath, resolveType, guessType } from '../src/store.ts';

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

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
