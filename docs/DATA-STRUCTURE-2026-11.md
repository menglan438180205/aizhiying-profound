# 全栈数据结构图与卡点清单（2026-11）

> 对象：AI智盈 ProFound —— 单文件前端（`src/` → `index.html`）+ Node BFF（`server/`，零依赖）+ NDJSON/JSON 文件库（`server/store.js`）。
> 画法：只画**真实存在**的表与字段；每条卡点都给出代码位置，改法按「小/中/大」标注工作量。

---

## 一、分层总览

```
┌──────────────────────────────────────────────────────────────────────┐
│  浏览器 SPA（index.html 单文件，1.07 MB）                              │
│                                                                      │
│   state.leads ── renderAll() ── KPI / 趋势 / 平台分布 / 转化环 / 台账   │
│   state.plans / state.subs / state.billingSummary ── 套餐与额度        │
│   G3 模块（08-geo3.js）── /v1/geo2/* 40+ 调用                          │
│   CC 模块（05-collect.js）── /v1/collect/*（账号/任务/评论/点赞/作品）   │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTP（Bearer 会话票 / Cookie）+ X-Tenant-Id
┌───────────────▼──────────────────────────────────────────────────────┐
│  BFF：server/index.js（2,671 行）                                     │
│  ┌────────────┬────────────┬────────────┬────────────┬─────────────┐ │
│  │ ROUTES 表驱动│ /v1/collect │ /v1/geo2   │ /v1/billing │ /v1/edit    │ │
│  │ 25 条注册   │ /v1/geo(v1) │ /v1/admin  │ /v1/plans   │ /v1/dh      │ │
│  └─────┬──────┴─────┬──────┴─────┬──────┴──────┬──────┴──────┬──────┘ │
│        │            │            │             │             │        │
│  ┌─────▼─────┐ ┌────▼─────┐ ┌────▼─────┐ ┌─────▼────┐ ┌──────▼─────┐ │
│  │collect-*  │ │geo-engine│ │geo-console│ │ billing   │ │render queue│ │
│  │sched/dev/ │ │(九级管线) │ │(11 模块)  │ │(订阅/额度)│ │+ ffmpeg    │ │
│  │comments/  │ │          │ │          │ │           │ │            │ │
│  │likes/acc  │ │          │ │          │ │           │ │            │ │
│  └─────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘ └──────┬─────┘ │
└────────┼────────────┼────────────┼─────────────┼──────────────┼───────┘
         │            │            │             │              │
┌────────▼────────────▼────────────▼─────────────▼──────────────▼───────┐
│  Store（每表一个文件，`.data/db/<table>.json|ndjson`）                 │
│  39 张表：json 28 张（整表重写） + ndjson 11 张（追加 + 按 key 去重）    │
└───────────────────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │ 只有本机桥（127.0.0.1:8801）能领活    │ 外部上游
┌────────┴─────────┐              ┌───────────┴──────────────┐
│ Chrome 扩展 + 桥  │              │ 采集上游 / GEO 上游 /      │
│ （用户自己的登录态│              │ 支付回调 / LLM 服务        │
│  与住宅 IP）      │              └──────────────────────────┘
└──────────────────┘
```

---

## 二、存储层：39 张表按域分组

