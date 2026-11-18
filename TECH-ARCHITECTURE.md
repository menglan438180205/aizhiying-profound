# 全栈技术架构与卡点评审 · 轻量化方案

> 对象：ProFound（`index.html` 单页 + `server/` 零依赖 BFF + FFmpeg 渲染）
> 方式：按真实代码核对（文件体量、依赖、进程模型、存储、鉴权、静态托管），非设计稿推断
> 日期：2026-10-17

---

## 一、技术栈实测

| 项 | 实测值 | 说明 |
|---|---|---|
| 服务端 | Node 18+，**零 npm 依赖** | `server/package.json` 的 `dependencies` 为 `{}` |
| 服务端代码量 | 16 文件 / **4,710 行** | 最大 `index.js` 1,051 行 |
| 前端 | 单文件 `index.html` **740 KB** | 内联 `<style>` 1,494 行；5 个带 id 的 `<script>` 层 |
| 前端外部依赖 | **1 个 CDN 脚本** | `index.html:1500` `workbuddy-cloud-sdk` |
| 渲染 | `spawn` FFmpeg 子进程 | 并发默认 1（`RENDER_CONCURRENCY`） |
| 配音 | Windows SAPI / macOS say / espeak | 无第三方 TTS |
| 存储 | 单 JSON 文件 + 原子写 | `store.js` 120 行 |
| 实时 | `GET /v1/events` 返回**快照 JSON** | `index.js:927`，**不是 SSE** |
| 鉴权 | `Authorization: Bearer`，`API_TOKEN` 为空则全放开 | 前端 **5 处 fetch 均不带 header** |
| 测试 | 18 个端到端用例 | 起真进程、真渲染、验 mp4 头与 ffprobe |
| 静态托管 | `STATIC_ROOT` = 项目根 | 见 K0 |

---

## 二、分层架构

| 层 | 组成 | 职责 | 现状 |
|---|---|---|---|
| L1 表现层 | `index.html` 的 5 个脚本层：`runtime` / `matrix` / `geo` / `geosite` / `colsd` | 视图渲染 + 本地状态 | 可跑；层间靠全局变量通信 |
| L2 接入层 | `http.createServer` + `handle()`（60+ 个 if 分支） | 路由、CORS、鉴权、静态托管、Range 分发 | 可跑；if 链无表驱动 |
| L3 领域层 | `collector` / `collect-sched`（获客）· `queue` / `renderer`（剪辑）· `geo` / `schedule`（GEO）· `billing`（计费） | 四域并列，**互不调用** | 四域只共享 `store` |
| L4 能力层 | `ffmpeg`（能力探测）· `edit-capabilities`（TTS+字幕）· `multipart` · `samples` | 可替换的技术能力 | 质量最高的一层 |
| L5 存储层 | `store.js` + `.data/{db.json,assets,out,samples}` | 全量内存 + 原子写 | 单进程单实例 |
| L6 外部 | 采集上游 / GEO 上游 / 支付网关 / 云库 / FFmpeg 二进制 | 依赖 | 前 4 项 0 接入 |

四条主数据流：

```
A 获客  comment ──▶ collector(4通道) ──▶ collect-sched(去重) ──▶ 线索池 ──▶ ✂ CRM
B 剪辑  素材 ──▶ queue(指纹幂等) ──▶ renderer(TTS+字幕+FFmpeg) ──▶ out/*.mp4 ──▶ ✂ 投放
C GEO   上游 ──▶ geo(排名) ──▶ changes 看板 ──▶ ✂ 内容回灌
D 计费  下单 ──▶ 订单 ──▶ ✂ 支付 ──▶ ✂ 订阅云库
```

---

## 三、卡点清单

### K0 · 静态根越界（P0，必须今天就修）

- **证据**：`STATIC_ROOT = ROOT`（`index.js:423`），`STATIC_BLOCK` 只屏蔽 `.build/.workbuddy/node_modules/.data/.git`（`index.js:426`）。实测临时实例：
  ```
  GET /app/.env.local      → 200   ← 含 API_TOKEN / COLLECT_OFFICIAL_TOKEN / GEO_TOKEN /
                                     PAY_NOTIFY_SECRET / SERVICE_DB_KEY
  GET /app/server/config.js → 200   ← 服务端源码
  GET /app/start-local.js   → 200
  ```
