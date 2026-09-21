/**
 * 运行模式判定 + 会话密钥派生 离线单测（不依赖网络，可在 CI 跑）
 *
 * 用法：node scripts/test-mode.mjs
 *
 * 为什么单独给这两件事写测试：它们是「下载不经过 Worker」这条零成本前提的判据。
 * 判错一个分支，生产站点可能每次下载都白烧一个 Worker 请求（免费额度 10 万/天），
 * 或者反过来——本该直连公开桶的下载全部挤回 Worker。原先这两个函数埋在 Worker
 * 入口 index.ts 里（入口有 new Hono() 等副作用，测试导不进来），只能靠人工看，
 * 现在抽到 src/mode.ts 才测得动。
 *
 * 覆盖三块：
 *   1. isProxyMode    —— LOCAL_MODE 的优先级 + DL_DOMAIN 的各种形态
 *   2. isUploadProxy  —— 上传通道判定（与下载通道解耦）
 *   3. sessionSecretOf / hasSessionKey —— 密钥派生与「无密钥来源」守卫
 */

import { createHash } from 'node:crypto';
import {
  isProxyMode,
  isUploadProxy,
  hasSessionKey,
  sessionSecretOf,
} from '../src/mode.ts';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}

/* ============ 1. 运行模式 ============ */
console.log('\n[运行模式：isProxyMode]');

// 显式开关优先：这是排障/特殊部署的逃生门，必须压过自动推断
ok(
  "LOCAL_MODE='1' 强制代理模式（即使 DL_DOMAIN 已配好）",
  isProxyMode({ LOCAL_MODE: '1', DL_DOMAIN: 'https://dl.example.com' }) === true
);
ok(
  "LOCAL_MODE='0' 强制生产模式（即使 DL_DOMAIN 还是占位符）",
  isProxyMode({ LOCAL_MODE: '0', DL_DOMAIN: '__DL_DOMAIN__' }) === false
);
ok(
  'LOCAL_MODE 只认字符串 "1"/"0"，其他值回落到自动推断',
  isProxyMode({ LOCAL_MODE: 'true', DL_DOMAIN: 'https://dl.example.com' }) === false
);

// 自动推断：DL_DOMAIN 是不是「合法 URL」——用合法 URL 而非非空，是有意为之
const DL_CASES = [
  ['https://dl.example.com', false, '自定义下载域'],
  ['http://dl.example.com', false, 'http 同样算合法直链'],
  ['https://pub-abc123.r2.dev', false, 'r2.dev 域名'],
  ['https://dl.example.com/files', false, '带路径的 URL'],
  ['__DL_DOMAIN__', true, '模板占位符（本地 dev 直接跑模板）'],
  ['', true, '空串（未配置）'],
  [undefined, true, '未设置'],
  ['dl.example.com', true, '只有主机名（gen-config 前的 .dev.vars 形态）'],
  ['ftp://dl.example.com', true, '非 http(s) 协议'],
  ['https://', true, '没有主机名'],
  ['  https://dl.example.com', true, '带前导空白（起点不合法 → 保守回落代理模式）'],
];
{
  let bad = 0;
  for (const [dl, want, desc] of DL_CASES) {
    const got = isProxyMode({ DL_DOMAIN: dl });
    if (got !== want) {
      bad++;
      console.log(
        `    ✗ ${desc}: DL_DOMAIN=${JSON.stringify(dl)} 期望代理模式=${want} 实际=${got}`
      );
    }
  }
  ok(`DL_DOMAIN 形态判定 ${DL_CASES.length} 组全部符合预期`, bad === 0);
}

// 核心不变量：判据只认「公开桶下载域」，与 R2 S3 凭证无关。
// 这条如果被改回去（拿凭证当判据），不填凭证的用户会让生产站点整体退化成代理模式。
ok(
  '配好 DL_DOMAIN 且完全不配 R2 凭证 → 仍是生产模式（下载走公开桶直链）',
  isProxyMode({ DL_DOMAIN: 'https://dl.example.com' }) === false
);
ok(
  '凭证齐全但没配公开桶下载域 → 代理模式（不拼出坏直链）',
  isProxyMode({
    DL_DOMAIN: '',
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    R2_ACCOUNT_ID: 'acc',
  }) === true
);

/* ============ 2. 上传通道 ============ */
console.log('\n[上传通道：isUploadProxy]');