| 域 | 表 | 类型 | 键 / 容量 | 谁写 | 谁读 |
|---|---|---|---|---|---|
| 渲染 | `jobs` | json | — | 渲染队列 | 剪辑页、死信视图 |
| | `assets` | json | — | 上传/示例素材 | 剪辑、矩阵 |
| | `events` | json | — | 全局事件、错误 | SSE `/v1/events`、运维 |
| 采集 | `collect_tasks` | json | — | 目标 CRUD | 调度器 |
| | `collect_runs` | ndjson | `id` / 300 | 每次执行 | 运行明细、账号统计 |
| | `collect_leads` | ndjson | `id` / **5000** | 执行结果入池 | 台账、看板、CRM、概览 |
| | `collect_fp` | ndjson | `fp` / 60000 | 去重账本 | 入池前查重 |
| | `collect_accounts` | json | — | 账号 CRUD | 采集页、任务绑定 |
| | `collect_devices` | json | — | 设备配对/心跳 | 桥状态、任务下发 |
| | `collect_jobs` | ndjson | `id` / **600** | DeviceHub 队列 | 桥领活、过程回传 |
| | `collect_notes` | ndjson | `key` / 1500 | 作品回传入库 | 评论/点赞卡片 |
| | `collect_comments` | ndjson | `noteKey` / 2000 | 拟稿/回执 | 评论区台账 |
| | `collect_likes` | ndjson | `noteKey` / 2000 | 点赞/回执 | 作品卡片 |
| GEO（v1 调度） | `geo_tasks` / `geo_points` / `geo_changes` | json | — | GeoScheduler | GEO 页 |
| | `geo_runs` | ndjson | `id` / 400 | 每次监测 | 趋势、报表 |
| GEO v2/v3 | `geo_org` `geo_packs` `geo_assets` `geo_dists` `geo_reports` | json | — | GeoEngine / GeoConsole | 控制台 11 模块 |
| | `geo_sites` `geo_channels` `geo_pubq` `geo_snaps` `geo_diag` `geo_tenants` `geo_settings` `geo_kb` | json | — | GeoConsole | 控制台 |
| 计费 | `billing_subscriptions` | json | — | 下单/试用/回调 | 额度、套餐页 |
| | `billing_wallets` | json | — | 加量包 | 额度 |
| | `billing_usage` | ndjson | `id` / 5000 | `billing.charge` | 月用量、扣额 |
| | `billing_ledger` | ndjson | `id` / 2000 | 支付流水 | 账单 |
| | `orders` | json | — | 下单/回调 | 订单页 |
| LLM | `llm_cfg` | json | 数组 | 后台模型配置 | 全站 LLM 调用 |
| 数字人 | `dh_avatars` / `dh_sessions` | json | — | 形象/会话 | 数字人工作台 |
| | `dh_renders` | ndjson | `id` / 500 | 渲染 | 成片库 |
| 账号 | `users`（`users.ndjson`，独立于 SCHEMA） | ndjson | 手机号 | 注册/管理员种子 | 登录、会话票 |

### 关键关系（外键都是「字符串约定」，数据库不校验）

```
collect_tasks.id ──┐
                   ├─→ collect_runs.id ──→ collect_leads.id ──→ collect_fp.fp（指纹去重）
collect_accounts.id┘                              │
                                                  ├─→ collect_jobs.id（kind=comment|like）
                                                  └─→ collect_comments.noteKey / collect_likes.noteKey
                                                          │
collect_notes.key（platform|note_id）←──────────────────────┘
billing_subscriptions.tenant ─→ billing_usage.tenant ─→ billing_wallets.tenant ─→ orders.tenant
geo_assets.id ─→ geo_dists.assetId ─→ geo_pubq.assetId ─→ geo_reports
users.phone ─→ 会话票(HMAC) ─→ 请求头 Authorization
```

---

## 三、五条主链路

### 3.1 评论/点赞（对外写，风险最高）

```
页面点「评论」
  │ POST /v1/collect/comments        （拟稿 AI / 模板）
  ▼
collect_comments(noteKey, status=pending, notBefore=T+n)
  │ DeviceHub.enqueue(kind=comment)   ← 全局节奏：45–90s，日限 40
  ▼
collect_jobs(status=pending, notBefore)
  │ 本机桥轮询 /v1/plugin/poll（一次只领一个活）
  ▼
Chrome 扩展：打开作品页 → 定位输入框 → 填 → 点发送 → 每步上报 progress
  │
  ▼
回执：collect_jobs.done → collect_comments.status=sent/failed(+reason)
```
点赞同构，节奏 12–30s、日限 200，共用同一队列（天然互斥）。

### 3.2 GEO 控制台（v3，当前唯一前端链路）

```
08-geo3.js ──GET /v1/geo2/dashboard──→ geo-console.dashboard()
   ├─ 探针：geo_snaps（快照）+ geo_channels（渠道）
   ├─ 内容：geo_assets（资产）→ audit → publish → geo_pubq（发布队列）
   ├─ 站点：geo_sites → check
   └─ 报表：geo_reports / geo_diag / geo_tenants / geo_settings / geo_kb
（/v1/geo v1 只留 tasks/monitor 兼容；/v1/geop 已 410 下线）
```

### 3.3 计费

```
下单 → orders(pending) → 支付回调 → billing_subscriptions(active, quota)
所有消耗 → billing.charge(tenant, kind, qty) → billing_usage → summary().left
```

### 3.4 剪辑渲染

```
上传（分块 /v1/edit/upload/*）→ assets → jobs(queued) → RenderQueue(worker) → ffmpeg → 成片
失败 → 死信（job.error + /v1/edit/stats 死信视图），可重试
```

