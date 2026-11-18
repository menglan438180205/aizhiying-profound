# 前端与架构整改方案（2026-11）

> 对象：`aizhiying`（ProFound）全栈系统 · 前端 SPA + Node BFF
> 方法：通读 `src/`、`server/`、`scripts/`，用 Playwright 登录后逐页截图核对，
> 用脚本统计重复端点/文件哈希；结论均给出证据位置，不做推测。

---

## 一、现状事实（先量化，再动刀）

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 前端产物 | 单文件 `index.html` 1.07 MB（16 个内联脚本 + 7 个内联样式） | `scripts/build.js` |
| 前端源码 | 13 个 JS 层（约 780 KB）+ 4 层 CSS（约 170 KB）+ 133 KB 模板 | `src/js/*`、`src/css/*` |
| 后端 | 40 个 JS 模块，`server/index.js` 2 764 行；`ROUTES` 25 处注册 + if 链 13 个域 | `server/` |
| 接口世代 | `/v1/geo`（v1 调度）、`/v1/geo2`（v3 控制台）、`/v1/geop`（v2 引擎，**R4 已下线**） | 端点扫描 |
| 死代码 | `/v1/geop/*` 前端零引用（`src/` 0 命中）；`geo-console.js` **不是**死代码，它是 `/v1/geo2` 的数据层 | `src/js` 全量检索、`server/index.js:197` |
| 历史副本 | `release/geo2`、`release/geo3`、`release/lp`、`archive/legacy-server-copies-20261031`、`_cleanup_backup` 合计 1.9 MB | 目录统计 |
| 双导航 | 全局侧栏 + GEO 页内 11 模块竖栏，内容区被压到 920 px | `index.tpl.html:1564` |

---

## 二、本次已完成（可回滚的一层）

### 0. 视觉基线：营销感（2026-11 第二轮）

按“更亮、更大、更透气”的方向调整令牌与组件尺度：

- 背景：`#F7F8FD` 叠两处品牌色径向光晕（固定不随滚动），首屏更“亮”；
- 卡片：圆角 20px、内边距 20–22px、柔和双层投影，悬停上浮 2px；
- KPI：数值 34px / 750 字重、图标 34px、标签 12.5px，四卡间距 12px；
- 按钮：主按钮 40px、渐变 135°（#6C5CF0→#5B4FF0→#7C4DF0），小按钮 32px；
- 产品线入口：40px 图标、18px 内边距，像“入口卡”而不是列表行；
- 顶栏 70px，内容区留白 28/32px，最大宽度 1560px。

> 过程中发现并修复一个隐蔽问题：CSS 文件被编辑器写成 UTF-8 **带 BOM**，打包进
> `<style>` 后 BOM 会与紧随其后的 `:root{…}` 合并成非法选择器，导致整块设计令牌
> 失效（表现是所有 `var()` 变透明、卡片没边框）。已在 `scripts/build.js` 读取源文件时
> 统一 `replace(/^\uFEFF/, '')` 兜底。

### 1. UI：新增设计令牌层，收敛四代样式

`src/css/05-refresh.css`（新增，构建时排在最后，等宽选择器自然覆盖）：

- 间距阶梯 `--sp-1..8`、圆角 `8/12/16`、阴影 `1/2/3`，替代散落的 13/17/19 px 魔法值；
- 侧栏：分组标签统一 10.5 px 大写、导航项 38 px、激活态改为品牌渐变 + 轻投影；
- 顶栏：64 px 吸顶 + 毛玻璃，标题/副标题单行截断，搜索框固定 320 px；
- KPI 卡：图标 28 px、数值 26 px 等宽数字、脚注 11 px，四卡间距 12 px；
- 表格：表头 11 px 大写、吸顶、行悬停；按钮统一 36/30/42 px 三档；
- 空状态统一虚线容器 `.empty`；QA 测试助手浮层缩小并让位（不再压卡片）；
- 响应式：≤1180 px 两列、≤860 px 单列 + 抽屉侧栏。

