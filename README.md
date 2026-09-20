# r2share

基于 Cloudflare Worker + R2 的零费用个人仓库（我的仓库）。

单文件 < 95 MiB、总量 < 10GB、全部公开、以分享下载为主的场景下，**月成本严格为 $0**。

---

## 界面预览

未登录列表视图（默认）：
![home](docs/screenshots/home.png)

未登录网格视图：
![grid](docs/screenshots/grid.png)

登录后顶部多出「重建索引 / 上传 / 退出」三个按钮，文件行 hover 出现删除按钮：
![login](docs/screenshots/login.png)

README.md 预览弹层（标题右侧「下载」按钮直链下载）：
![preview](docs/screenshots/preview.png)

搜索无结果时的空态（与「目录为空」文案分开）：
![search-empty](docs/screenshots/search-empty.png)

---

## 架构

```
浏览器
 ├─ 打开目录页   ──→ Worker 渲染 HTML（1 次请求；style.css/app.js 由 CF 边缘直接服务，0 次 Worker）
 │                      └─ fetch R2 上的 files.json（1 次 Class B 读）
 ├─ 下载文件     ──→ R2 公开桶直链 dl.114448.xyz（出口永远免费，不经过 Worker）
 └─ 上传 N 个文件 ─→ Worker /api/sign（1 次请求，批量签发）
                     → 浏览器并发 PUT 同源 /api/local-put（每文件 1 次请求，Worker 内部写 R2）
                     → Worker /api/commit（1 次请求，批量写索引）
```

默认上传走 **Worker 代理**（`UPLOAD_VIA_WORKER = "1"`）：浏览器的 PUT 指向本 Worker
的同源路径，由 Worker 用 R2 binding 写入，**不依赖 `r2.cloudflarestorage.com` 直传**——
该端点在某些网络（如国内）被墙，presigned 直传会 `ERR_ADDRESS_UNREACHABLE`。
代价是上传数据流经 Worker 且上限受 Workers 请求体限制（见 `MAX_UPLOAD`）。

三条通道里，**下载完全不经过 Worker**；浏览只有首页 HTML 消耗 1 次 Worker 请求
（静态资源由 CF 边缘直接服务，免费且无上限）。这是能做到零费用且抗刷的关键。

如切换回 presigned 直传（设 `UPLOAD_VIA_WORKER = "0"`），上传明细见下表的
「presigned 直传」备注：浏览器直传 R2 S3 端点，绕过 Workers 请求体上限，
但要求网络能直连 `r2.cloudflarestorage.com`。

### 请求消耗

| 动作 | Workers 请求 | R2 操作 | 费用 |
| --- | --- | --- | --- |
| 浏览目录页 | 1（渲染 HTML） | 1 × Class B（读 files.json） | $0 |
| 下载文件 | 0（公开桶直链） | 1 × Class B | $0 |
| 上传 1 个文件（Worker 代理） | 3（sign + PUT + commit） | 1 Class A put + 1 Class B head + 1 Class B 读 files.json + 1 Class A 写 | $0 |
| 批量上传 N 个文件（Worker 代理） | N + 2（1 × sign + N × PUT + 1 × commit） | N Class A put + N Class B head + 1 Class B 读 + 1 Class A 写 | $0 |
| 批量删除 N 个文件 | 1 | N Class A delete + 1 Class B 读 + 1 Class A 写 | $0 |

> **批量优先**：上传与删除都走 `entries[]` / `paths[]` 批量形态。拖入 200 个文件时
> Worker 请求是 202 次（而非 600 次），索引读写从 200 次降到 1 次 —— 索引读改写
> 是整条链路里最贵的一环，批量化把它摊薄成常数。

> presigned 直传备注：单个文件 2 次 Worker 请求（sign + commit），数据不经过 Worker，
> 上限为 5 GiB（R2 单对象）。Worker 代理模式上限为 Workers 请求体（见 `MAX_UPLOAD`）。

### 免费额度边界（超出才收费）

| 额度 | 免费上限 | 超出单价 |
| --- | --- | --- |
| R2 存储 | 10 GB | $0.015/GB-月 |
| Workers 请求 | 10 万/天 | 需升级 $5/月套餐 |
| R2 Class A（写 / list） | 100 万/月 | $4.50/百万 |
| R2 Class B（读） | 1000 万/月 | $0.36/百万 |
| 出口流量 | **永久免费** | — |

### 索引并发：条件写（CAS）