### 3.5 鉴权与租户

```
登录：POST /v1/auth/login（手机号+密码）→ HMAC 会话票（30 天，API_TOKEN 作密钥）
请求：Authorization: Bearer <票> 或 HttpOnly Cookie
租户：X-Tenant-Id 请求头（缺省 default）
```

---

## 四、卡点清单（按影响排序，均含证据）

### K1 · 多租户计量写死 `default`（P0，安全/计费）

- **证据**：`server/index.js:181`、`:234` —— `meter: (kind, qty, meta) => billing.charge('default', kind, qty, meta)`。
- **现象**：GEO 监测、采集计量全部记到 `default` 租户；`billing.summary(tenantOf(req))` 按真实租户读，于是**A 客户消耗、B 客户看到/扣的是 default 的额度**（目前只有单租户在用，所以没暴露）。
- **改法（小）**：`meter` 改为从任务上下文取 owner——`collect_tasks` / `geo_tasks` 落库时加 `tenant`，执行时 `charge(task.tenant || 'default', …)`；`billing.charge` 前补一次 `tenant` 白名单校验。
- **验收**：两个 tenant 各跑一次采集，`billing_usage` 里各记各的。

### K2 · 租户隔离不是安全边界（P0，越权）

- **证据**：`server/index.js:634-640` —— `tenantOf(req)` 直接读 `x-tenant-id`，不校验它属于当前登录人；`:523` 用它查额度。
- **现象**：任何已登录用户改一个请求头即可读写别的租户数据（`/v1/tenants` 还能列出各表记录数）。
- **改法（中）**：会话票里加 `tenant`（或用户→租户绑定表），`tenantOf()` 只在 `ADMIN` 身份下接受覆盖；所有按租户查询改为「以票为准」。`/v1/tenants` 限管理员。
- **验收**：用 A 的票带 `X-Tenant-Id: B`，返回 403。

### K3 · 线索池 5000 条上限 + 每次请求全量扫描（P1，性能/容量）

- **证据**：`server/store.js:47`（`collect_leads` cap 5000）；`server/collect-sched.js:677-758`（`stats()` 里 4 次遍历 leads）；`/v1/collect/leads`（`index.js:1866`）每次请求整表过滤；`/v1/overview` 同样全量。
- **现象**：到 5000 条后旧线索被淘汰（`collect_fp` 保留指纹所以不会重复入池，但**历史不可查**）；每次看板刷新把所有线索在内存里扫 4–5 遍（O(n)），5k 条尚可、5 万条内存与 CPU 都会成瓶颈。
- **改法（中）**：① 把统计改为增量（入池时累加计数，`stats()` 读计数）；② 列表接口加游标分页（`?after=<id>&limit=`），前端台账/CRM 接分页；③ 需要历史时把 `collect_leads` 按日分片（`collect_leads-YYYYMM`）。
- **验收**：5 万条时 `/v1/overview` P95 < 50 ms；台账可翻到第 2 页。

### K4 · 前端只取前 80 条线索，页面没有分页（P1，功能缺口）

- **证据**：`src/js/01-app.js` —— `/v1/overview?limit=80` / `/v1/collect/leads?limit=80`；台账 `renderLeadTable()` 只渲染 `state.leads.slice(0, 6)`，CRM 表同样基于 `state.leads`。
- **现象**：线索 >80 时，台账/CRM/看板明细都只显示前 80；KPI 已在 R6 改为全量口径，所以**卡片总数与列表条数会对不上**（容易被当成 bug）。
- **改法（中）**：接 K3 的分页接口；列表底部加「加载更多/总数 N」，CRM 加筛选（阶段/平台/关键词）。
- **验收**：120 条数据时，卡片显示 120，列表能翻到第 120 条。

### K5 · 状态词表两套并存（P1，数据一致性）

- **证据**：服务端枚举 `server/index.js:1595`（`new/contacted/wechat/won/lost`）；前端枚举 `src/js/01-app.js:29`（`new/sent/wechat/nego/deal/sleep`）；`05-collect.js` 的 `setStage` 直接写自己的词表。
- **现象**：库里同时存在 `contacted` 与 `sent`、`won` 与 `deal`；R5 只做了**展示归一**，写入仍各写各的。
- **改法（中）**：定一套枚举（建议服务端 5 值），在 `/v1/collect/leads/:id/status` 做白名单校验并返回 400；前端提交前映射；做一次迁移脚本把 `sent→contacted`、`nego→contacted`、`deal→won`、`sleep→lost`（保留原值到 `statusRaw` 便于回滚）。
- **验收**：全库 `byStatus` 只剩 5 个键。