### 2. 数据中台：去掉重复摘要层

- 删除 `.dash-hero`（与顶栏副标题、产品线入口重复的第三层宣传条）；
- `.line-strip` 三个入口去掉写死的 `128 / 24 / 46`，改为「箭头入口」，只做导航；
- KPI 与侧栏徽标改为**同源**：都由 `state.leads` 计算，0 条时徽标隐藏
  （修复「徽标 128、卡片 0」的两套数据源错觉）；
- KPI 卡 0 号从「线索总量」改为真正的「今日意向客户」，与标签一致。

### 3. GEO 页：消除双导航

`.g3-nav` 由 236 px 竖栏改为**横向标签条**（可横向滚动，11 个模块一屏可达），
内容区从 920 px 恢复到 1440 px 全宽；模块标题、操作按钮与内容同一列对齐。

### 4. 数据诚实性（R2 已完成）

| 位置 | 改造前 | 改造后 |
| --- | --- | --- |
| 趋势图 | 写死的上升曲线 + “+23.4%” 气泡 | `renderTrendChart()` 按 `created_at` 分 7 日桶绘制双线；无数据显示空态 |
| 平台分布 | 写死 38/24/22/16% | 由 `state.leads.platform` 实时统计 |
| 加微转化环 | 写死 84% / 1,846 条私信 | 由线索计算转化率；无数据显示“—” |
| AI 员工战绩 | 写死 12 / 312 / 46 / 1,551 / ¥86.4k | 替换为「数据口径」卡：线索总量、今日新增、含原始评论占比、平均意向分 |
| 侧栏徽标 | 写死 128 | 与 `state.leads` 同源，0 条时隐藏 |
| 数据来源 | 无标识 | 卡头显示「演示数据 / 实时数据」 |

### 5. 本机采集桥轮询退避（R2 已完成）

`05-collect.js` 原每 1.5–6 秒探测 `127.0.0.1:8801`，桥未启动时控制台刷满
`ERR_CONNECTION_REFUSED`。现改为：

- 失败按 8s → 16s → 32s → 60s 指数退避；
- 连续两次失败后不再请求本机地址（仅查云端设备状态），手动「重新检测」立即重试；
- 实测一次完整走查的控制台错误从 7 条降到 4 条（剩余为首轮探测，属预期）。

### 6. 验证方式

```bash
node scripts/build.js && node scripts/build.js --check   # 产物与源码一致
node start-local.js                                     # 127.0.0.1:8787/app
# Playwright 登录后逐页截图（脚本见 _audit/ui_tour.py）
```

---

## 三、问题清单（按优先级，均含证据）

> 注：历史部署碎片（`release/geo2|geo3|lp`、`archive/legacy-server-copies-20261031`、
> `_cleanup_backup`，共约 1.7 MB）已在本轮移入 `archive/deprecated-2026-11/`，
> 根目录不再出现“看不懂的旧包”；`release/` 仅保留正式打包产物。

### P0 · 数据诚实性

1. **看板混用「假数字」与「真数据」**
   `index.tpl.html` 中「私信触达 1,846 条」「AI 自动应答 84%」「AI 员工今日战绩 12 / 312 / 46」
   「+23.4%」等为静态文案，而 KPI 卡由 `renderKPIs()` 用真实 `state.leads` 覆盖 → 同屏两套口径。
   建议：全部改为数据驱动；无数据时统一显示「—」与「接入后自动统计」。
2. **侧栏徽标 128 与 KPI 0 冲突**（本次已修）。

### P1 · 架构与数据流