- **为什么最严重**：这不是"未来会痛"，是**现在就能被匿名拉走全部密钥**。一旦对外网暴露 8787，等于把支付密钥和采集 Token 公开发布。而且它绕过鉴权——静态托管在 `authed()` 之前。
- **轻量解（5 行，10 分钟）**：
  ```js
  // 1) 把 .env 系列加入屏蔽
  const STATIC_BLOCK = /(^|[\\/])(\.build|\.workbuddy|node_modules|\.data|\.git|server)([\\/]|$)|\.env/i;
  // 2) 更稳的做法：白名单化
  if (!/^\/(index\.html|assets\/|favicon\.ico)/.test(rel)) return 404;
  ```
- **验证**：三条 curl 全部 404，且 `/app/` 与 `/app/assets/*` 仍 200。
- **风险**：极低，只影响静态路径，不动业务。

### K1 · 前端单文件 740 KB，无模块边界（P1）

- **证据**：`index.html` 740 KB；5 个脚本层共约 1000 KB 文本；层间通过 `window.__UI` / `window.__GEO` 这类全局对象耦合；没有 `import`/`export`。
- **痛在哪**：任何改动都是"在大海里改一个字符"，没有类型、没有单测、改完只能靠人肉回归。两个人同时改必然冲突。现在能跑，是因为一个人、并且有严格的自检脚本。
- **轻量解（不引入打包器）**：把 5 个层拆成 `src/{runtime,matrix,geo,geosite,colsd}.js` + `src/app.css`，写 **30 行 concat 构建**（Node 内置 `fs` 即可）生成单文件 `index.html`。
  - 发布形态不变（仍是单文件，客户现场部署友好）；
  - 开发时是 6 个文件，能 diff、能定位、能分层 review；
  - 零新依赖、零构建链。
- **最小起步（如果不想动构建）**：给每个脚本层加首行职责注释 + 写 `scripts/check-inline.js`（20 行）校验"每个层只能访问白名单内的全局对象"，把隐性耦合显性化。

### K2 · `.build` 与 `index.html` 双真相（P1，已真实踩坑）

- **证据**：`.build/` 下有 `geo.js`、`matrix.js`、`collector_sched.js` 等源层文件，同时又有 14 个 `index.before-*.html` 备份；上一轮就出现过 `.build/geo.js` 滞后于内联脚本（SNIPPET_TPL 还是旧行业文案），要靠人工"反向同步"。
- **痛在哪**：源层和产物谁是真权威没有约定，补丁脚本重跑一次就可能把改动整体回退。这是**版本管理的雷**，比代码质量问题更危险——它会悄悄吞掉已完成的工作。
- **轻量解（40 行）**：确立**单向**：`src/ → index.html`，`.build/` 降级为"历史备份目录"，不再参与开发；加 `scripts/build.js`（concat + 占位替换）与 `scripts/check-sync.js`（比对 hash，不一致退出码 1）。
- **验收**：`node scripts/check-sync.js` 通过；删除 `.build/*.py` 补丁脚本，避免再次误用。

### K3 · 单进程承载四类职责（P1）

- **证据**：`http.createServer` 与 `queue`、`collect-sched`、`geo schedule` 在同一个进程；FFmpeg 虽 `spawn` 为子进程，但进度流解析、字幕生成、`store.save` 都在主事件循环里；`RENDER_CONCURRENCY` 默认 1。
- **痛在哪**：一条 15 秒片子渲染时，API 请求延迟抖动；渲染并发调到 2 就更容易触发；这是"演示时很顺、客户现场一卡就崩"的典型来源。
- **轻量解（80 行）**：`child_process.fork` 一个 `render-worker.js`，主进程只做 API + 入队，通过 IPC 回传进度。Node 内置，无需依赖。
- **过渡方案（20 行）**：渲染进行中把 `store.save()` 从 400ms debounce 改为"仅在阶段切换时落盘"，并把进度事件节流到 1s；能消掉大部分抖动，但根治仍需 fork。