ok(
  "生产 + UPLOAD_VIA_WORKER='1' → 上传走 Worker 中转",
  isUploadProxy({ DL_DOMAIN: 'https://dl.example.com', UPLOAD_VIA_WORKER: '1' }) === true
);
ok(
  "生产 + UPLOAD_VIA_WORKER='0' → 上传走 presigned 直传",
  isUploadProxy({ DL_DOMAIN: 'https://dl.example.com', UPLOAD_VIA_WORKER: '0' }) === false
);
ok(
  '生产 + 未设置 UPLOAD_VIA_WORKER → 走直传（代理开关是显式的）',
  isUploadProxy({ DL_DOMAIN: 'https://dl.example.com' }) === false
);
ok('代理模式（没配公开桶下载域）→ 上传必然走 Worker 中转', isUploadProxy({}) === true);
ok(
  "LOCAL_MODE='0' 但 UPLOAD_VIA_WORKER='1' → 仍是 Worker 中转",
  isUploadProxy({ LOCAL_MODE: '0', DL_DOMAIN: 'https://dl.example.com', UPLOAD_VIA_WORKER: '1' }) === true
);
ok(
  "只认字面量 '1'：UPLOAD_VIA_WORKER='true' 不生效",
  isUploadProxy({ DL_DOMAIN: 'https://dl.example.com', UPLOAD_VIA_WORKER: 'true' }) === false
);
// 两个通道相互独立：直传模式下下载仍必须走公开桶（反之亦然）
ok(
  '上传直传（false）不影响下载判定：isProxyMode 仍为 false',
  isProxyMode({ DL_DOMAIN: 'https://dl.example.com', UPLOAD_VIA_WORKER: '0' }) === false
);

/* ============ 3. 会话密钥 ============ */
console.log('\n[会话密钥：sessionSecretOf / hasSessionKey]');

const sha256hex = (s) =>
  createHash('sha256').update(new TextEncoder().encode(s)).digest('hex');
/** 与实现约定一致的派生参考式：固定前缀 + 口令 */
const derive = (pw) => sha256hex('r2share/session-key/v1:' + pw);

ok(
  '显式 SESSION_SECRET 优先，且原样返回（密钥与口令解耦）',
  (await sessionSecretOf({ SESSION_SECRET: 'expl-icit-secret', ADMIN_PASSWORD: 'pw' })) ===
    'expl-icit-secret'
);

const derived = await sessionSecretOf({ ADMIN_PASSWORD: 'correct horse battery' });
ok(
  '未配 SESSION_SECRET → 按 SHA-256("r2share/session-key/v1:" + 口令) 派生',
  derived === derive('correct horse battery')
);
ok('派生结果是 64 位十六进制', /^[0-9a-f]{64}$/.test(derived));
ok(
  '同一口令重复派生结果稳定（跨 isolate / 重启 / 重新部署一致）',
  (await sessionSecretOf({ ADMIN_PASSWORD: 'correct horse battery' })) === derived
);
ok(
  '不同口令派生出不同密钥',
  (await sessionSecretOf({ ADMIN_PASSWORD: 'another password' })) !== derived
);
ok(
  'SESSION_SECRET 为空串时退回派生（空值不等于已配置）',
  (await sessionSecretOf({ SESSION_SECRET: '', ADMIN_PASSWORD: 'correct horse battery' })) ===
    derived
);
ok(
  '口令为空也能算出摘要（所以调用方必须先过 hasSessionKey 守卫）',
  (await sessionSecretOf({})) === derive('')
);
ok(
  '多余的环境变量不影响派生结果',
  (await sessionSecretOf({ ADMIN_PASSWORD: 'correct horse battery', BUCKET_NAME: 'x' })) === derived
);

ok('hasSessionKey：配了口令 → true', hasSessionKey({ ADMIN_PASSWORD: 'pw' }) === true);
ok('hasSessionKey：只配了 SESSION_SECRET → true', hasSessionKey({ SESSION_SECRET: 's' }) === true);
ok('hasSessionKey：都没配 → false（isLogin 据此直接判未登录）', hasSessionKey({}) === false);
ok('hasSessionKey：两者都是空串 → false', hasSessionKey({ SESSION_SECRET: '', ADMIN_PASSWORD: '' }) === false);

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