3. **GEO 三代并存**（R4 已收口）：`/v1/geo`（v1 调度，仅 `08-geo3.js` 的兼容层用一次
   `POST /v1/geo/tasks`）、`/v1/geo2`（控制台数据层）、`/v1/geop`（v2 引擎，前端零引用）。
   现状：`/v1/geop/*` 13 个路径模板（19 个 method+path 组合）已下线并统一返回
   `410 GONE` + `replacement: /v1/geo2`；`/v1/geo` 只保留兼容层用到的那条。
4. **`geo-console.js` 并非死代码**（原判断有误，已纠正）：它支撑 `/v1/geo2/*`
   （`server/index.js:197` 实例化），前端 `08-geo3.js` 有约 40 处调用；真正零引用的是
   `/v1/geop` 路由块。R4 只摘路由、保留数据层。
5. **采集域文件重叠**（R4 部分收敛）：`collect-comments.js` 与 `collect-likes.js`
   各自复制了 `nowIso / dayKey / rand / noteKeyOf / todayCount / nextSlot` 一套闸门工具，
   已抽到 `server/collect/ledger.js`（四份实现 → 一份）。业务闸门（正文近似去重、
   回执字段）仍留在各模块。`/v1/comments/collect` 仍被本机桥（`release/bridge-remote.js`）、
   旧单页与 4 条用例引用，**未重定向**，避免打断手动采集链路。
6. **前端直连本地桥**：`05-collect.js` 每 1.5–3 s 轮询 `127.0.0.1:8801`，未启动时
   每次失败都进 console（实测 7 条红色错误）。建议：指数退避 + 静默失败 + 桥状态徽标。

### P2 · 冗余与工程化

7. **历史副本进仓库**：`release/*`（三代构建产物）、`archive/legacy-server-copies-20261031`、
   `_cleanup_backup`。建议移出仓库或加入 `.gitignore`，仅保留 `release/current`。
8. **CSS 四层叠加**：170 KB 中同一卡片/按钮/表格定义 2–4 次；本次已用令牌层收敛，
   下一步按「tokens / layout / components / views」四层拆分并删除失效规则。
9. **构建脚本脆弱**：`build.js` 依赖「脚本块数量必须等于映射表长度」，新增 `<style>` 必须同步改表
   （本次改 `05-refresh.css` 时即遇到）。建议改为按 `<!--@bundle:path-->` 标记构建，不再按顺序配对。

---

## 四、目标架构（三层收敛）

```
前端
  shell/        布局、导航、登录（唯一入口）
  features/     collect / geo / edit / crm / billing / identity（各自 state 片段 + render）
  shared/       api（统一 fetch/鉴权/重试）、format、ui（空状态/表格/弹窗）、events
  规则：feature 之间不直接调用，只经 shared/events 与后端接口

后端
  routes/       注册表式路由（沿用现有 ROUTES，但按域拆文件）
  domains/      collect / geo / edit / billing / identity / sites（每域：service + repo + 校验）
  infra/        store（Repository 接口）、auth、config、observability
  规则：跨域只经 service，不直接读对方 JSON 文件

数据
  单一真相源：服务端 store 为准；前端只缓存 + 以 id 对齐（现状 matrix 前端另存一份素材，需对齐）
  看板：一个 /v1/overview 聚合（线索、GEO、剪辑、套餐），首屏 1 个请求
```

---

## 五、后续迭代（建议顺序）

| 轮次 | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| R1 | 视觉基线与布局重构（营销感令牌、GEO 双导航、数据诚实性） | 截图核对、构建一致 | 已完成 |
| R2 | 看板假数字清零；桥轮询退避 | 无 console 错误；数字全为真实或 — | 已完成 |
| R3 | 部署与验收指引；历史碎片隔离 | 构建/健康检查可复现 | 已完成 |
| R4 | `/v1/overview` 聚合；`/v1/geop` 下线；采集域公共账本 | 首屏 1 请求；geop 返回 410；闸门单测通过 | 已完成（见第八节） |
| R5 | 失效 CSS 删除；构建 `--extract` 防呆；状态词表归一；重复请求去掉 | CSS −7%；删除的类零引用；首屏不再重复拉 plans/summary | 已完成（见第九节） |
| R6 | 真实浏览器回归；favicon 404；KPI 全量口径 | 11 页 + 390 px 无溢出；控制台只剩桥未启动的预期失败 | 已完成（见第十节） |

