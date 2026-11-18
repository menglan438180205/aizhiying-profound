# ProFound / AI智盈 · 文件梳理与冗余处理报告

> 项目根目录：`C:\Users\ALIENWARE\WorkBuddy\2026-10-03-11-48-46`
> 执行时间：2026-10-29
> 性质：只读梳理 + 冗余清理 + 已验证的缺陷修复
> 验证基线：`node server/test/api.test.js` → **222/222 通过**；`node scripts/verify-fixes.js` → **25/25 通过**

---

## 0. 一句话结论

技术底座扎实（零 npm 依赖、能力探测、幂等指纹、生产守卫、真渲染端到端测试都在位），
**真正的短板是「失败被静默吞掉」**——系统会在采集失败、渲染失败、上游改版时**照样报成功**，
用户拿到的是空名单或坏成片。这比崩溃危险得多，因为它不报错。

本轮已完成：文件全量梳理、**740M → 112M** 冗余清理、**5 项 P0 缺陷修复**并全部验证通过。

---

## 1. 文件地图

### 1.1 规模

| 项 | 数值 |
|---|---|
| 清理前体积 | **740 MB** |
| 清理后体积 | **112 MB**（释放 628 MB，↓85%） |
| 文件总数 | 329 |
| 服务端代码 | 8,348 行（零 npm 依赖） |
| 前端 | `index.html` 16,577 行单文件 + `src/` 6 个只读镜像 |
| 根目录文档 | 7 份 |

### 1.2 分层与职责

| 路径 | 体量 | 性质 | 权威性 |
|---|---|---|---|
| `index.html` | 878 KB | 前端唯一权威源（6 个内联脚本层） | ⭐ **唯一真相** |
| `src/` | 489 KB | `index.html` 的只读镜像，`extract-src.js` 生成 | 派生，禁止手改 |
| `server/` | 17 M | Node 原生 HTTP BFF + 领域层 | ⭐ 权威 |
| `server/collect-adapters/` | 33 K | 4 通道采集适配 + 归一化 | ⭐ 权威 |
| `server/edit-capabilities/` | 28 K | TTS / 字幕能力插件 | ⭐ 权威 |
| `server/test/` | 76 K | 端到端真渲染测试（222 用例） | ⭐ 权威 |
| `.data/` | 18 M | 运行时数据（业务库 + 演示库 + 成片） | 运行时 |
| `release/` | 76 M | 部署产物 + 离线 FFmpeg（78 MB，必需） | 产物 |
| `scripts/` | 64 K | 构建 / 校验 / 打包 / 诊断 | 工具 |
| `deploy/` + `nginx/` | 107 K | 部署脚本与反代配置 | 运维 |
| `.github/workflows/ci.yml` | 7 K | CI 六道关卡 | ⚠ 见 P0-5 |

### 1.3 四条业务流与断点

```
A 获客流  评论源 → collector(4通道选路) → collect-sched(去重入池) → 线索池 → ✂ CRM/跟进
B 剪辑流  素材 → queue(指纹幂等) → renderer(TTS+字幕+amix+FFmpeg) → out/*.mp4 → ✂ 投放
C GEO 流  GEO上游 → geo(排名采集) → geo_changes看板 → ✂ 内容回灌
D 计费流  下单 → 订单 → ✂ 支付网关 → ✂ 订阅云库
```

**四域并列，互不调用，只共享 store** —— 没有「关键词 → 选题 → 文案 → 成片 → 投放」的自动管线。
这是架构级技术债（B7），本轮未动，建议作为下一阶段主线。

---

## 2. 已修复的缺陷（5 项 P0，全部验证通过）

### P0-1 · X-Forwarded-For 伪造绕过限流 → 短信费用可被刷

