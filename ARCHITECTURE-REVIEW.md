# 全栈架构评审 · 数据流断点与优化清单

> 评审对象：AI智盈（前端 SPA + BFF + 渲染 Worker + 采集/GEO/计费）
> 评审方式：按实际代码核对模块依赖与接口契约，非设计稿推断
> 日期：2026-10-17

---

## 一、架构总览（六层）

| 层 | 组成 | 现状 |
|---|---|---|
| 接入层 | `index.html` + `.build/{runtime,matrix,collector_sched,geo}.js` | 可用；启动时自动探测同源 / `127.0.0.1:8787` 的 BFF |
| BFF 层 | `server/index.js`（原生 http，无框架） | 可用；路由分段分发 + SSE `/v1/events` + 静态托管 + 启动守卫 |
| 领域层 | 采集 `collector.js` / `collect-sched.js`；剪辑 `queue.js` / `renderer.js`；GEO `geo.js` / `schedule.js`；计费 `billing.js` | 四域并列，**互不调用** |
| 能力层 | `ffmpeg.js`（能力探测）、`edit-capabilities/`（TTS+字幕）、`multipart.js`、`config.js` + `preflight.js` | 可用；零 npm 依赖 |
| 存储层 | `store.js`（单 JSON 文件，原子写 + debounce） + `.data/{assets,out,samples}` | 可用；**单进程单实例** |
| 外部上游 | 官方开放平台 / 自建爬虫 / 第三方数据服务 / GEO 监测 / 支付网关 / 云库 | **0 / 6 已接入** |

核心接口面（BFF 实际暴露）：

- 剪辑：`GET /v1/edit/samples`、`POST|GET /v1/edit/jobs`、`GET /v1/edit/jobs/:id`、`POST /v1/edit/jobs/:id/cancel`、`GET /v1/edit/stats`
- 采集：`GET /v1/collect/config|channels|leads`、`GET|POST /v1/collect/tasks`、`PATCH|DELETE /v1/collect/tasks/:id`、`POST /v1/collect/tasks/:id/run`、`POST /v1/collect/preview`、`POST /v1/comments/collect`
- GEO：`GET /v1/geo/config|stream|runs|changes|history|overview`、`GET|POST /v1/geo/tasks`、`POST /v1/geo/monitor|plan`
- 计费：`GET /v1/plans`、`POST /v1/billing/orders`、`POST /v1/billing/notify`
- 基础：`GET /v1/health`、`GET /v1/events`、`GET /v1/qa/report`（QA_MODE）

---

## 二、四条主数据流

```
A 获客流   评论源 ──▶ collector(4 通道选路) ──▶ collect-sched(去重入池) ──▶ 线索池 ──▶ ✂ CRM/跟进
B 剪辑流   素材 ──▶ queue(指纹幂等) ──▶ renderer(TTS+字幕+amix+FFmpeg) ──▶ 成片 /files ──▶ ✂ 投放/发布
C GEO 流   GEO 上游 ──▶ geo(排名采集) ──▶ geo_changes 看板 ──▶ ✂ 内容优化回灌
D 计费流   下单 ──▶ 订单 ──▶ ✂ 支付网关 ──▶ ✂ 订阅云库
```

四条流**没有一条是闭环的**：A 止于线索池、B 止于磁盘文件、C 止于看板、D 止于待支付订单。

---

## 三、断点清单（11 处，按优先级）

### P0 · 会让系统"看起来能跑、实际产不出价值"

**B1 采集上游全断（源头断点）**
- 证据：`/v1/health` 返回 `collector.realChannels: []`、`mode: "local"`；仅 `local` 通道 `configured: true`。
- 影响：线索池里 100% 是本地生成数据（`simulated: true`），会污染业务库与后续 CRM 判断。
- 修复：接一条真实通道即可，建议先接**官方自有内容评论区**（合规最干净）：`COLLECT_OFFICIAL_URL` + `COLLECT_OFFICIAL_OWNER`；随后把 `ALLOW_LOCAL_COLLECT` 置空。
- 验收：`realChannels.length > 0` 且新线索 `simulated === false`。

**B2 线索池 → CRM 断（转化断点）**
- 证据：`collect_leads` 有 `status: 'new'` 与 `POST /v1/collect/leads/:id/status`，但没有跟进记录、没有导出、没有外部 CRM 同步；服务端无 `crm` 模块。
- 影响：线索只完成"收集"，没完成"跟进 → 成交"，获客 ROI 无法计算。
- 修复：① 线索增加 `follow_ups[]`（时间/方式/结果）；② 提供 CSV 导出；③ 留 webhook/外部 CRM 适配位。
- 验收：单条线索可完成 `new → contacted → qualified → won/lost` 全流程且可导出。

**B3 成片 → 投放断（变现断点）**
- 证据：renderer 只写 `.data/out/*.mp4`，通过 `/files/...` 静态下载；无发布/投放路由，成片不回写 `store.assets`。
- 影响：剪辑是终点不是闭环，成片无法被后续投放/复盘引用。
- 修复：① 成片入 `assets`（`kind: 'video'`）；② 增加 `POST /v1/edit/jobs/:id/publish`（先做本地记录 + 外发 webhook 占位）。
- 验收：成片在素材库可见，且有一条 publish 记录。