---

## 六、回滚

- UI：删除 `src/tpl/index.tpl.html` 中 `refresh-style` 一行、`scripts/build.js` 中
  `css/05-refresh.css` 一行，重新构建即回到改造前。
- 数据中台：恢复 `dash-hero` 与 `.ls-num` 两段模板即可。
- R4 服务端：`/v1/overview` 与 `collect/ledger.js` 为新增文件，删除后恢复两请求版本；
  `/v1/geop` 下线属于路由行为变化，回滚需恢复 `server/index.js` 对应路由块。
- 数据文件：全程未改动 `.data/` 下任何库文件。

---

## 七、部署与验收指引（改造后）

### 1. 构建与自检

```bash
node scripts/build.js          # src/ → index.html（唯一产物，部署形态不变）
node scripts/build.js --check  # 必须输出「一致」，否则说明有人手改了 index.html
node -e "new Function(require('fs').readFileSync('src/js/01-app.js','utf8'))"   # 语法快检
node server/test/api.test.js   # 服务端 222 项（本项目 217 通过，5 项为未接支付/上游的既有断言）
node server/test/tenant.test.js # 租户计量闭环 27 项（K1 验收：任务归属 → 执行 → 各记各账）
```

### 2. 本地验收

```bash
node start-local.js                    # 127.0.0.1:8787
# 浏览器打开 http://127.0.0.1:8787/app ，用 ADMIN_PHONE/ADMIN_PASSWORD 登录
# 逐页检查：数据中台 / 评论区获客 / GEO 优化引擎 / CRM / 会员套餐 / 风控与设置
```

验收要点：卡片有白底与边框（`var()` 生效）、GEO 子导航为横向标签条、看板无写死数字、
窄屏（≤860px）无横向滚动。

### 3. 部署到线上（沿用现有流程，仅替换 index.html）

```bash
# 1) 构建产物
node scripts/build.js --check
# 2) 打包（自动剔除 .data/.build/.env 等）
bash scripts/pack-release.sh        # 或 node scripts/pack-win.js
# 3) 上传并切换（Cloudflare 隧道 / 服务器静态目录）
scp release/aizhiying-*.tar.gz root@<IP>:/tmp/
# 4) 服务端无需改动；仅静态文件 index.html 变更，刷新即生效
curl -s https://aizhiying.online/app | head -c 120     # 确认返回新页面
```

> R1–R3 的改动只集中在前端（`src/css`、`src/tpl`、`src/js`）与 `scripts/build.js`，
> 服务端零改动、不需要重启 BFF。
> **R4 起服务端有改动**：新增 `server/overview.js`、`server/collect/ledger.js`，
> `server/index.js` 下线 `/v1/geop`，`collect-comments.js` / `collect-likes.js` 改为引用账本。
> 部署需同步以下文件并重启 BFF（`deploy.ps1 -Files @('server/overview.js','server/collect/ledger.js','server/collect-comments.js','server/collect-likes.js','server/index.js','index.html')`，
> 注意 `server/collect/` 是子目录，按既有铁律先传子目录模块、再传根文件）。

### 4. 回滚（30 秒）

```bash
cp index.html.bak index.html     # 若部署前做过备份
# 或者：删掉模板里的 refresh-style 一行 → node scripts/build.js
```

### 5. 下一轮（R5）待办

- CSS 分层（tokens / layout / components / views）并删除失效规则；
- 构建改「按标记装配」（`build.js` 的 `--extract` 仍按数量配对，`ROUTES` 已用标记）；
- 采集域继续收敛（`/v1/comments/collect` 与 `/v1/collect/*` 的语义合并，需先迁移桥与旧单页）；
- 移动端 390 px 细节与暗色主题（可选）。