`files.json` 的每一次写入都收敛到 `src/store.ts` 的 `mutateIndex()`：
**读 → 改 → 带 etag 的条件写**，条件不满足（说明读出来之后被别的 isolate 改过）
就重读、重放、重试，最多 6 次。

为什么必须这么做：模块级 promise 锁只在**单个 isolate 内**有效，而 Cloudflare 会因
负载或版本更新同时跑多个 isolate。多端/多请求并发写索引时，两边各自「读 → 改 → 写」，
后写的会把先写的整个盖掉——表现为**索引里凭空少几条**（文件在桶里，列表里没有）。

两条硬约束，改 `mutate*` 回调时务必遵守：

1. **`mutate` 必须是纯内存变换**——内部不得 `await` 任何存储操作。删对象、遍历桶这类
   一次性副作用必须先做完，再把结果带进回调。
2. **`mutate` 必须可重放且幂等**——冲突时会拿最新索引重新执行一次，重复执行不能产生叠加效果。

---

## 一键部署（GitHub Actions）

**推 `main` = 自动部署。** 仓库内置 `.github/workflows/deploy.yml`：push 到 `main`
就会自动 `wrangler deploy`，并把 GitHub Secrets 当作权威来源同步到 Cloudflare
Worker secrets。适合想"改完推上去就完事"的场景。

### 所需 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 添加（变量名严格一致，共 7 个）。

#### 必填（缺了部署必然失败）

| Secret | 用途 | 怎么拿 / 长什么样 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署认证（wrangler 用它登录 CF） | CF 控制台 → 右上角头像 → **我的个人资料 → API 令牌 → 创建令牌**。需包含 **Workers Scripts Edit** 和 **R2** 权限。形如 `cfut_xxxx`（较长） |
| `CLOUDFLARE_ACCOUNT_ID` | 账户 id | CF 控制台**右上角**显示的账户 id（32 位十六进制，形如 `a1b2c3...`） |

#### 必填（与上传模式有关）