| 项 | 内容 |
|---|---|
| **位置** | `server/cloud-relay.js:86-90`（原实现） |
| **原代码** | `const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();` |
| **问题** | 直接取 XFF **首值**作为限流分桶键。①直连服务时客户端自带 `X-Forwarded-For` 即可每次换 IP 绕过限流；②即使在 Nginx 后，Nginx 用 `$proxy_add_x_forwarded_for`（把客户端自带头**追加**在后面），首值依然是客户端可控的 |
| **后果** | 验证码接口限流 6 次/分/IP 完全失效 → 真实短信费用被刷 |
| **修复** | 新增 `TRUST_PROXY` 开关（**默认关闭**）：未声明时一律用 `socket.remoteAddress`（协议层事实，不可伪造）；声明后取 XFF **最右侧**（Nginx 依 `$remote_addr` 追加的可信值） |

### P0-2 · 上游结构漂移静默返回空数组 → 空名单被当成成功

| 项 | 内容 |
|---|---|
| **位置** | `server/collect-adapters/normalize.js:29`（原 `if (!arr) return [];`） |
| **链路** | `http-provider.js:102` → `normalize.js:29` → `collect-sched.js:321-324` |
| **问题** | 上游改版（壳层改名 / 字段改名）时，服务收到 200 + 认不出的 JSON，直接 `return []`；任务记 `status='ok'`、note 写「本轮无新增」 |
| **后果** | **销售看到「采集成功」，线索池是空的** —— 这就是砸口碑的故障类型 |
| **修复** | 新增 `normalizeDetailed()`，区分四种状态：<br>`ok`（正常）/ `empty`（合法空列表）/ `shape_changed`（结构漂移）/ `invalid_body`（空体非 JSON）。<br>`http-provider.js` 把后两者转成显式 **502 `UPSTREAM_SHAPE_CHANGED`**，任务记 failed |

### P0-3 · 采集空结果记为成功

| 项 | 内容 |
|---|---|
| **位置** | `server/collect-sched.js:336-339`（原无条件 `status: 'ok'`） |
| **修复** | 新增 `empty` 状态；上游 0 条 → `status='empty'` + `reason='NO_ITEMS'`；日志级别 warn；HTTP 码 502（前端必须能与成功区分） |
| **前端同步** | `index.html` 的 `STATUS_META` 增 `empty: {tag:'amber', text:'无数据'}`；任务卡与运行记录均显示「未采到线索（不等于成功）」 |

### P0-4 · 素材路径穿越 → 任意文件可被复制进成片

| 项 | 内容 |
|---|---|
| **位置** | `server/queue.js:340-359`（原 `_resolveAssetFile`） |
| **问题** | `a.path` 被无约束 `path.resolve()` 后直接进 `copyFileSync`；`a.file` 未净化目录成分。两者都来自存储层（历史数据 / 迁移库 / 未来导入功能），属外部可影响输入 |
| **后果** | `../` 可把根目录之外的文件复制进成片目录 → 既能读任意文件，也可能把服务器敏感文件带进**可下载的成片** |
| **修复** | 新增 `_within(root, p)` 根目录约束 + `_assetRoots()` 允许根清单；`a.path` 必须落在允许根内，`a.file` 只取 `path.basename()` 后再拼接（`../` 天然失效）；存在性检查后再过一遍根目录闸 |

### P0-5 · 渲染失败仍报成功

| 项 | 内容 |
|---|---|
| **位置** | `server/renderer.js:348-354 / 363-383`、`server/queue.js:305-312` |
| **问题 1** | 音轨封装失败降级时**固定复制 `body.mp4`**——但 `body.mp4` 是**未烧字幕**的中间体，字幕烧在 `subbed.mp4` 上。降级会丢掉已烧好的字幕 |
| **问题 2** | `probe` 失败就用估算宽高/时长顶上，**无 `stat.size` 校验** → 0 字节半成品算成功 |
| **问题 3** | `audio: true` 硬编码 → 静音成片也显示「有配音」 |
| **问题 4** | 字幕烧录失败只 warn，`media.subtitle.ok` 仍为 true |
| **问题 5** | `queue.js` 无条件 `status='done'`，**不校验产出条数是否达 `count`** |
| **修复** | 降级时优先复制 `subbed.mp4`；新增 `MIN_OUTPUT_BYTES = 1024` 与 probe 强制校验，不满足直接抛错判失败；`audio`/`voice` 改为反映真实值；字幕失败时 `subtitle.ok=false`；queue 校验产出条数（0 条或少于期望即失败） |