---

## 八、R4 记录（2026-11-09）

### 1. 首屏聚合：`GET /v1/overview`

- 新增 `server/overview.js`：纯读快照，一次返回
  `leads`（与 `/v1/collect/leads` 同行结构）、`leadStats`（total/today/week/scored/
  withOrigin/avgScore/byLevel/byStatus/byPlatform/byChannel）、`geo`（九级管线计数 +
  LLM 状态 + 企业名）、`edit`（渲染队列）、`billing`（订阅/额度）、`sources`（口径声明）。
- 单次遍历线索：列表与统计同源，避免「列表 80 条、统计按全量」被误读成两套口径。
- 子块独立容错：GEO / 计费 / 队列任一抛错只让该块为 `null`，不会把看板打成 500。
- 前端 `loadCloudData()` 改为先请求 `/v1/overview?limit=80`，失败自动回退到原来的
  `/v1/collect/leads` + `/v1/billing/summary`（服务端未升级时页面不受影响）。
  线索行映射与订阅映射各抽成一个函数，两个入口共用，避免字段再次分叉。
- 首屏阻塞请求：`auth/me + plans + overview` = 3 个（原为 4 个：`auth/me + plans +
  collect/leads + billing/summary`）。`enterApp` 末尾的 `refreshBilling()` 仍会再拉一次
  `plans + billing/summary`（用于额度条，不阻塞首屏），R5 可直接复用 `overview.billing` 去掉。

### 2. `/v1/geop` 下线

- 删除 `server/index.js` 中 `/v1/geop` 路由块（原 117 行，13 个路径模板 / 19 个
  method+path 组合），替换为 `410 GONE` + `replacement: /v1/geo2`。
- **保留 `server/geo-console.js`**：它是 `/v1/geo2/*` 的数据层（41 KB，30+ 方法），
  文档旧版把它判成死代码是错的；前端 `08-geo3.js` 约 40 处调用依赖它。

### 3. 采集域公共账本

- 新增 `server/collect/ledger.js`：`nowIso / dayKey / rand / noteKeyOf / todayCount /
  pendingJobs / nextSlot / findByKey`。
- `collect-comments.js`、`collect-likes.js` 删除各自的那一套，改为引用账本；
  节奏（45–90 s / 12–30 s）、日限（40 / 200）、失败不计日限的语义逐行保持不变。

### 4. 验证证据

| 检查 | 结果 |
| --- | --- |
| `node --check`（index.js / overview.js / ledger.js / 两个 collect 模块 / 01-app.js） | 全部通过 |
| `node scripts/build.js --check` | 一致（产物 1,080,488 B） |
| `node server/test/api.test.js` | 217/222（与改造前同基线；5 项为支付/上游未配置的既有断言） |
| `node server/test/comments.test.js` | ALL CHECKS PASSED（含 `cap=40`、`pace=[45000,90000]`、去重与回执） |
| `node server/test/llm.test.js` | ALL CHECKS PASSED（含点赞 `cap=200`、排期与步骤回传） |
| 本地实例 `GET /v1/overview` | `ok=true`，`leadStats`/`geo.stages`/`edit`/`billing` 均非空 |
| 本地实例 `GET /v1/geop/overview` | `410 GONE`，`replacement=/v1/geo2` |
| 本地实例 `GET /v1/geo2/dashboard`、`/v1/collect/leads`、`/v1/collect/comments`、`/v1/collect/likes` | 均正常（cap/pace 与改造前一致） |
| 聚合逻辑单测（假 deps：3 条线索 + 抛错模块） | 通过（统计正确、坏块降级为 `null`） |

> 沙箱说明：`api.test.js` 需要 `spawn` 子进程，默认沙箱下 `spawn EPERM`，
> 本次用一次提权跑通；这与代码无关，是运行环境限制。