### K4 · store 全量重写（P1，最先撞墙的数据卡点）

- **证据**：`store.js:62` 每次 `_flush()` 都 `JSON.stringify(this.data)` 全量序列化再 rename。`data` 含 7 张表（jobs/assets/orders/events/geo_*/collect_*）。
- **量级估算**：1 万条线索 ≈ 4–6 MB；每次新增一条线索 → 序列化 5 MB + 写盘。采集调度频率是分钟级，一天几千次写入 = 几十 GB 磁盘写放大。
- **轻量解（120 行，不引 SQLite）**：**分表 + 追加日志**。
  - 低频表（jobs/assets/orders）→ 各自独立 JSON，独立 flush（写放大从"全部"降到"单表"）；
  - 高频表（leads/events/geo_points）→ 追加写 NDJSON，启动时回放，超过 5 万行或 7 天做 compact；
  - 对外接口保持不变（`store.leads()` 等签名不动），只换实现。
- **为什么不选 SQLite**：`node:sqlite` 是 Node 22+ 实验特性，项目声明 Node 18+；`better-sqlite3` 需要编译，破坏"零依赖、拷走就能跑"的优势。分表 + NDJSON 能撑到十万级，足够单机场景。

### K5 · `/v1/events` 是快照轮询，不是 SSE（P1）

- **证据**：`index.js:927` 直接返回 `{events: [...50条]}`；前端有 9 处 `setInterval` 各自轮询。
- **痛在哪**：任务进度、日志、采集状态都不"实时"；请求数随页面打开数线性放大；每个 `setInterval` 都是一份独立的状态机，容易泄漏。
- **轻量解（50 行）**：真 SSE——`text/event-stream` + 15s 心跳 + 环形缓冲 200 条 + 支持 `Last-Event-ID` 断线续传；前端用一个 `EventSource` 替换多个轮询，**-8 处 setInterval**。
- **收益**：延迟从秒级轮询降到毫秒推送，请求量下降一个数量级，代码量反而是减少的。

### K6 · 鉴权契约与实际请求不一致（P1，上线即断）

- **证据**：`authed(req)` 校验 `Bearer`，`API_TOKEN` 为空则全放开；前端 5 处 `fetch` 均不带 `Authorization`。
- **痛在哪**：本地能跑 → 生产一设 token 全部 401。这是"上线前最后一公里"断点，`preflight --strict` 会红。
- **轻量解（服务端 25 行，前端 0 行）**：改 **HttpOnly Cookie 会话**——登录端点 `Set-Cookie`，`authed()` 同时接受 Cookie 与 Bearer。前端完全不用改（同源自动带 Cookie），比"给 5 处 fetch 加 header"更彻底，还能顺带解决刷新掉登录态。
- **注意**：`SameSite=Lax` + 生产 HTTPS；CORS 需 `credentials`，跨域场景保留 Bearer。

### K7 · 路由是 60+ 分支的 if 链（P2）

- **证据**：`handle()` 单函数 1,051 行内顺序判断，鉴权判断夹在第 615 行，之后的端点全在鉴权之后，之前的（静态、demo、data-samples）全在之前——**"哪些端点免鉴权"是靠代码位置隐式决定的**（K0 正是这个结构的产物）。
- **轻量解（15 行）**：一张 `[method, /^\/v1\/edit\/jobs\/([^/]+)$/, handler, {auth:true}]` 表 + 一个 for 循环。存量分支先不动，只要求**新端点必须进表**，并把 `auth` 变成显式字段。
- **收益**：新增端点的成本从"复制 20 行 if"降到"加一行表项"，且鉴权不再靠位置。

### K8 · 前端仍以本地状态为主（P1）