### 附加修复

| 位置 | 问题 | 修复 |
|---|---|---|
| `server/store.js:201-212` | NDJSON 追加无 fsync → 崩溃丢失最后几行（往往正是刚采到的线索） | 加 `fsyncSync` |
| `server/store.js:125-145` | 坏行被静默丢弃却仍计入 `_lines` → 计数漂移、压缩提前触发 | 只计可解析行，坏行单独 warn |
| `server/collect-sched.js:304` | 时间缺失回落 `new Date()` → 旧线索看起来刚发布，误导销售判断新鲜度 | 留空（`'unknown'`），不再伪造 |
| `server/collect-adapters/normalize.js:36` | 同上 | `at` 留空 |

---

## 3. 未修复的问题（按优先级）

### P0-6 · CI 六道关卡有五道依赖已删除的 `.build/`

`.github/workflows/ci.yml` 引用 **14 个全部不存在**的文件：

```
.build/runtime.js  .build/collector.js  .build/matrix.js  .build/geo.js
.build/patch_runtime.py  .build/patch_matrix.py  .build/patch_geo.py
.build/patch_collector_sched.py  .build/patch.py
.build/runqa_rt.py  .build/runqa.py  .build/runqa_mx.py  .build/runqa_geo.py  .build/runqa_real.py
```

→ **CI 必挂**（第 2 关「拼装幂等性」第一步就失败）。`.build/` 目录已不存在。
**动作**：要么补回 `.build/`（若仍用 Python 拼装流程），要么重写 CI 改用 `scripts/extract-src.js` + `scripts/check-sync.js --strict` + `server/test/api.test.js` + Playwright 替代 runqa_*。

### P0-7 · 整个项目没有版本控制

`git status` → `fatal: not a git repository`。**所有改动不可回滚**——这次清理前我只能靠手工备份兜底。
**动作**：`git init` + 首次提交（先按下面修好 `.gitignore`）。

### P1 · 关键业务规则未实现

| 缺口 | 位置 | 影响 |
|---|---|---|
| **手机号/联系方式格式校验** | `collect-sched.js:367-385`（线索结构里连 `phone` 字段都没有，只存评论原文） | 「手机号 1 开头 11 位、每品牌不超过 2 个」这类需求无法校验，脏数据直接进池 |
| **每品牌/每关键词配额 ≤N** | `collect-sched.js:41`（`MAX_LEADS=5000` 定义后未在本文件生效） | 配额要求落不了地 |
| **去重指纹过短** | `collect-sched.js:96-100`（`platform\|nickname\|comment` 前 80 字，不含作品/时间） | 同人同文案跨作品被判重复 → **漏线索** |
| **匿名用户互相误判** | `normalize.js:32` + `collect-sched.js:301`（缺失昵称统一填 `'匿名用户'`） | 多个匿名用户同文案 → 误判重复 |
| **字段别名过多导致重复入库** | `normalize.js:32`（`nickname/user/author/username`） | 上游换键即同一人算两条 |
| **响应体无超时** | `http-provider.js:100-102`（`clearTimeout` 在 `await res.json()` **之前**执行） | body 挂起则永不超时 → tick 卡死、`running` 永久 true |
| **连接未关闭** | `http-provider.js:92,102` | JSON 解析失败时 body 未消费也未 abort → socket 不归还池 |

### P2 · 架构债