### K6 · 采集吞吐被单通道串行卡死（P1，容量）

- **证据**：`server/collect-devices.js:241-253`（`claimNext` 一次只发一个活）；`collect-comments.js:22-25`（45–90 s）；`collect-likes.js:19-22`（12–30 s）。
- **现象**：单台设备约 45–60 分钟就能吃满 40 条评论日限，但第二台设备没有独立配额；多台设备时排期仍以全局 `notBefore` 最后一条为准（`ledger.nextSlot` 扫全表），第二台设备领活要等。
- **改法（中）**：① 排期改为「按设备」维护 `lastAt`，`nextSlot` 只看本设备；② 日限按设备/账号拆分（`collect_accounts` 已有配额字段）；③ 桥侧支持并发 2–3 个标签页（平台风控允许的前提下）。
- **验收**：双设备时吞吐 ≥ 1.8×；单设备日限不超。

### K7 · NDJSON 追加表的写放大（P2，性能）

- **证据**：`server/store.js:254`（json 整表重写）、`:291`（ndjson 压缩时整表重写）；`upsert` 每次改一条记录会重写整表。
- **现象**：`collect_leads` 满 5000 条时，每入池一条线索都要整表重写（约 1 MB 量级）；`collect_jobs` 600 条同理。采集高峰（每分钟几十条）会持续占 I/O。
- **改法（中）**：改成「追加写 + 定期压缩」——`upsert` 只追加一行（后写覆盖），压缩交给定时任务（如每 500 条或每 10 分钟），并把压缩放到 `setImmediate` 不阻塞请求。
- **验收**：5000 条时单次 upsert 写字节 < 2 KB。

### K8 · 服务端有 SSE，前端全在轮询（P2，请求数/实时性）

- **证据**：`server/index.js` `/v1/events`（`sseAttach`）+ `sseBroadcast`；`src/` 中 `/v1/events` 命中 **0 处**；实际用 `setInterval` 轮询（评论区 2.5 s / 空闲 25 s）。
- **现象**：每个打开的页面每 2.5 s 一次 `comments list`，多标签页时请求数线性增长；实时性反而靠轮询间隔。
- **改法（中）**：评论区/采集任务改订阅 SSE（`EventSource` 带 `?token=`，服务端已支持查询参数携带令牌），轮询只做兜底（60 s 一次校准）。
- **验收**：单页打开时 `/v1/collect/comments` 请求数下降 80% 以上。

### K9 · `/v1/geo` v1 仍可写（P2，架构债）

- **证据**：`server/index.js` 中 `seg[1] === 'geo'` 分支仍保留 `tasks` 的 GET/POST/PATCH/DELETE 与 `monitor`/`manual` 写接口；前端只在 `08-geo3.js:1213` 的兼容层用一次 `POST /v1/geo/tasks`。
- **现象**：三代接口收敛后仍留一条可写老链路，字段与 geo2 不同，回归时容易漏。
- **改法（小）**：v1 写接口改为 410（同 `/v1/geop` 的处理），只保留 `GET /v1/geo/tasks` + `GET /v1/geo/overview` 只读；兼容层那一次调用迁到 `/v1/geo2`。
- **验收**：`POST /v1/geo/tasks` 返回 410；GEO 页面功能不变。

### K10 · 计费扣减缺少幂等键（P2，资损）

- **证据**：`billing.charge()` 直接追加 `billing_usage`（`billing.js:322` 附近的 `usageRows`），无 `requestId` 唯一约束；`orders` 有幂等，但「按次计量」没有。
- **现象**：上游超时重试（GEO 探针、渲染提交）可能重复记一次用量。
- **改法（小）**：`charge()` 增加可选 `dedupeKey`，写入前查最近 10 分钟同 key；调用点用 `job.id` / `run.id` 作 key。
- **验收**：同一 job 重试两次，`billing_usage` 只多一条。

---

## 五、建议的修改顺序（每批可单独回滚）