- **证据**：全页仅 5 处 `fetch`；素材列表用 `persist` 存 localStorage（B11 素材双真相）；演示数据已走 `/v1/demo/dataset`，但业务操作仍大量写本地。
- **痛在哪**：换设备/清缓存即丢；服务和前端各存一份，出现"看得见但渲染不了"。
- **轻量解（先改 2 处）**：加一个 `api()` 包装（统一 baseURL + 错误 + 重试，约 30 行），规则定为"**服务端是唯一真相，localStorage 只做缓存**"。优先改素材库与 CRM 两个高频页，其余逐步迁移。
- **不要一次全改**：前端 740 KB，全量重构是几周的量；按页面迁移，每迁移一页删一段本地状态。

### K9 · 唯一外部 CDN 依赖（P2）

- **证据**：`index.html:1500` 加载 `cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev`。版本号是 `@dev`——**不可复现的构建**，且内网/私有化部署必挂。
- **轻量解**：下载到 `assets/sdk.js` 本地引用（锁版本），或改为按需动态加载 + 失败降级（登录/云同步功能不可用，其余可用）。约 20 行。

### K10 · 无租户维度（P1，结构级）

- **证据**：`tenant` 仅出现在 `billing` 的订单幂等键（`index.js:536`、`billing.js:44`）；`store.data` 的 7 张表全部没有归属字段。
- **痛在哪**：一套实例只能服务一个客户，服务商模式（X9）无法落地；将来加租户要迁移全部历史数据。
- **轻量解（分两步，各 40 行）**：① **读隔离先行**——所有实体加 `owner_id`，`store` 的查询方法统一注入 `owner` 过滤（默认 `'default'`）；② 写入时带上 owner，并在 `handle()` 把 `X-Tenant-Id` 收口成 `ctx.tenant`。
- **顺序很关键**：先加字段（兼容），再切查询（可回滚），最后才强制校验。不要一次改成"必须带租户"。

### K11 · 可观测性偏薄（P2）

- **证据**：`store.data.events` 内存上限 500 条（`store.js:114`）；日志只有 `start-local` 写的单文件 `.data/server.log`；没有请求耗时、错误率、队列水位的历史。
- **轻量解（30 行）**：请求层加 3 个计数器（QPS / p95 / 5xx 率）+ `GET /v1/metrics` 输出 Prometheus 文本格式；日志按天切分（`server-YYYY-MM-DD.log`）。不接 Prometheus 也能人肉看。

---

## 四、卡点总表

| 编号 | 卡点 | 级别 | 典型爆发时点 | 改动量 | 类型 |
|---|---|---|---|---|---|
| K0 | 静态根越界，`.env` 可下载 | **P0** | 一暴露公网 | 5 行 | 安全 |
| K1 | 前端单文件无模块边界 | P1 | 第二次多人协作 | 30 行脚本 | 可维护 |
| K2 | `.build` 与产物双真相 | P1 | 补丁重跑 | 40 行脚本 | 工程 |
| K3 | 单进程四职责 | P1 | 渲染并发 > 1 | 80 行 | 稳定性 |
| K4 | store 全量重写 | P1 | 线索 > 1 万 | 120 行 | 数据 |
| K5 | 伪实时轮询 | P1 | 多标签页 | 50 行 | 体验 |
| K6 | 鉴权契约断 | P1 | 上线设 token | 25 行 | 上线 |
| K7 | if 链路由 | P2 | 端点 > 80 | 15 行 | 结构 |
| K8 | 前端本地状态为主 | P1 | 换设备 | 30 行 + 逐页 | 一致性 |
| K9 | CDN `@dev` 依赖 | P2 | 私有化部署 | 20 行 | 交付 |
| K10 | 无租户 | P1 | 接第二个客户 | 80 行 | 结构 |
| K11 | 可观测性薄 | P2 | 客户报"卡" | 30 行 | 运维 |

**总改动量约 500 行**，不到现有服务端代码的 11%，全部零新依赖。

---

## 五、轻量化路线（四阶段）