### 5. 回滚

- 前端：删掉 `loadCloudData()` 里的 `/v1/overview` 分支即回到两请求版本。
- 服务端：`git`/备份恢复 `server/index.js` 的 `/v1/geop` 块（其余文件为新增，删掉不影响旧链路）；
  `collect/*` 账本删除后两个模块需同步恢复各自的内联函数。

---

## 九、R5 记录（2026-11-09）

### 1. 失效 CSS 删除（126 条规则 / −7.1%）

判定口径：选择器里**所有**类名在「模板 + 全部 `src/js` + `web/index.html`」里都查不到，
且不存在动态拼接（逐一核对了 `mx-` / `geo-` / `colsd-` / `dh-` / `ai-` / `wx-` 等前缀的
运行期构造点，均为静态字符串）。命中 126 条：

- `ai-*`（AI 员工迷你状态，已被「数据口径」卡替代）、`wx-*`（微信 RPA 已下线）、
  `phone-flow/flow-step`（旧流程条）、`geo-*`（GEO v1 旧页，现用 `g3-*`）、
  `colsd-*`、`dh-* / dash-hero / ls-num`（R1 已删除的摘要层）、`mx-step/mx-log` 等。

| 文件 | 规则数 | 字节 |
| --- | --- | --- |
| 01-base.css | 121 | 140,945 → 128,484 |
| 02-geo3.css | 2 | 12,865 → 12,705 |
| 03-geobuild.css | 1 | 11,791 → 11,641 |
| 04-skin-bright.css | 0 | 2,850 → 2,850 |
| 05-refresh.css | 2 | 12,438 → 12,178 |
| 合计 | 126 | 180,889 → 167,858（−13,031，−7.2%） |

前端产物：`index.html` 1,080,488 → 1,068,734 B（−11,754，−1.1%）。

原文件备份在 `archive/deprecated-2026-11/css-before-r5/`。

> **未达「−15%」的原因（如实说明）**：剩余体积在 JS（780 KB，注释与缩进占比高），
> 只删 CSS 不可能达到 15%。要再降只有两条路：构建期剥离注释（需 JS 词法安全的压缩器），
> 或删功能。前者列入 R6，后者不在本次范围。

### 2. 构建 `--extract` 防呆

`--extract` 原本按「脚本块数量 = 映射表长度」回捞；迁移完成后 src 才是唯一真相，
误跑会用 `index.html` 覆盖源码。现检测模板里的 `<!--@bundle:-->` 标记：命中即退出（码 2）
并提示先备份、确认后加 `--force`。实测：`node scripts/build.js --extract` → 退出 2，src 未被改动。

### 3. 状态词表归一（数据诚实性）

服务端 `collect_leads.status` 是 `new/contacted/wechat/won/lost`，前端阶段是
`new/sent/wechat/nego/deal/sleep`，此前直接 `stage = status`，导致
**「已成交(won)」在页面上显示成「新线索」**，成交数与加微转化统计不到。
现在 `mapLeadRow()` 做展示归一（`contacted→sent`、`won→deal`、`lost→sleep`），
写入值不变；未知状态原样透传（前端写入的 `sent/nego/deal` 不受影响）。

### 4. 首屏重复请求

首屏已有聚合快照时，`enterApp` 不再调用 `refreshBilling()`（它会再拉一次 `plans` +
`billing/summary`），直接渲染额度条；快照超过 30 秒或不存在时才回退到真实拉取
（防止换账号登录后看到上一个账号的额度）。

### 5. 验证证据

| 检查 | 结果 |
| --- | --- |
| CSS 花括号配对（5 个文件） | 全部相等；无 BOM |
| 被删类在「模板 + JS + web 首页」中的残留引用 | 0 |
| 模板里 339 个 class 中无 CSS 规则者 | 4 个（`cc-frow-2 / col-wrap / s1 / inp`，均为改造前既有） |
| `node scripts/build.js --check` | 一致（1,068,734 B） |
| `node --check src/js/01-app.js`、`scripts/build.js` | 通过 |
| `node scripts/build.js --extract` | 退出码 2（防呆生效），src 未变 |

