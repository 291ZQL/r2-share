/**
 * 前端状态逻辑单测（不依赖浏览器）
 *
 * 用法：node scripts/test-frontend.mjs
 *
 * 做法与 test-preview.mjs 一致：读 public/app.js 原文，截掉末尾需要真实 DOM
 * 的启动代码，在 Node 里求值，再喂一个最小 DOM 替身来驱动状态逻辑。
 *
 * 覆盖三类：
 *   1. 行为 —— resetSel / applyIndexEntries / dropIndexPaths / kindOf
 *   2. 契约 —— 关键链路的调用方式（防回归：改回旧写法会翻红）
 *   3. 路由 —— wrangler.toml 的首页必须显式走 Worker
 *
 * 第 2 类是「源码契约」而非行为测试：它拦的是「有人不小心把修复改回去」，
 * 不保证这些代码在浏览器里真的跑得对（那部分靠人工与冒烟覆盖）。
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// 末尾的 bindEvents()/loadIndex() 需要真实 DOM，截断即可
const body = src.replace(/^bindEvents\(\);[\s\S]*$/m, '');

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

/* ---------------- 最小 DOM 替身 ---------------- */

function makeEl() {
  const cls = new Set();
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    style: {},
    children: [],
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !cls.has(c) : !!on;
        if (want) cls.add(c);
        else cls.delete(c);
        return want;
      },
    },
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/** getElementById 对任意 id 都返回一个元素：render() 会摸到很多节点 */
function makeDocument() {
  const els = new Map();
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl());
      return els.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body: makeEl(),
  };
}

/** 每个用例加载一份全新的模块实例，互不串状态 */
function load() {
  const fn = new Function(
    'window',
    'document',
    `${body}
return { state, resetSel, applyIndexEntries, dropIndexPaths, kindOf, updateBatch };`
  );
  return fn(
    { __CFG__: { dlDomain: 'https://dl.example.com', isLogin: true } },
    makeDocument()
  );
}

const entry = (p, s = 1) => ({ p, s, t: 1, c: 'text/plain' });

/* ---------------- 行为 ---------------- */

group('批量选择：切换视图时必须清空');
{
  const api = load();
  api.state.sel.add('a.txt');
  api.state.sel.add('b.txt');
  eq('选择集先有 2 项', api.state.sel.size, 2);
  api.resetSel();
  eq('resetSel 清空已选集合', api.state.sel.size, 0);
  api.resetSel();
  eq('选择集为空时调用是安全的', api.state.sel.size, 0);
}

group('本地索引：增量追加与替换');
{
  const api = load();
  api.state.index = [entry('a.txt'), entry('d/'), entry('d/x.txt')];
  api.applyIndexEntries([entry('b.txt')]);
  eq('新路径追加进索引', api.state.index.length, 4);
  api.applyIndexEntries([{ p: 'a.txt', s: 99, t: 9, c: 'text/plain' }]);
  eq('同路径是替换不是追加', api.state.index.length, 4);
  eq('替换后的值生效', api.state.index.find((f) => f.p === 'a.txt').s, 99);
  api.applyIndexEntries([null, { x: 1 }, 'junk', 42]);
  eq('脏数据被忽略而不是写坏索引', api.state.index.length, 4);
  api.applyIndexEntries([]);
  eq('空数组是安全的', api.state.index.length, 4);
}

group('本地索引：删除时按路径与前缀移除');
{
  const api = load();
  api.state.index = [entry('a.txt'), entry('d/'), entry('d/x.txt'), entry('d/sub/y.txt'), entry('e.txt')];
  api.dropIndexPaths(['a.txt']);
  eq('删除文件只移除该条', api.state.index.some((f) => f.p === 'a.txt'), false);
  eq('其他条目不受影响', api.state.index.length, 4);
  api.dropIndexPaths(['d']);
  eq('删除目录按前缀一并清空', api.state.index.length, 1);
  eq('保留目录外的条目', api.state.index[0].p, 'e.txt');
  api.dropIndexPaths([]);
  eq('空路径数组是安全的', api.state.index.length, 1);
}

group('kindOf：走查表后行为不变');
{
  const api = load();
  eq('图片', api.kindOf('a.png', false), 'image');
  eq('压缩包', api.kindOf('a.zip', false), 'zip');
  eq('目录优先于扩展名', api.kindOf('a.png', true), 'dir');
  eq('大写扩展名同样识别', api.kindOf('A.PNG', false), 'image');
  eq('带目录的名字取最后一段扩展名', api.kindOf('a.b/c.zip', false), 'zip');
  eq('无扩展名回退为 file', api.kindOf('Makefile', false), 'file');
  eq('未收录的扩展名回退为 file', api.kindOf('a.zzz', false), 'file');
}

/* ---------------- 源码契约（防回归） ---------------- */

group('源码契约：关键链路的调用方式');
const has = (re) => re.test(src);
const fnBody = (name) => (src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`)) || [''])[0];

eq('点目录时重置批量选择', has(/state\.cur = dirEl\.dataset\.dir;\s*\r?\n\s*resetSel\(\);/), true);
eq('面包屑切目录时重置批量选择', has(/state\.cur = a\.dataset\.p;\s*\r?\n\s*resetSel\(\);/), true);
eq('切换搜索时重置批量选择', has(/state\.searchMode = !!v;\s*\r?\n\s*resetSel\(\);/), true);
eq('上传批次内固定目标目录（快照 baseDir）', has(/const baseDir = state\.cur;/), true);
eq('批量下载不再用 window.open（会被弹窗拦截）', fnBody('batchDownload').replace(/\/\/[^\n]*/g, '').includes('window.open'), false);
eq('批量下载改触发 <a download>', fnBody('batchDownload').includes('a.download'), true);
eq('网格缩略图受 THUMB_MAX 约束', has(/kind === 'image' && \(f\.s \|\| 0\) <= THUMB_MAX/), true);
eq('上传走批量签名', has(/entries: jobs\.map\(/), true);
eq('上传走批量提交索引', has(/entries: done\.map\(/), true);
eq('上传后不再整份重拉索引', fnBody('runBatchUpload').includes('loadIndex'), false);
eq('批量删除走一次 /api/files', has(/fetch\('\/api\/files'/), true);
eq('单个删除改为本地增量', fnBody('deleteOne').includes('dropIndexPaths'), true);
eq('未登录仍不渲染选择框', has(/CFG\.isLogin\s*\?[\s\S]{0,80}class="sel"/), true);

group('部署配置：首页必须显式走 Worker');
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
eq(
  'run_worker_first 显式包含 "/"',
  /run_worker_first\s*=\s*\[[^\]]*"\/"/.test(toml),
  true
);
eq('wrangler.toml 不再绑定 KV', /\[\[kv_namespaces\]\]/.test(toml), false);

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