| 缺口 | 说明 |
|---|---|
| **四域无编排层**（B7） | 缺 `pipeline.js` 任务表驱动的跨域编排，产品只能靠人工在模块间搬运 |
| **6 个外部依赖 0 个已接入** | 采集上游 / GEO 上游 / 支付网关 / 云库 / CloudBase / FFmpeg 二进制 |
| **多租户隔离不完整**（X9） | `tenantOf()` 在部分读写路径未生效，存在跨租户读写可能 |
| **单机单实例存储** | `store.js` 无跨进程协调；`nextId` 靠 400ms 合并写 → 崩溃后 id 复用 |
| **`ff.run` 实现待确认** | 若用 `exec` 拼串，字体路径（`renderer.js:33` 含冒号空格）会破壳；建议确认用 `execFile`/`spawn(shell:false)` |
| **死信仅存内存** | `queue.js:378-379` 封顶 100 条但重启即丢 |
| **资源泄漏** | `queue.js:94-97` 补位定时器未纳入 `this.timers` → close 后仍 spawn 孤儿 worker；`render-worker.js:71-72` 退出时 ffmpeg 变孤儿 |

---

## 4. 冗余处理记录

### 4.1 已删除（628 MB）

| 类别 | 内容 | 体积 | 判定依据 |
|---|---|---|---|
| **Edge profile 残留 ×21** | `.data/_al_*` `_dd*` `_ed1..8` `_edgetmp` `_sd1` | **~587 MB** | 全是 Edge 浏览器 profile（Autofill / Crashpad / BrowserMetrics / 组件元数据），**代码零引用**（仅 `scripts/shot.js:107` 用系统 Temp 目录），非业务数据 |
| **渲染临时区** | `.data/demo/tmp/`（7 个子目录 143 个中间文件） | 35 MB | 渲染工作区（`body.mp4`/`subbed.mp4`/`shots_0`），仅出现在历史日志文本中，非活引用 |
| **QA 截图 ×13** | `.data/al-*.png` `dd-*.png` `sd-dash.png` `shot-*.png` | 2.3 MB | 全项目零引用的调试截图 |
| **完全重复的库备份 ×2** | `.data/demo/db.json.migrated-1792247{48,58}xxxx` | 335 KB | md5 与 `db.json.backup-k4` **完全一致**（`8c71d951…`），保留一份 |
| **迁移前快照** | `.data/db.before-demo-split-*.json` | 148 KB | 已被 demo 库替代 |
| **陈旧运行时文件** | `.data/server.pid` `server.err.log` | 4 B | 0 字节残留 + 陈旧 pid |
| **重复部署包 ×3** | `release/aizhiying-win-20261019-{1045,1049,1125}.zip` | 2.0 MB | 三者 `server/index.js` md5 **完全相同**，`pack-win.js` 可随时重建 |
| **重复站点包** | `release/ai-site.zip` | 24 KB | 与 `ai-site-folder.zip` 同 11 文件同内容，仅差一级路径前缀 |

### 4.2 明确保留（不可删）

| 内容 | 体积 | 保留原因 |
|---|---|---|
| `release/ffmpeg-offline-win64.zip` | 78 MB | 离线安装必需件 |
| `.data/demo/out/`（44 个 mp4/jpg） | 14 MB | `demo/db/jobs.json` **交叉校验：47 个引用文件全部命中**，删了演示播放即坏 |
| `.data/demo/db/` | 438 KB | 真实业务库（`collect_leads.ndjson` 250 条线索） |
| `.data/server.log` | 14 KB | 排障价值 |
| `release/` 其余热修复包 | ~2.5 MB | 部署历史留痕 |
| `_cleanup_backup/` | 456 KB | 本次清理的配置与业务库备份（已加进 `.gitignore`） |

### 4.3 修复后的镜像漂移

`src/matrix.js` 曾与 `index.html` 脱节（**镜像少 16 行、改动 1014 行**）——
`check-sync.js --strict` 已报警但没人跑。已执行 `extract-src.js` 重新生成，现 **5/5 + CSS 全部一致**。