### 6. 回滚

- CSS：用 `archive/deprecated-2026-11/css-before-r5/` 覆盖回 `src/css/` 再构建。
- 前端逻辑：`STATUS_TO_STAGE` 一行与 `billingAt` 判新鲜度一段可单独回退，互不影响。

---

## 十、R6 记录（2026-11-09）

### 1. 真实浏览器回归（补上 R5 缺的视觉验收）

环境里没有 playwright 的 Python 包，改用 `playwright-core`（node，复用本机 chromium-1248）
临时脚本 `_audit/r6_tour.js`：登录 → 逐页点击 → 截图 + 采集布局指标。浏览器进程受沙箱限制，
需一次提权运行（`spawn EPERM`，与代码无关）。

结果：11 个视图**全部无横向溢出**（scrollWidth = clientWidth = 1140）；侧栏 236 px、
KPI 卡白底 + 20 px 圆角、卡片投影都在 —— 说明 R5 删的 126 条规则没有误伤任何在用的样式。
390 px 下看板 / GEO / 评论区三页 `documentElement.scrollWidth = 390`，无横向滚动。

### 2. 控制台只剩预期的 4 条

原有一条 `/favicon.ico` 404（每次加载必现），已改为内联 SVG data-URI `<link rel="icon">`：
零额外请求、标签页有品牌图标。现在控制台只剩 4 条本机采集桥
`127.0.0.1:8801` 的 `ERR_CONNECTION_REFUSED`（桥未启动时的预期，代码已退避）。

### 3. KPI 改用全量口径（修「只算前 80 条」）

`state.leads` 只有前 80 条，`renderKPIs()` 却按它算总量/今日/加微/成交 → 线索超过 80 时
系统性少算。现在 `/v1/overview` 的 `leadStats` 增加 `touched / added / deals / amount`
四个聚合字段（服务端单次遍历全量线索），前端优先用它；旧服务端缺字段时整体退回本地计算，
不会出现「接口在、字段缺 → KPI 全 0」。

验证：构造 120 条（30 new / 30 contacted / 30 wechat / 20 won / 10 lost）直测
`buildOverview`：`total=120, touched=90, added=50, deals=20, amount=20000`，列表仍只回 80 条。

### 4. 验证证据

| 检查 | 结果 |
| --- | --- |
| 桌面 11 页 + 390 px 3 页 | 无横向溢出；截图见 `_audit/shots-r6/` |
| 控制台错误 | 4 条（全部为本机桥未启动的预期失败） |
| HTTP ≥400 响应 | 0 条 |
| `node --check`（01-app.js / overview.js） | 通过 |
| `build.js --check` | 一致（1,070,555 B） |
| 120 条线索聚合单测 | 通过 |

### 5. 未做（如实说明）

- 「构建期剥离注释」算过收益：JS 注释 43 KB + CSS 6.6 KB ≈ 全量 4.7%，且需要词法安全的
  JS 压缩器（正则/模板字符串误判会直接白屏），收益与风险不匹配，暂不做。
- CSS 真正分层（tokens/layout/components/views）需要按语义拆分 128 KB 的 `01-base.css`，
  没有浏览器 A/B 工具前风险大于收益，留待有视觉回归基建时再做。

---

## 十一、R7 修复记录（2026-11-09）：AI智能剪辑卡在「视频生成」

### 1. 症状

点「一键跑完 7 步」后，流程条停在「04 视频生成 · 执行中…」不再变化，成片列表无产出。
服务端侧同时是空的：`GET /v1/edit/jobs` → `jobs: []`，`storage.assets = 0`，
`.data/demo/db` 没有 `jobs.json`，`tmp/upload` 目录从未创建 —— 浏览器一个请求都没发出去。