| Secret | 用途 | 怎么拿 / 长什么样 |
| --- | --- | --- |
| `R2_ACCESS_KEY_ID` | R2 S3 API 令牌的 Access Key。即使走 Worker 代理（`UPLOAD_VIA_WORKER=1`）也必须配——`isLocal()` 靠它判断不是本地回退模式 | CF 控制台 → R2 → 右上角 **管理 R2 API 令牌 → 创建**（权限 Object Read & Write）。形如 `45xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `R2_ACCOUNT_ID` | 与 `CLOUDFLARE_ACCOUNT_ID` 相同 | 同一个账户 id，直接填一样的 |

#### 选填（漏填会跳过同步、保留 CF 端现有值，但建议填全）

| Secret | 用途 | 怎么拿 / 长什么样 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 网盘管理口令（登录用） | 自己想一个，或与 CF 端现有值保持一致。建议 8 位以上 |
| `SESSION_SECRET` | **会话签名密钥**：登录后 cookie 用 HMAC-SHA256 加签，防止伪造/篡改登录态。**这个值只存密钥，不对外显示** | `openssl rand -hex 32` 生成，形如 `f7a2c9b1e8d4a6f0...`（64 位十六进制）。**注意**：改动它会让所有已登录用户需要重新登录一次（无副作用），可随时重置 |
| `R2_SECRET_ACCESS_KEY` | 同一令牌的 Secret Key | 创建令牌时**只显示一次**，立即复制保存；丢了就新建一个令牌 |

> ⚠️ 五个应用密钥（`ADMIN_PASSWORD`/`SESSION_SECRET`/R2_*）的 workflow 行为：
> GitHub Secrets 是**权威来源**，每次部署用 GitHub 里的值**覆盖** CF 端同名 secret。
> - 想改密钥：**先在 GitHub 改**，再 push 或手动重跑 workflow，不要只改 CF 控制台（否则会被覆盖回去）
> - 某个 secret 漏填（值为空）：workflow **跳过同步**，保留 CF 端现有值，不会误清空
>
> ⚠️ **隐私**：GitHub Secret 的值只会在 Actions 运行时注入，**不要写进 README 或任何仓库文件**——仓库是公开的，写进去等于公开密钥。

> 📌 **不再需要 `KV_ID`**。登录失败计数已从 KV 改为 Worker 模块内的内存 Map
> （原因见「已知限制 · 登录限流」），`wrangler.toml` 里已无任何 KV 绑定，
> 仓库里也不再需要 `.deploy.local.json` 这一层配置转发。

### 手动触发

除 push 外，仓库 **Actions → Deploy r2share → Run workflow** 可随时手动跑一次
（比如只改了 GitHub Secrets 想立即生效）。

---

## 部署步骤

### 0. 部署前自检（强烈推荐）

```bash
npx wrangler login   # 浏览器授权（或用 CLOUDFLARE_API_TOKEN 环境变量）
npm run check
```

这个脚本会扫描 `wrangler.toml` / `.dev.vars` / `cors.json` 的常见
占位符和弱口令，有问题直接退出码 1 并告诉你怎么修。`npm run deploy` 内部会自动跑这一步。

检查项包括：首页是否显式走 Worker（`run_worker_first` 含 `"/"`）、`MAX_UPLOAD`
是否顶到 CF 账户请求体上限、`cors.json` 的 origin 是否还是占位符，
以及 `wrangler.toml` 里是否还残留已废弃的 `[[kv_namespaces]]`。

### 1. 创建 R2 桶

```bash
npx wrangler r2 bucket create r2share
```

### 2. 开启公开访问并绑定自定义域

在 Cloudflare 控制台 → R2 → 你的桶 → Settings：

- **Public access** 选 `Allow`，会得到一个 `r2.dev` 域名
- 在 **Custom Domains** 里绑定 `dl.114448.xyz`

> ⚠️ 必须用自定义域。`r2.dev` 官方明确限流、不推荐生产使用。

### 配置与隐私边界

| 内容 | 放哪 | 是否进仓库 |
| --- | --- | --- |
| 管理口令、会话密钥、R2 API 密钥 | `wrangler secret`（生产）/ `.dev.vars`（本地） | ❌ |
| 桶名、下载域名、站点名、路由域名 | `wrangler.toml` 的 `[vars]` / `[[routes]]` | ✅ 这些本就是公开信息 |

### 3. 设置密钥

```bash
npx wrangler secret put ADMIN_PASSWORD      # 管理口令
npx wrangler secret put SESSION_SECRET      # openssl rand -hex 32 生成
npx wrangler secret put R2_ACCESS_KEY_ID    # R2 → S3 API 令牌
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ACCOUNT_ID
```

R2 的 S3 API 令牌在控制台 R2 概览页右侧「Manage R2 API Tokens」创建，权限选 Object Read & Write。

### 4. 修改配置

编辑 `wrangler.toml`：

```toml
[vars]
BUCKET_NAME = "r2share"
DL_DOMAIN   = "https://dl.114448.xyz"   # 第 2 步绑定的域名
SITE_NAME   = "我的仓库"
```

### 5. 首次部署

```bash
npm run deploy
```

> 第一次 deploy 后 Cloudflare 会分配一个 Worker URL，形如
> `r2share.<account-subdomain>.workers.dev`，**记下这个 URL**——下一步 CORS 需要。

### 6. 配置 CORS（首次 deploy 之后才能填对）

浏览器直传是跨域 PUT，必须在桶上放行。**第一次 deploy 之后**，把 Worker URL
填进 `cors.json` 的 `allowed.origins`（替换 `<your-worker-domain>`），然后：

```bash
npx wrangler r2 bucket cors set r2share --file cors.json
```

> ⚠️ `cors.json` 必须用**新版嵌套格式**：`{"rules":[{"allowed":{"origins":[],"methods":[],"headers":[]}}]}`。
> 允许的请求头字段是 `allowed` 对象内的 **`headers`**（不是外层 `allowedHeaders`——
> 字段名/层级错误会被 R2 API 静默忽略，导致浏览器跨域预检失败、上传卡死）。
> 其余字段驼峰命名（`exposeHeaders` / `maxAgeSeconds`）。
> 旧版裸数组 / PascalCase 格式（`AllowedOrigins`）会让 R2 API 报 `code 10040 "JSON not well formed"`。
> 参考 `cors.json` 仓库内已有内容。

> 为什么不在 deploy 前填？因为 Worker URL 在 deploy 后才存在。
> 部署前 `npm run check` 会主动提示这一项未就绪。

### 7. 绑定 Worker 自定义域（推荐，无需手动配 DNS）

如果想用自定义域名（如 `file.114448.xyz`），在 `wrangler.toml` 里用
`custom_domain = true`（而不是 `zone_name`）——Cloudflare 会自动创建 DNS 记录与证书：

```toml
[[routes]]
pattern = "file.114448.xyz"
custom_domain = true
```

> ⚠️ 不要用 `zone_name` 传统路由 + 手动 A 记录的方式：在 assets 模式下，
> 传统路由会被当作 assets 路径匹配（部署时警告 "Will match assets: public\<pattern>"），
> 且手动添加的 A 记录会因回源超时导致 **522 Connection timed out**。
> `custom_domain = true` 部署后，所有路径直达 Worker，无需在 DNS 控制台做任何操作。

加完后回到第 6 步，把 `cors.json` 的 `<your-worker-domain>` 改成这个新域名再应用。

---

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars             # 按需改口令
npm run dev                      # http://127.0.0.1:8787
node scripts/seed.mjs            # 灌入演示数据
TEST_PASSWORD='<.dev.vars 里的 ADMIN_PASSWORD>' node scripts/smoke.mjs   # 全流程冒烟（49 项）
npm test                         # 单元测试（203 项，见下）
npm run check                    # 部署前自检
```