| 阶段 | 时长 | 动作 | 完成标志 |
|---|---|---|---|
| **A 止损** | 半天 | K0 静态白名单 · K9 SDK 本地化 · K6 Cookie 会话 | 三条敏感路径 404；设 token 后前端全功能可用 |
| **B 稳运行** | 2–3 天 | K3 fork 渲染 worker · K4 分表 + NDJSON · K5 真 SSE | 渲染时 API p95 < 200ms；1 万线索写入 < 20ms |
| **C 可维护** | 1–2 天 | K1 拆 src + 30 行构建 · K2 单向构建 + sync 校验 · K7 mini-router · K11 metrics | `node scripts/build.js` 可复现产物；`check-sync` 进 CI |
| **D 可售卖** | 3–5 天 | K10 owner_id 读隔离 · K8 逐页迁移 · 私有化镜像 | 同一实例可服务 2 个客户且数据互不可见 |

**顺序原则**：先修"会泄露/会丢数据"的（K0/K4），再修"会抖"的（K3/K5），最后修"会拖慢团队"的（K1/K2/K7）。**不要按代码美观度排序**。

---

## 六、轻量化的边界：哪些不能省

这套系统有几个真正的优势，改造时不要顺手拆掉：

1. **零 npm 依赖**——客户现场 `node index.js` 就能跑，这是最强的交付力。任何方案引入 webpack/vite/better-sqlite3 都是在削弱它。
2. **单文件发布形态**——拆分是为了开发，不是为了发布。产物仍应是一个 `index.html`。
3. **FFmpeg 能力探测 + 三档降级**（libass → drawtext → 不烧录）——这是最扎实的一层，别为了"统一技术栈"换成云渲染。
4. **端到端真渲染测试**（18 用例，验 mp4 头与 ffprobe）——比任何单元测试都值钱，重构时它是安全网。
5. **fail-loud 的配置守卫**（`config.js` + `preflight`）——生产环境缺配置就拒绝启动，这个设计要保留。

---

## 七、一句话总结

技术底座是**健康的**：零依赖、能力探测、幂等指纹、端到端测试都做得比同规模项目扎实。真正的问题只有两个性质——**一个安全口子（K0）**和**一个数据结构假设（K4 全量写 + 无租户）**。前者 5 行就能堵，后者 120 行就能换掉；其余都是"迟早要还的工程债"，用约 500 行、分四阶段，可以在不引入任何新依赖的前提下还清。

---

## 七、疏通记录（2026-10-17 执行）

> 按 A→B→C→D 顺序实际改动，每步验证后才进入下一步。服务端回归始终 **204/204**。

### A 阶段 · 止损

| 卡点 | 实际改动 | 验证结果 |
|---|---|---|
| **K0** 静态越界 | `serveStatic` 改「白名单 + 拒绝回溯」：只放行 `index.html` / `favicon.ico` / `assets/*`（QA 模式额外放行 `.build/` 静态页）。`STATIC_BLOCK` 保留作第二道 | `.env.local` / `server/config.js` / `start-local.js` / `assets/../.env.local` / `%2e%2e/.env.local` **全部 404**；`/app/` 与 `/app/assets/sdk.js` **200** |
| **K9** CDN 依赖 | SDK 下载到 `assets/sdk.js`（71 KB，`v0.1.4-dev.ca27990.202610161713`），`index.html` 改为本地引用 + `onerror` 降级 | 私有化/内网可用；版本可复现 |
| **K6** 鉴权契约 | `authed()` 支持三种等价凭证：Bearer / `pf_bff` HttpOnly Cookie / `?token=`；新增 `GET/POST/DELETE /v1/session` 换票；前端 `bffHeaders()` 统一注入，5 处 fetch 收敛到 2 个 wrapper | 无凭证 401、错 token 401、正确 token 换 Cookie 后 200、Bearer 200、`/v1/health` 仍公开 200 |

### B 阶段 · 稳运行