### 2. 根因一：前端在 `fd` 声明之前就用了它（必现）

[07-matrix.js:1054](src/js/07-matrix.js#L1054) 的 `remoteCut()` 在第一个 `await` 之前调用了
`fd.append('params', …)`，而 `var fd = new FormData()` 直到「素材全部入库后」的
`.then()` 里才声明（[07-matrix.js:1256](src/js/07-matrix.js#L1256)）——这是分块上传改造时
留下的死代码。执行链：

```
remoteCut（async）同步抛 ReferenceError
  → async 转成 rejected Promise
  → proceed() 只判断返回值真假、没有 catch（07-matrix.js:889）
  → 全局 unhandledrejection 只写 obs，不弹错
  → job 仍 running、MX.wfRun 仍 'video'
  → 看门狗只检查任务状态、不检查进度，认为任务还活着
  → 「04 视频生成 · 执行中…」永久不动，且没有任何请求/日志
```

### 3. 根因二：承载 BFF 的进程无法创建渲染子进程（修完前端仍会失败）

当时的 8787 实例：`/v1/health` → `ffmpeg.ok=false`；`/v1/edit/stats` → 配音
`spawn EPERM`；`/v1/edit/samples` → 「未找到 ffmpeg」。但 `D:/ffmpeg/bin/ffmpeg.exe`
实际存在。同环境实测：`spawn(..., {stdio:'ignore'})` 可用，
`spawn(..., 管道)` 与 `fork(..., {ipc})` 均 EPERM；而渲染队列正是 `fork` + IPC
（[queue.js:42](server/queue.js#L42)），ffmpeg 探测与 `-progress pipe:1` 也需要管道。
这是承载进程被沙箱/权限限制，不是代码或 FFmpeg 安装问题。

**处置**：在普通终端运行 `start-local.cmd` 重启 BFF（不要在 DSH 沙箱里启动）。
验收：`/v1/health` 的 `ffmpeg.ok=true`、`/v1/edit/samples` 返回 6 条。

### 4. 代码改动

| 文件 | 改动 |
|---|---|
| [07-matrix.js:1054](src/js/07-matrix.js#L1054) | 删除提前的 `fd.append('params', …)`；FormData 本就在入库后才构造 |
| [07-matrix.js:889](src/js/07-matrix.js#L889) | `proceed()` 改为 `Promise.resolve(remoteCut(...)).then(...).catch(...)`；启动异常 → 标记失败 + 清理流程条 + toast + obs |
| [07-matrix.js:2039](src/js/07-matrix.js#L2039) | 看门狗增加「无进展超时」：未提交 5 分钟、已提交 8 分钟（进度与阶段都不变即判挂起） |
| `index.html` | 重新构建（`node scripts/build.js`） |
| [verify-fixes.js](scripts/verify-fixes.js) | 新增 F6 回归断言（fd 声明顺序、Promise 接住、看门狗、产物一致）；F1 在中继下线后自动跳过 |

### 5. 验证

| 检查 | 结果 |
| --- | --- |
| `node --check src/js/07-matrix.js` | 通过 |
| `node scripts/build.js --check` | 一致（1,073,322 B） |
| `node scripts/verify-fixes.js` | **27/27**（含 F6 五项） |
| 行为级切片测试（Node 打桩跑 `remoteCut`） | `uploadInit → editJob` 顺序正确；`params.assetIds=["as1"]`；拿到 `remoteId`，状态 running，无异常 |

> 行为级测试是临时 harness（未入库）：按源码切片取出 `remoteCut`，用假 `Api`
> 跑通「上传 → 入库 → 提交」并断言请求顺序与参数；修复前同一切片会在第一行
> 抛 `ReferenceError`。
> 仍需人工完成第 3 节的「普通终端重启 BFF」，否则任务会以 `fork EPERM` 失败。