`npm test` 会依次跑四套**纯离线**测试（不需要起服务、不连网络）：

| 脚本 | 覆盖 | 项数 |
| --- | --- | --- |
| `scripts/test-crypto.mjs` | SigV4 签名向量、会话 cookie 加签/验签 | 14 |
| `scripts/test-store.mjs` | 路径与 MIME 校验、索引 CAS（含冲突重试、批量幂等、递归删目录）、冲突异常类型与 409 映射契约 | 100 |
| `scripts/test-preview.mjs` | 前端纯函数：预览分类、Markdown 渲染 | 54 |
| `scripts/test-frontend.mjs` | 前端状态逻辑（最小 DOM 替身）+ 源码契约 + 部署配置断言 | 35 |

`TEST_PASSWORD` 不传时会用默认值 `dev123456`，与 `.dev.vars` 里的真实口令对不上，
表现为登录 401 之后整串用例连锁失败——**跑冒烟务必显式带上它**。

生产浏览器 E2E（真实 Edge 登录→上传→渲染→dl 下载→删除，9 项断言）：

```bash
NODE_PATH="<playwright-core 所在 node_modules 目录>" node e2e-prod.mjs
```

注：该脚本是本地自用工具，已被 `.gitignore` 排除、**不在仓库中分发**，运行需自备外部
playwright-core；脚本内 `BASE` / `PASS` 按生产环境修改。

### 同步源码到 GitHub

```bash
export GH_TOKEN="ghp_xxx"     # PAT，需 repo scope
npm run push:gh               # 同步全部已跟踪文件
npm run push:gh -- src/index.ts public/app.js   # 只同步指定文件
```

> 为什么不是 `git push`：本仓库的开发环境代理只放行 `api.github.com`、拦截 `github.com`，
> git 协议必然超时。脚本改走 **GitHub Git Data API**：把所有文件塞进同一个 tree/commit
> 一次性推送，效果等价，且**一次同步只产生一个 commit、只触发一次 CI**。
> 在正常网络下直接 `git push` 即可，无需用这个脚本。
>
> 脚本只同步 **git 已跟踪**的文件，因此 `.dev.vars` 天然不会上传。

本地没有 R2 的 S3 凭证时，程序会自动进入**回退模式**：上传下载改走 Worker 代理
（`/api/local-put`、`/api/local-get`、`/api/local-index`）。一旦配上凭证，这些路由自动拒绝服务。

---

## 日常使用

- **上传**：登录后在网页上拖拽，或 `npx wrangler r2 object put r2share/路径/文件 -f ./文件`
- **批量同步**：用 rclone 挂 S3 端点操作
- **删除**：网页端登录后可删，或 rclone
- **重建索引**：凡是绕过网页上传的写操作（rclone / 后台 / API），文件列表都会和
  `files.json` 对不上。**登录后点页面右上角的「重建索引」按钮**即可对齐（或调接口）：

  ```bash
  curl -X POST https://你的域名/api/refresh \
    -H "cookie: r2share_session=<登录后拿到的值>"
  ```

  实现为游标分页遍历全桶（每页 1000 个对象），list 的等待时间不计入 CPU，
  数千个文件内免费版 10ms 限制够用。日常网页上传不需要它——那是增量提交。

### HTTP 接口速查

