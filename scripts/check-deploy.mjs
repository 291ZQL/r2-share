#!/usr/bin/env node
/**
 * 部署前自检：抓 wrangler.toml / .dev.vars / cors.json 里的常见配置坑。
 * 不替代 wrangler deploy 自身的校验，但能提前挡住下面这些 90% 会踩的失误：
 *   - 首页路由没显式交给 Worker（依赖「public/ 里没有 index.html」这个隐式前提）
 *   - R2 CORS AllowedOrigins 还有未替换的占位符
 *   - 管理口令 / 会话密钥是示例值
 *
 * 用法：npm run check
 * 退出码：0 通过；1 有必须先修的项
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let fail = 0;
const ok = (msg) => console.log('  \x1b[32m✓\x1b[0m ' + msg);
const warn = (msg) => console.log('  \x1b[33m⚠\x1b[0m ' + msg);
const err = (msg) => { console.log('  \x1b[31m✗\x1b[0m ' + msg); fail++; };
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

// 1. wrangler CLI 是否可用
section('1. wrangler CLI');
try {
  const v = execSync('npx wrangler --version', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim().split('\n').pop();
  ok('wrangler ' + v);
} catch {
  err('wrangler 不可用，请先 npm install');
  process.exit(1);
}

// 2. wrangler.toml
section('2. wrangler.toml');
const toml = await readFile('wrangler.toml', 'utf8');

const bucketMatch = toml.match(/bucket_name\s*=\s*"([^"]+)"/);
if (bucketMatch) ok('R2 bucket_name = ' + bucketMatch[1]);
else err('wrangler.toml 缺少 R2 bucket_name');

if (/DL_DOMAIN\s*=\s*"https?:\/\/[^"]+"/.test(toml)) {
  const dl = toml.match(/DL_DOMAIN\s*=\s*"([^"]+)"/)[1];
  ok('DL_DOMAIN = ' + dl);
} else {
  err('DL_DOMAIN 未设置或格式异常（应形如 https://dl.114448.xyz）');
}

// 首页必须显式走 Worker：否则请求会先找同名静态文件，一旦 public/ 出现 index.html，
// 首页就绕过了 Worker —— 登录态注入与 window.__CFG__ 会静默失效。
if (/run_worker_first\s*=\s*\[[^\]]*"\//.test(toml)) {
  ok('run_worker_first 已显式包含 "/"（首页不依赖隐式回落）');
} else {
  warn('run_worker_first 未显式包含 "/"：首页会先查静态文件，public/ 一旦出现 index.html 就会绕过 Worker');
}

// 上传上限与 Workers 请求体上限的关系：顶格设置会让「通过本站校验」的文件被 CF 拦下
const maxMatch = toml.match(/MAX_UPLOAD\s*=\s*"(\d+)"/);
if (maxMatch) {
  const max = parseInt(maxMatch[1], 10);
  if (max === 0) ok('MAX_UPLOAD = 0（沿用 Workers 请求体上限）');
  else if (max >= 100_000_000) warn(`MAX_UPLOAD = ${max} 顶到 CF 账户请求体上限，建议留余量（如 99614720）`);
  else ok(`MAX_UPLOAD = ${(max / 1048576).toFixed(1)} MiB（在上限之内，留有余量）`);
} else {
  warn('wrangler.toml 未显式设置 MAX_UPLOAD（默认沿用 Workers 请求体上限）');
}

// KV 已移除：登录失败计数改为 Worker 内存 Map，绑定了反而说明配置没跟上
if (/\[\[kv_namespaces\]\]/.test(toml)) {
  warn('wrangler.toml 仍保留 [[kv_namespaces]]，但代码已改用内存限流——可以删掉这个绑定');
}

// 3. .dev.vars（本地开发）
section('3. .dev.vars');
if (!existsSync('.dev.vars')) {
  warn('.dev.vars 不存在——本地开发会用 npm run dev 默认行为，生产部署不受影响');
} else {
  const dev = await readFile('.dev.vars', 'utf8');

  const pwMatch = dev.match(/^ADMIN_PASSWORD\s*=\s*(.+)$/m);
  if (!pwMatch) {
    err('ADMIN_PASSWORD 未设置');
  } else if (['change-me', 'dev123456', 'password', 'admin', ''].includes(pwMatch[1].trim())) {
    warn('ADMIN_PASSWORD 是已知示例/弱口令：' + pwMatch[1]);
  } else if (pwMatch[1].trim().length < 8) {
    warn('ADMIN_PASSWORD 长度 < 8，强度偏弱');
  } else {
    ok('ADMIN_PASSWORD 已设置');
  }

  const secMatch = dev.match(/^SESSION_SECRET\s*=\s*(.+)$/m);
  if (!secMatch) {
    err('SESSION_SECRET 未设置');
  } else if (['change-me', 'random-long-string-please-change', 'local-dev-secret-please-change', ''].includes(secMatch[1].trim())) {
    warn('SESSION_SECRET 是示例值，生产前请用 `openssl rand -hex 32` 重新生成');
  } else if (secMatch[1].trim().length < 32) {
    warn('SESSION_SECRET 长度 < 32，建议 32 字节以上随机串');
  } else {
    ok('SESSION_SECRET 已设置（长度 ' + secMatch[1].trim().length + '）');
  }

  // 生产 secrets 提醒
  const hasR2 = /^R2_ACCESS_KEY_ID\s*=/.test(dev) && /^R2_SECRET_ACCESS_KEY\s*=/.test(dev);
  if (hasR2) {
    ok('R2 S3 API 凭证已配置——本地 dev 会使用真实 R2（不再是回退模式）');
  } else {
    ok('R2 S3 API 凭证未配置——本地 dev 自动走回退模式（适合纯前端调试）');
  }
}

// 4. cors.json
section('4. cors.json');
let cors;
try {
  cors = JSON.parse(await readFile('cors.json', 'utf8'));
} catch (e) {
  err('cors.json 不是合法 JSON：' + e.message);
}

if (cors) {
  // 支持 R2 API 嵌套格式：{ "rules": [{ "allowed": { "origins": [...], "methods": [...] } }] }
  const rule = Array.isArray(cors) ? cors[0] : cors.rules?.[0];
  const origins = rule?.allowed?.origins;
  const methods = rule?.allowed?.methods ?? rule?.AllowedMethods;
  if (!Array.isArray(origins)) {
    err('cors.json 结构异常：缺少 rules[].allowed.origins 数组（R2 API 格式见 https://developers.cloudflare.com/r2/buckets/cors/）');
  } else {
    const placeholders = origins.filter((o) => /<[^>]+>|TODO|FIXME|pan\.114448/.test(o));
    if (placeholders.length) {
      err('cors.json 仍有未替换的占位符 origin：' + placeholders.join(', ') + '\n     流程：首次 wrangler deploy → 拿到 Worker 实际 URL → 替换 cors.json → wrangler r2 bucket cors set r2share --file cors.json');
    } else if (origins.length === 0) {
      err('cors.json allowed.origins 为空，浏览器无法上传');
    } else if (origins.includes('*')) {
      warn('allowed.origins 含 *，浏览器仍能 PUT 但推荐生产时改成具体域名');
    } else {
      ok('allowed.origins 已就绪：' + origins.join(', '));
    }

    if (!methods?.includes('PUT')) {
      err('allowed.methods 缺少 PUT，浏览器直传会被拒');
    } else {
      ok('allowed.methods 含 PUT/GET/HEAD');
    }
  }
}

// 5. 收尾
section(fail === 0 ? '\x1b[32m✅ 全部通过，可以部署\x1b[0m' : '\x1b[31m❌ 有 ' + fail + ' 项必须先修\x1b[0m');
if (fail > 0) {
  console.log('\n提示：上面所有 ✗ 项都是阻断性的，先修完再 wrangler deploy');
}
process.exit(fail > 0 ? 1 : 0);