### P1 · 会阻断上线或让参数失真

**B4 鉴权契约断（上线即断）**
- 证据：`server/index.js` 中 `API_TOKEN` 为空则全放开；前端所有请求均不带 `Authorization` 头。
- 影响：本地能跑 → 生产一设 token，所有 `/v1/*` 立刻 401。
- 修复：前端统一 `fetch` 包装注入 token（或改同源 Cookie 会话），再启用 `API_TOKEN`。
- 验收：`preflight --strict` 通过且前端在设置 token 后仍全功能可用。

**B5 GEO 上游断**
- 证据：`GEO_UPSTREAM` 为空时 `geo.js` 返回 501 `UPSTREAM_NOT_CONFIGURED`；本地模拟由 `ALLOW_LOCAL_GEO=1` 兜底。
- 影响：AI 收录排名是本地算法自说自话，不能作为选题依据。
- 修复：接 `GEO_UPSTREAM` + `GEO_TOKEN`，并关闭本地模拟。

**B6 支付通道断**
- 证据：`billing.js` 在 `PAY_GATEWAY`/`PAY_MCH_ID` 缺失时返回 `not_configured`，订单可建不可付。
- 影响：付费转化归零，且订单会堆积成"待支付"噪音。
- 修复：接入网关 + `PAY_NOTIFY_SECRET` 验签；未接入前把套餐入口置灰而非允许下单。

**B8 beatSync 参数黑洞**
- 证据：`queue.js` 指纹已纳入 `beatSync`，`renderer.js` 未实现节拍对齐（只处理 motion/transition）。
- 影响：前端开关看似生效，实际静默忽略——最伤信任的一类 bug。
- 修复：要么实现节拍检测对齐，要么从参数白名单移除并在 UI 标注"暂未支持"。

**B10 订阅不落云库**
- 证据：`billing.js` 在 `SERVICE_DB_KEY` 缺失时返回 `subscriptionWrite: 'not_configured'`。
- 影响：支付成功但订阅状态不持久，跨设备/刷新即丢失。
- 修复：配置 `SERVICE_DB_KEY`，把订阅写入做成幂等（订单号唯一键）。

### P2 · 架构级，影响扩展性

**B7 四域零串联（最大的架构债）**
- 证据：`collector.js` 不 require `queue`/`renderer`；`geo.js` 同样不连剪辑。四域只共享 `store`。
- 影响：没有"关键词 → 选题 → 文案 → 成片 → 投放"的自动管线，产品只能靠人工在模块间搬运。
- 修复：引入编排层（`pipeline.js`），用任务表驱动跨域步骤；每步可重试、可观测。

**B9 存储单实例（扩展性断点）**
- 证据：`store.js` 全量 `load()` 到内存数组，`_flush()` 整体重写 JSON；无锁、无事务、无版本号。
- 影响：加第二个实例或多 worker 进程会互相覆盖；数据量上来后每次写盘都是全量。
- 修复：抽象 Repository 接口，底层换 SQLite（单机）或 PG（多实例）；先做接口不改调用方。

**B11 素材双真相**
- 证据：前端 `matrix.js` 用 `persist` 维护素材列表；服务端另有 `store.assets`。
- 影响：清缓存/换设备后前端列表与服务端不一致，出现"看得见但渲染不了"。
- 修复：以服务端为唯一真相，前端只做缓存 + 以 `id` 对齐。

---

## 四、优化路线图

| 阶段 | 目标 | 动作 | 完成标志 |
|---|---|---|---|
| 第 1 步（先诚实） | 让断点显性化 | 清空 `ALLOW_LOCAL_COLLECT` / `ALLOW_LOCAL_GEO` | health 显示未接入，任务返回 501 而非假数据 |
| 第 2 步（先通源头） | 打通 A 流 | 接官方评论区通道 | `realChannels > 0`，线索非模拟 |
| 第 3 步（补转化） | 打通 A 流尾段 | CRM 最小闭环 + 导出 | 线索可跟进到成交 |
| 第 4 步（补出口） | 打通 B 流尾段 | 成片入素材库 + publish 占位 | 成片可被引用 |
| 第 5 步（补反馈） | 打通 C→B | GEO 变化生成选题建议，注入剪辑文案 | 看板可一键生成选题 |
| 第 6 步（可上线） | 鉴权 + 支付 + 订阅 | 前端注入 token、接支付、配 `SERVICE_DB_KEY` | `preflight --strict` 全绿 |
| 第 7 步（可扩展） | 架构升级 | Repository 抽象 + 编排层 | 支持多实例与跨域管线 |

---

## 五、一句话结论

系统的**单体内部质量不差**（能力探测、幂等指纹、fail-loud 都做得扎实），真正的短板不在代码细节，而在**边界**：向上游一个都没接、向出口一个都没开、四个域各干各的。优先补 B1/B2/B3 三个"端点"，收益远大于任何内部重构。