| 方法 | 路径 | 登录 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 渲染目录页 HTML（目录数据由前端直连 R2 拉 files.json） |
| POST | `/api/login` / `/api/logout` | 否 | 登录 / 登出；登录失败计数超阈值返回 429 |
| POST | `/api/sign` | 是 | 签发上传地址。`{path,size,type}` 单条，`{entries:[…]}` 批量 |
| POST | `/api/commit` | 是 | 写入索引。`{path,type}` 单条，`{entries:[…]}` 批量；响应回传 `entries`/`missing` |
| DELETE | `/api/file` | 是 | 删除单个文件（对象 + 索引） |
| DELETE | `/api/files` | 是 | 批量删除。`{paths:[…]}`，单次最多 1000 个 |
| POST | `/api/mkdir` | 是 | 新建目录（写 `<path>/` 占位对象，幂等） |
| DELETE | `/api/dir` | 是 | 递归删除目录（前缀批量删 + 一次索引写） |
| POST | `/api/refresh` | 是 | 全量重建索引（对账用，别在常规流程里频繁调） |
| GET | `/api/local-index` / `/api/local-get` | 否（仅本地回退模式可用） | 读索引 / 读对象；配了 R2 凭证或未开上传代理后自动返回 400 |
| PUT | `/api/local-put?key=…` | 是 | 本地回退模式的上传写入；按 `content-length` 兜一道 `MAX_UPLOAD` |

### 在线预览

图片、视频、音频走浏览器原生能力；文本/代码（≤2MB）和 Markdown 在弹窗内渲染，
Markdown 支持标题 / 列表 / 表格 / 代码块 / 引用 / 任务清单。其余类型直接下载。

### 备份到 Backblaze B2（零成本双活）

B2 同样有 10GB 免费额度，且与 Cloudflare 是带宽联盟、互传流量免费：

```bash
rclone sync r2:r2share b2:你的桶 --progress
```

建议每月跑一次。

---

## 设计约束（改动代码前请先看）

1. **URL 必须是真实文件路径**，不能改成 `/api/file?id=123` 这类依赖程序路由的形式。
   这样将来换到任何 S3 服务商，只需改域名前缀，已分享出去的链接结构不变。
2. **下载不能经过 Worker**。一旦改成 Worker 中转，就会撞上 10 万请求/天的天花板。
3. **索引更新默认走增量**（`upsertFiles`）；`/api/refresh` 全量重建只用于对账，
   不要在常规流程里频繁调用——免费版 CPU 只有 10ms。
4. 所有插入 HTML 的动态内容必须过 `esc()`；文本预览必须用 `textContent` 注入。
5. **索引写入必须走 `mutateIndex()`**，不要绕开它直接 `BUCKET.put('files.json', …)`。
   绕开等于放弃 CAS，跨 isolate 丢条目会立刻回来。回调的两条不变量见上文「索引并发」。
6. **账户标识不进仓库**：桶名、域名这类公开信息可以进 `wrangler.toml`；
   凡是账户资源标识（namespace id、account id 之类）一律只放 `.dev.vars` / `wrangler secret`
   或 CI 的环境变量。当前仓库已无此类绑定（KV 已移除），新增绑定时请守住这条。

## 已知限制

- 没有网页端的文件重命名 / 移动 / 打包下载（R2 无 rename，目录移动是 O(n) 操作），需要时用 rclone
- 目录页不是严格实时：`files.json` 缓存 10 秒
- 上传接口有登录保护，但文件本身是公开的（这是设计选择）
- presigned PUT URL 只绑定路径和 1 小时有效期，**不绑定文件大小**：`/api/sign`
  的 size 上限校验是业务约束（`MAX_UPLOAD`，默认 95 MiB），拿到签名 URL 后实际可传更大文件。
  上传需登录 + 签名 URL 仅 1 小时有效，对个人站可接受；若担心存储超限，
  可在 R2 桶生命周期规则里设对象大小上限或定期清理
- **`MAX_UPLOAD` 默认 95 MiB 而非 100 MB**：Cloudflare 账户请求体的硬上限是 100 MB，
  超过会被边缘直接 413、请求根本到不了 Worker。顶格设置只会让用户收到一个语焉不详的网络错误，
  所以留出余量
- **登录限流是「降速」而非强保证**：计数存在 Worker 模块内存里，每个 isolate 各算各的。
  多 isolate 并存时实际阈值会放宽，isolate 回收后计数清零。
  这是刻意的取舍——KV 免费版「同一 key 每秒 1 次写、每天 1000 次写」会让计数严重失真，
  还平白多一次跨网络往返；对个人站的爆破防护，内存限流已足够
- **极端并发下索引写入可能失败，返回 409 而非 500**：`mutateIndex` 连续 6 次都被别的
  isolate 抢先时抛出 `IndexConflictError`，`app.onError` 把它映射成 **409 +
  「索引正被其他请求修改，请稍后重试」**——这是瞬时竞争，不是服务端故障，所以不报 500。
  此时对象已经写进桶、只是没进索引，重试一次或点「重建索引」即可对齐；
  正常使用（单人、偶发多端）几乎不会触发