### 4.4 `.gitignore` 漏洞（已修）

| 漏洞 | 后果 |
|---|---|
| 根 `.data/` **未被覆盖**（只忽略了 `server/.data/`） | `git init` 后会把 644 MB 运行时数据拖进版本库 |
| `.env.local.example` 被 `.env.*` 规则误伤 | 生产模板无法入库 |

已补：`.data/` + `!.env.local.example` + `_cleanup_backup/`。

---

## 5. 建议的修改顺序

> 原则：先修「会泄露 / 会丢数据 / 会给错答案」的，再修「会抖的」，最后修「会拖慢团队的」。

### 第一步 · 让项目可回滚（今天，30 分钟）

```bash
cd "C:/Users/ALIENWARE/WorkBuddy/2026-10-03-11-48-46"
git init && git add -A && git commit -m "chore: 初始提交（清理后基线，112MB）"
```
`.gitignore` 已修好，不会误收 `.data/` 与密钥。

### 第二步 · 修 CI（P0-6，本周）

把 `.build/*.py` 依赖换成现有脚本：

```yaml
- run: node scripts/extract-src.js
- run: node scripts/check-sync.js --strict
- run: node server/test/api.test.js
- run: node scripts/verify-fixes.js
```

### 第三步 · 补线索质量闭环（P1，本周）

在 `collect-sched.js` 落三件事：
1. 线索结构增 `phone` / `wechat` 字段 + 抽取与格式校验（`1` 开头 11 位）
2. 启用已定义未生效的 `MAX_LEADS` / `MAX_RUNS`
3. 指纹补作品与时间维度，避免跨作品误判重复

### 第四步 · 接一条真通道（P1，两周）

按 `collect-adapters/http-provider.js` 的契约接自有内容评论区（合规最干净），
配 `COLLECT_OFFICIAL_URL` + `COLLECT_OFFICIAL_OWNER`。此时 P0-2 的价值才真正兑现——
上游一改版就会立刻显式报错，而不是静默给空名单。

### 第五步 · 编排层（P2，一个月）

引入 `pipeline.js`，把「关键词 → 选题 → 文案 → 成片 → 投放」串成任务表驱动的管线。
这一步做完，四条业务流才从「四个独立工具」变成「一个产品」。

---

## 6. 验证方式

```bash
cd "C:/Users/ALIENWARE/WorkBuddy/2026-10-03-11-48-46"

node server/test/api.test.js        # 222/222 —— 端到端真渲染
node scripts/verify-fixes.js        # 25/25  —— 本轮 P0 修复专项
node scripts/check-sync.js --strict # 镜像一致性
node server/preflight.js --strict   # 上线自检
node server/index.js                # 起服务 → http://127.0.0.1:8787/app
```

---

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `server/cloud-relay.js` | XFF 信任链修复 + `TRUST_PROXY` 开关 |
| `server/collect-adapters/normalize.js` | 重写为 `normalizeDetailed()`，区分四种状态 |
| `server/collect-adapters/http-provider.js` | 结构漂移 → 显式 502 + 归一化诊断 |
| `server/collect-sched.js` | 新增 `empty` 状态、`UPSTREAM_SHAPE_CHANGED` 分支、不伪造时间 |
| `server/queue.js` | 路径穿越防护 + 产出条数校验 |
| `server/renderer.js` | 字幕保留、音轨/字幕状态如实标记、产物大小与 probe 校验 |
| `server/store.js` | fsync + 坏行计数修正 |
| `server/index.js` | `empty` 状态 HTTP 码语义 |
| `index.html` | `STATUS_META` 增 `empty` + 两处文案（**权威源**） |
| `src/*.js` `src/app.css` | 由 `extract-src.js` 重新导出 |
| `.gitignore` | 补 `.data/` `!.env.local.example` `_cleanup_backup/` |
| `scripts/verify-fixes.js` | **新增**：本轮 P0 修复专项回归（25 用例） |