| 批次 | 内容 | 覆盖卡点 | 风险 |
|---|---|---|---|
| 第 1 批 | 租户绑定进会话票 + `meter` 取任务 owner + `/v1/tenants` 限管理员 | K1、K2 | 中（鉴权路径） |
| 第 2 批 | 状态枚举统一 + 迁移脚本 + 写入校验 | K5 | 中（要迁移数据） |
| 第 3 批 | 线索列表分页 + 前端「加载更多」；`stats()` 改增量计数 | K3、K4 | 中（前后端同时改） |
| 第 4 批 | 排期按设备 + 桥并发；SSE 替换轮询 | K6、K8 | 中（采集链路） |
| 第 5 批 | upsert 追加写 + 定时压缩；`charge` 幂等键；v1 写接口 410 | K7、K9、K10 | 小 |

> 排序理由：K1/K2 是**越权与计费**问题，先修；K5 修完才能让 K3/K4 的统计与分页口径稳定；K6/K8 影响体验与成本但不动数据模型；第 5 批都是局部改动，随迭代顺手做。

---

## 六、一句话总结

结构上是「一个进程 + 39 张文件表 + 一条本机采集桥」，链路清晰。卡点按优先级收敛后：
**租户身份已绑定到票与数据**（K2 + K1 已修）、**状态词表已统一**（K5 已修）；
剩下的结构化问题是**全量扫描 + 只回 80 条的列表模型**（K3/K4）与**采集/写放大**
（K6/K7/K8），它们决定容量与体验上限，不影响权限与计费正确性。

---

## 七、落地记录（2026-11-09，第一批）

| 卡点 | 状态 | 实际改动 / 证据 |
|---|---|---|
| K5 状态词表 | **已修** | `/v1/collect/leads/:id/status` 加白名单 `new/contacted/wechat/won/lost`；历史值归一（`sent/nego→contacted`、`deal→won`、`sleep→lost`），原值存 `statusRaw`；错值返回 400 `INVALID_STATUS`。实测：`sent → 200 且落库为 contacted`；`bogus → 400`。 |
| K10 计费幂等 | **已修** | `billing.charge` 支持 `meta.dedupeKey`，10 分钟内同 key 只记一次，返回 `deduped:true`。单测：同一 key 连扣两次，`monthUsage.leads` 只 +10（总 20）。 |
| K9 v1 写接口下线 | **暂缓（降级为弃用标记）** | 先按方案做成 410，结果 `api.test.js:597` 明确断言 `PATCH /v1/geo/tasks/:id` 生效，回归直接中断。说明 v1 写不是死代码：前端兼容层 + 用例都还在用。已改为响应头 `X-Deprecated-Api: /v1/geo -> /v1/geo2`，**不改行为**；下线前必须先迁兼容层并改用例。 |
| K1/K2 租户 | 已修（见第八节） | K2：会话票带 `tenant`；K1：任务落 `tenant` + 执行按任务计量。第一批时仍待做，第二/三批完成。 |
| K3/K4 分页与统计 | 待做 | 前后端同时改（列表游标 + 增量计数），单独一轮。 |
| K6 采集吞吐 | 待做 | 排期按设备 + 日限按账号，需双设备实测。 |
| K7 写放大 | 待做 | `store.upsert` 改追加 + 定时压缩，牵动所有 ndjson 表，需压测。 |

**回归基线**：`server/test/api.test.js` **217/222**（与改造前完全一致，5 项为支付/上游未配置的既有断言）。



---

## 八、落地记录（第二、三批：K1 / K2）

### K2 · 租户绑定进会话票（已修）

- `server/auth.js`：签发时把 `tenant` / `role` 写进票（老账号无字段则不写，读侧回落 default）；新增 `claims(token)` 供服务端读票内声明。
- `server/index.js:tenantOf()` 改为三级判定：
  1. 未启用鉴权（`API_TOKEN` 为空，本地/演示）→ 请求头优先，开发便利不变；
  2. 持有 `API_TOKEN`（运维/管理员）→ 允许 `X-Tenant-Id` 显式指定；
  3. 普通会话票 → **以票内 tenant 为准，请求头一律忽略**。
- 实测（`API_TOKEN=secret-test-token`）：
  `Bearer <会话票> + X-Tenant-Id: evil` → `tenant=default`；
  `Bearer secret-test-token + X-Tenant-Id: evil` → `tenant=evil`；
  不带请求头 → 正常。
- 未做：`/v1/tenants` 仍是任意登录用户可读（记录数），下一批随 K1 一起收成管理员专用。

### K2 收尾 · `/v1/tenants` 限管理员（已修）

- 该端点会列出 39 张表各自的记录数，此前任何登录用户可读（侧信道）。
- 现在只认：`API_TOKEN`（运维）、Cookie 里的 API_TOKEN、或票内 `role=admin`；其余 403。
- 实测：会话票 → `403 FORBIDDEN`；管理员令牌 → `200` + 39 张表。