| 卡点 | 实际改动 | 验证结果 |
|---|---|---|
| **K4** 全量重写 | `store.js` 改为**分表 + NDJSON**：11 张表各一文件，`collect_leads` / `collect_runs` / `geo_runs` 走追加写（后写覆盖 + 超 2×cap 自动压缩）；`save(true,'table')` 单表落盘；旧 `db.json` 启动时自动拆分并归档 | 迁移后 172 线索 / 4 任务 / 36 GEO 采样**零丢失**；状态更新 `new→contacted` 重载仍在；新增线索写入成本与池大小无关 |
| **K3** 单进程四职责 | 新增 `server/render-worker.js`，`queue` 按并发 fork 子进程池，主进程只做 API + 调度；取消/崩溃自动补位；`RENDER_INLINE=1` 可回退 | 真实渲染 2 条任务成功（3.5–5.7s，237 KB mp4），`/v1/metrics` 显示 `mode=worker, workers=1` |
| **K5** 伪实时 | `/v1/events` 同 URL 支持 SSE（`Accept: text/event-stream` 或 `?stream=1`），15s 心跳 + 200 条环形缓冲 + `Last-Event-ID` 补发；不带参数仍是快照（向后兼容） | `curl -N` 收到 `retry` / `hello` 帧；快照调用方无感 |

> 过程中发现并修复一个自己引入的缺陷：迁移时 NDJSON 表被 `_compact(force=false)` 跳过，导致 172 条线索只存在内存。已改为显式 `save` 强制落盘，并从备份恢复验证。

### C 阶段 · 可维护

| 卡点 | 实际改动 | 验证结果 |
|---|---|---|
| **K7** if 链路由 | 新增 `ROUTES` + `route(method, pattern, handler, {public})` + `matchRoute()`，在 `handle()` 入口优先匹配；存量分支不动，新端点（`/v1/metrics`、`/v1/tenants`）全部走表，鉴权改为显式字段 | 两个新端点可访问；鉴权不再依赖代码位置 |
| **K11** 可观测性 | `finish` 事件记账：请求数、状态码分布、p50/p95/p99（保留 500 样本）；`GET /v1/metrics` 输出 JSON，`?format=prom` 输出 Prometheus 文本；附带 queue / storage / SSE / 内存 | 实测 `requests=4, status={200:3,201:1}, p50=4ms, p95=42ms` |
| **K1/K2** 双真相 | 新增 `scripts/extract-src.js`（index.html → `src/*.js` + `app.css` 只读镜像）与 `scripts/check-sync.js`（镜像过期即报差异行数，`--strict` 退出 1）；`.build/*.py` 共 10 个补丁脚本归档到 `.build/legacy/` | 5 个脚本层 + CSS 导出成功；`check-sync` 全部一致；补丁脚本不再可能被误跑 |

### D 阶段 · 可售卖（铺路）

| 卡点 | 实际改动 | 验证结果 |
|---|---|---|
| **K10** 无租户 | 存量记录在内存补 `owner='default'`；新任务/素材写入带 `owner`（取 `X-Tenant-Id`，缺省 `default`）；`store.byOwner(table, owner)` / `countsByOwner(table)`；新增 `GET /v1/tenants` | 带 `X-Tenant-Id: acme` 建任务后：`countsByOwner('jobs') = {acme:1, default:6}`，存量 6 条不受影响 |

### 仍未做（下一轮）

1. **K8 前端服务端优先**：素材库与 CRM 仍在 localStorage 维护列表，需按页迁移（`api()` 已就绪，属渐进式改造）。
2. **存量 60+ if 分支迁移到 ROUTES**：目前只约束新增端点，一次性迁移风险大于收益。
3. **归因闭环（对应业务冲突 X17）**：渠道码 + 成交回传接口，需要产品侧先定口径。

### 回滚方式

| 范围 | 备份 |
|---|---|
| 服务端核心 | `.build/{store,index,queue,geo,collect-sched}.before-k4.js` |
| 数据 | `.data/demo/db.json.backup-k4`（迁移前完整旧库）；迁移时另有 `db.json.migrated-<ts>` 自动归档 |
| 前端 | `index.html` 仅两处改动：SDK 引用、`bffHeaders` 注入；可用 git diff 单点回退 |
| 开关 | `RENDER_INLINE=1` 退回进程内渲染；不设 `API_TOKEN` 则鉴权全开（保持原行为） |