### K1 · 计量租户闭环（已修，第三批）

**问题回顾**：`meter` 虽然改成了读 `meta.tenant`，但 `collect_tasks` / `geo_tasks` 没有 `tenant`
字段，调度执行时拿不到归属，用量还是全部记到 `default`（A 客户消耗、B 客户看到/扣的是
default 的额度）。这一批把「任务归属 → 执行 → 用量」整条链接上。

**闭环改动**：

| 环节 | 文件 | 改动 |
|---|---|---|
| 标识收敛 | `server/tenant.js`（新增） | `valid()/norm()/ofTask()`：1–64 位字母/数字/中文 + `._:@-`，非法回落 `default`；`backfillTasks()` 幂等补存量 |
| 任务落归属 | `server/index.js` | 建采集/GEO 任务时写入 `tenant: tenantOf(req)`，客户端自报的 `tenant` 被服务端覆盖；`tenantOf()` 统一走 `norm()` |
| 执行带归属 | `server/collect-sched.js`、`server/geo.js` | `run` 记录 `tenant`；计量 `meta.tenant = run.tenant`（GEO 优先取任务自身的 tenant，管理员代跑也记任务主） |
| 计量校验 | `server/billing.js` | `charge()` 先做租户白名单，非法直接返回 `BAD_TENANT`，**不静默改记 default**；`summary/create/startTrial` 统一 `norm()` |
| 存量迁移 | 启动时 + `scripts/backfill-tenant.js` | 启动自动补缺失的 `tenant=default`；脚本支持 dry-run（默认）与 `--apply` |

顺带打通的三个点：

- `collect_leads` 落 `tenant`，线索能对账「这条是谁的额度」；
- GEO 控制台探针 `POST /v1/geo2/probes/run` 自动新建的监测任务也落在调用方租户（`ensureProbe(word, tenant)`）；
- 计量带 `dedupeKey`（`collect:<runId>` / `geo:<runId>`），同一轮被重复结算只记一次（补全 K10 的调用点）。

**验收**（新增 `server/test/tenant.test.js`，**27/27 通过**）：

```
ok  存量 collect_task 启动时补 tenant=default
ok  采集任务按票内租户落库（伪造 X-Tenant-Id 无效）  → tenant=acme
ok  管理员可用 X-Tenant-Id 代建任务                  → tenant=beta
ok  PATCH 不能改写任务租户
ok  A 租户任务执行成功且 run.tenant=acme             → fresh=5
ok  B 租户任务执行成功且 run.tenant=beta             → fresh=5
ok  A / B 的线索分别标 acme / beta
ok  acme 的 leads 用量 = 自己这轮的 5 条；beta 同理
ok  default 没有被别的租户扣走额度                   → 0
ok  GEO 监测 run.tenant=acme                         → covered=6
ok  acme 的 geo 用量 +1，beta 不受影响
ok  探针自动建的监测任务归 beta，用量也记 beta
ok  非法租户标识被计费层拒绝（空格/符号、__proto__） → BAD_TENANT
ok  迁移脚本 dry-run 不写盘；--apply 补 default 且不动已有值
```

**回归**：`server/test/api.test.js` 仍为 **217/222**，5 个失败项与改造前完全相同
（支付未配 ×3、采集上游未配 ×1、通道清单文案 ×1）。

**残留（不属 K1，下一批处理）**：

1. 线索池 / 看板仍是全局读，不按 `tenant` 过滤 —— 与 K3/K4 的分页、增量统计一起改；
2. 同关键词的采集任务与 GEO 监测仍是全局唯一（跨租户会 409，或共用一条监测任务、计量归任务主）—— 与 K6 的排期按设备一起设计；
3. 租户 id 是**格式**白名单而非注册表，新租户首次调用走 grace 记账（有意为之，否则第一笔用量就丢）；
4. 账号的 `tenant` 目前只能直接编辑 `DATA_ROOT/users.ndjson` 分配（没有用户管理界面），管理员代操作用 `API_TOKEN + X-Tenant-Id`。

**迁移操作**：

```bash
node scripts/backfill-tenant.js            # 只体检，不写盘
node scripts/backfill-tenant.js --apply    # 写盘（幂等，可重复执行）
```

服务启动时也会自动补一次（`server/index.js` 里 `tenantMod.backfillTasks(store)`），
两个入口都只补缺失值，不覆盖已有 `tenant`。
