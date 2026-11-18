# AI智盈 · 服务端层（BFF）与渲染 Worker

零依赖 Node HTTP 服务。**不引入任何 npm 包**，只使用 Node 内置模块（`http` / `fs` / `path` / `crypto` / `os` / `url` / `child_process`）。

它承担 P0 清单里唯一必须新增的架构单元——**服务端层**，并把「剪辑」从浏览器的假进度条变成 **FFmpeg 真实渲染**，同时把「GEO 搜索获客」的关键词监测从静态假数据变成**可调度的真实探测 + SSE 实时变化推送**。

```
浏览器（index.html）
   │  POST /v1/edit/jobs  (multipart: assets[] + params)
   ▼
services/router ──► Queue（幂等/重试/死信/取消）
   │                      │
   │                      ▼
   │              renderer.js  ──► ffmpeg.js ──► FFmpeg 子进程
   │                                              │
   │              .data/out/<job>_NN.mp4  ◄────────┘
   ▼
GET /files/<name>（HTTP Range，可拖动播放）

浏览器（#v-geo）
   │  GET /v1/geo/stream  (SSE：hello / change / run / stats)
   ▼
GeoScheduler（30s tick · 任务 CRUD · 去重指纹）
   │                      │
   │  POST {GEO_UPSTREAM}/v1/geo/monitor
   ▼                      │
上游监测服务 ── 超时/未配置 ──► 本地确定性探测（仅 ALLOW_LOCAL_GEO=1）
   │                                              │
   │  geo_runs / geo_points / geo_changes  ◄──────┘
   ▼
diff() 检测 新收录 / 排名上升 / 排名下降 / 掉出答案  ──► SSE 实时推送

前端「采集器」页（#v-collect）
   │  GET/POST /v1/collect/tasks   ← 不再依赖「手动点击」
   ▼
CollectScheduler（30s tick · Cron/间隔 · 并发闸 · 去重指纹）
   │  按任务的 channel × scope 选通道
   ▼
collector.js（门面）──► collect-adapters/（通道注册表 + 通用转发 + 归一化）
   │
   ├─ official  自有内容评论区 ── POST {COLLECT_OFFICIAL_URL}/v1/comments/collect   scope=own
   ├─ crawler   自建爬虫       ── POST {COLLECT_CRAWLER_URL}/v1/comments/collect    scope=own|keyword
   ├─ vendor    第三方数据服务  ── POST {COLLECT_UPSTREAM}/v1/comments/collect      （契约冻结，无 scope）
   └─ local     本地模拟       ── 进程内生成（仅 ALLOW_LOCAL_COLLECT=1）
   │
   │  一条真实通道都没接 ──► 直接跳过（501 / skipped，绝不伪造数据）
   │  显式指定了未接入的通道 ──► 记 failed，绝不降级成模拟数据
   │                                              │
   │  collect_runs / collect_leads  ◄─────────────┘
   ▼
线索入库（平台|昵称|评论 指纹去重，落 channel / scope 便于溯源）
   └──► 前端「调度线索池」/ CSV 导出（带采集通道与范围两列）
```

> 三条链路共用同一套「不伪造数据」纪律：上游没接通就**明确跳过或返回 501**，绝不用空数组冒充成功。

---

## 一、启动

```bash
node server/index.js
```

默认监听 `http://127.0.0.1:8787`。启动横幅会打印 FFmpeg 探测结果、渲染并发、**采集通道（逐条列出已接入的上游与缺失项）**、支付通道与 **GEO 监测通道**状态。

打开 `http://127.0.0.1:8787/` 是深色状态页；打开 `http://127.0.0.1:8787/app/` 由本服务直接托管前端 SPA（**同源，无 CORS，`file://` 也可用**）。

前端只需在「设置 → 配置服务端」填入 `http://127.0.0.1:8787`（或线上域名），点「测试并保存」——`runtime.js` 的 `Api.setBase()` 会广播 `bff:changed` 事件：**矩阵板块的剪辑通道**自动从「本地模拟」切到「真实渲染」，**GEO 板块**同步从「本地模拟通道（时间压缩 60×）」切到「真实通道」，并改由 `/v1/geo/*` 拉任务、拉历史、订阅 SSE。

### 生产环境建议

```bash
HOST=0.0.0.0 PORT=8080 \
API_TOKEN=<强随机串> \
RENDER_CONCURRENCY=2 \
FFMPEG_PATH=/usr/local/bin/ffmpeg \
# 采集通道：至少配一条。自有内容评论区走官方开放能力，第三方公开评论走爬虫或供应商
COLLECT_OFFICIAL_URL=https://open.platform.example \
COLLECT_OFFICIAL_OWNER=<自有账号标识> \
COLLECT_CRAWLER_URL=http://crawler:8801 \
COLLECT_UPSTREAM=https://collect.vendor.com \
COLLECT_TOKEN=<vendor-token> \
COLLECT_DEFAULT_CHANNEL=auto \
GEO_UPSTREAM=https://geo.vendor.com \
GEO_TOKEN=<geo-token> \
node server/index.js
```

> 三条采集通道可以只配一条，也可以同时配。任务默认 `channel=auto`，按「范围 → 优先级」在运行时选，所以后续补通道不需要改历史任务。

> 注意：生产**不要**设 `ALLOW_LOCAL_GEO` / `ALLOW_LOCAL_COLLECT`。两者开启时 `/v1/health` 与页面都会显示「本地模拟通道」，这是给演示和测试用的。

前面挂 Nginx / 负载均衡做 TLS 与限流；进程用 `systemd` 或 `pm2` 拉起。服务已处理 `SIGINT` / `SIGTERM` 优雅退出。

### 上线自检：`preflight.js`

不绑定端口、不改任何状态，可以在 CI、K8s `initContainer` 或 `systemd ExecStartPre` 里跑：

```bash
node server/preflight.js            # 人类可读表格
node server/preflight.js --json     # 机器可读
node server/preflight.js --strict   # 告警也算失败
NODE_ENV=production node server/preflight.js
```

退出码：`0` 通过 · `1` 有阻断项（或 `--strict` 下出现告警）· `2` 参数错误。

它检查 10 项：Node ≥ 18 · 环境变量收口 · `ffmpeg` 存在且**编码器/滤镜齐备**（`libx264` / `aac` / `drawtext` / `zoompan` / `concat`）· 渲染字体存在且**含中文字形** · `index.html` 可读 · `DATA_DIR` 可写（含一次真实的**原子 rename 探针**，不只是 `access()`）· 可用磁盘空间。

### 环境变量收口守卫（启动闸）

服务启动时先跑 `config.enforce()`。当 `NODE_ENV=production` 且存在**阻断级**配置问题时，**直接拒绝启动**，退出码 **78（`EX_CONFIG`）**：

```bash
NODE_ENV=production node server/index.js
#  ✗ 启动被拒绝：生产环境变量未收口
#   ... 逐项列出阻断项与修复命令
#  exit 78
```

阻断项：缺少/过短的 `API_TOKEN` · `QA_MODE` · `ALLOW_LOCAL_COLLECT` · `ALLOW_LOCAL_GEO`。
告警项（不阻断）：`COLLECT_UPSTREAM` 无 `COLLECT_TOKEN` · **`COLLECT_OFFICIAL_URL` 无 `COLLECT_OFFICIAL_OWNER`（官方通道会「成功但空」，不报错，最易漏）** · **接入 ≥2 条通道却未声明 `COLLECT_DEFAULT_CHANNEL`** · `GEO_UPSTREAM` 无 `GEO_TOKEN` · `PAY_GATEWAY` 无 `PAY_MCH_ID` · 生产监听 `0.0.0.0` 但未声明 `TRUST_PROXY` · 生产未显式指定 `DATA_DIR`。

`ALLOW_INSECURE_BOOT=1` 可豁免启动，但会**强制关闭 `QA_MODE`**（测试后门属于攻击面，不是可选项），横幅会打印「⚠ 豁免启动」并说明哪些问题仍需尽快修正。

---

## 二、环境变量全表

| 变量                  | 默认            | 说明 |
| ------------------- | ------------- | ---- |
| `NODE_ENV`          | `development` | `production` 时启用**启动闸**：有阻断级配置问题直接以退出码 78 拒绝启动 |
| `PORT`              | `8787`        | 监听端口 |
| `HOST`              | `127.0.0.1`   | 监听地址。对外提供服务需改 `0.0.0.0`（并用 `API_TOKEN` 保护） |
| `TRUST_PROXY`       | 空             | `1` 表示前面有反向代理终止 TLS。生产监听 `0.0.0.0` 却未声明时，自检会给出告警 |
| `DATA_DIR`          | `server/.data`| 数据根目录（assets / out / tmp / bgm / db.json）。生产**必须显式指定**并挂持久卷 |
| `STATIC_ROOT`       | 项目根目录         | `/app/*` 静态托管的根；默认自动推断为 `index.html` 所在目录 |
| `APP_INDEX_DIR`     | 空             | `STATIC_ROOT` 的兼容别名，两者都不设时按上面自动推断 |
| `MAX_UPLOAD_BYTES`  | `536870912`   | 单次上传体积上限（512 MB） |
| `API_TOKEN`         | 空             | 非空时，所有 `/v1/*` 写接口要求 `Authorization: Bearer <token>`；生产为空则拒绝启动 |
| `QUIET`             | 空             | `1` 时关闭渲染日志输出 |
| **渲染**            |               | |
| `RENDER_CONCURRENCY`| `1`           | 同时渲染的任务数。1 核 1 并发，按 CPU 核数调整 |
| `RENDER_MAX_ATTEMPTS`| `3`          | 单任务最大尝试次数（含首次）；失败按指数退避重试，超限进死信 |
| `RENDER_MAX_OUTPUTS`| `20`          | 单次任务最多产出成片数（防滥用） |
| `RENDER_PRESET`     | `veryfast`    | `libx264` 预设。上线可改 `medium` 换画质 |
| `RENDER_CRF`        | `26`          | 恒定质量因子，越低越清晰、体积越大 |
| `RENDER_FONT`       | 按平台自动探测 | 字幕字体路径。候选项按平台给全：Windows `simhei.ttf`；macOS `PingFang`；Linux **Noto Sans CJK**（含 `wqy-zenhei` / `DroidSansFallback` 等兜底）。`FFMPEG_FONT` 可作别名 |
| `FFMPEG_FONT`       | 空             | `RENDER_FONT` 的兼容别名，优先级更低 |
| `RENDER_KEEP_TMP`   | 空             | `1` 时保留任务临时目录，便于排查渲染失败 |
| `FFMPEG_PATH` / `FFMPEG_BIN`   | 自动探测 | 显式指定 `ffmpeg` 可执行文件 |
| `FFPROBE_PATH` / `FFPROBE_BIN` | 自动探测 | 显式指定 `ffprobe` 可执行文件 |
| `BGM_FILE`          | 空             | 背景音乐文件路径。为空则成片为**静音音轨**（仍带 AAC 流） |
| **本地配音与字幕**  |               | 能力插件，全离线；可用性由启动横幅与 `/v1/edit/stats.abilities` 如实报告 |
| `EDIT_TTS_VOICE`    | 自动选第一个中文语音 | 指定语音名（须与系统已安装语音完全一致）；未安装则回落并告警 |
| `EDIT_TTS_RATE`     | `1.1`          | 默认语速（0.5~3.0），`atempo` 变速保音调；前端可按任务覆盖 |
| `EDIT_TTS_DISABLE`  | 空             | `1` = 显式禁用配音（成片输出无配音版本，界面如实标注） |
| **采集**            |               | |
| `COLLECT_OFFICIAL_URL` | 空        | **自有内容评论区**（平台官方开放能力）网关基址。只能读自有账号作品的评论；留空则该通道不可用 |
| `COLLECT_OFFICIAL_TOKEN` | 空      | 官方网关令牌（网关内部完成签名时可留空） |
| `COLLECT_OFFICIAL_OWNER` | 空      | **自有账号标识**（抖音 `open_id` / 视频号 `finder id` 等）。缺这一项时采集**不报错而是返回空**，最易漏 |
| `COLLECT_OFFICIAL_TIMEOUT_MS` | `20000` | 官方通道超时 |
| `COLLECT_CRAWLER_URL` | 空        | **自建爬虫**基址（内网地址即可，如 `http://crawler:8801`）。抓第三方公开评论 |
| `COLLECT_CRAWLER_TOKEN` | 空      | 爬虫令牌，仅在爬虫不在可信内网时才需要 |
| `COLLECT_CRAWLER_TIMEOUT_MS` | `60000` | 爬虫超时（默认放宽，避免带重试的爬虫把 30 s 巡检周期堵住） |
| `COLLECT_UPSTREAM`  | 空             | **第三方数据服务**基址。为空时该通道不可用（整体无通道时 `/v1/comments/collect` 返回 **501 `UPSTREAM_NOT_CONFIGURED`**，刻意不返回 0 条） |
| `COLLECT_TOKEN`     | 空             | 转发给供应商的 Bearer Token（仅存在于服务端）。供应商契约冻结，body 里**不会**多带 `scope` |
| `COLLECT_TIMEOUT_MS`| `15000`       | 供应商通道超时 |
| `COLLECT_DEFAULT_CHANNEL` | `auto`   | 全局默认通道：`auto`（按范围自动选）或写死 `official` / `crawler` / `vendor` |
| `ALLOW_LOCAL_COLLECT`| 空            | `1` 时允许本地模拟通道兜底，返回数据带 `source: 'local-simulated'` 标记。**生产必须留空**（生产设有该开关会直接拒绝启动） |
| `COLLECT_CONCURRENCY`| `2`          | 调度器同一轮并发执行的任务数 |
| `COLLECT_TICK_MS`   | `30000`       | 调度器巡检周期（毫秒）。到点任务在该轮被拾取 |
| `COLLECT_NO_SEED`   | 空             | `1` 时不写入 6 条示例调度任务（空库启动） |
| **GEO 监测**        |               | |
| `GEO_UPSTREAM`      | 空             | 上游 AI 关键词监测服务基址。为空且未开本地模拟时，调度器**完全空转，不产出任何数据**（刻意不造数据） |
| `GEO_TOKEN`         | 空             | 转发给上游的 Bearer Token（仅存在于服务端） |
| `GEO_TIMEOUT_MS`    | `20000`       | 上游单次探测超时。AI 引擎响应普遍偏慢，默认给到 20 s |
| `ALLOW_LOCAL_GEO`   | 空             | `1` 时上游缺失/失败则回落到**本地确定性探测**，产出的点与变化都带 `source: 'local-simulated'`。**生产必须留空** |
| `GEO_NO_SEED`       | 空             | `1` 时不写入 6 条示例监测任务（空库启动） |
| **支付**            |               | |
| `PAY_GATEWAY`       | 空             | 支付网关下单地址 |
| `PAY_MCH_ID`        | 空             | 商户号 |
| `PAY_PROVIDER`      | `wechat`      | 渠道标识，写入订单 |
| `PAY_NOTIFY_SECRET` | 空             | 回调验签密钥。为空时 `/v1/billing/notify` 拒绝一切回调 |
| `SERVICE_DB_KEY`    | 空             | 服务端写云库的密钥。用于支付成功后把订阅写进 `subscriptions` |
| **风险豁免 / 测试后门** |               | |
| `QA_MODE`           | 空             | `1` 时开启 `/v1/qa/report` 报告回收接口，并允许静态托管 `.build/`。**生产必须留空** |
| `ALLOW_INSECURE_BOOT`| 空            | `1` 时生产环境也允许带病启动（跳过退出码 78），但会**强制关闭 `QA_MODE`**。仅用于应急排障 |

---

## 三、接口契约

### 渲染 Worker

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `POST` | `/v1/edit/jobs` | 创建剪辑任务。`multipart/form-data`：`assets`（可多个文件）+ `params`（JSON 字符串）+ 可选 `samples`（内置示例素材 id 的 JSON 数组）；JSON body 走 `assets[].dataUrl` 或 `params.samples`。返回 `{ job }`，命中幂等时 `reused: true` 且状态码 200 |
| `GET`  | `/v1/edit/jobs` | 任务列表，`?limit=` 控制条数，附带 `queue` 队列统计 |
| `GET`  | `/v1/edit/jobs/:id` | 单任务详情（含 `outputs`） |
| `POST` | `/v1/edit/jobs/:id/cancel` | 取消任务（中断 FFmpeg 子进程，保留已产出成片） |
| `DELETE` | `/v1/edit/jobs/:id` | 删除任务并清理成片/封面文件 |
| `GET`  | `/v1/edit/stats` | 队列统计 + 死信列表（由持久化的 `failed` 任务合并进程内死信）+ 本地能力现状 `abilities` |
| `GET`  | `/v1/edit/samples` | **内置示例素材清单**（FFmpeg 现场生成的家纺主题竖版图，首次请求时生成并落盘缓存） |
| `GET`  | `/v1/edit/samples/<id>.jpg` | 示例图静态分发（免鉴权，供 `<img>` 直连；仅放行已知 id 的 `.jpg`） |
| `GET`  | `/files/<name>` | 成片 / 封面静态分发，支持 **HTTP Range**（206），播放器可拖动 |
| `GET`  | `/v1/health` | 健康检查：版本、运行时长、FFmpeg 能力（`capabilities` 编码器/滤镜探测 + `font` 中文字形判定）、队列、采集上游与**调度器计数**、支付通道、**GEO 通道**，以及**环境变量收口结论**（`config.flags` / `config.guard`，含逐项修复命令） |

`params` 字段：

```jsonc
{
  "title": "家纺素材 · 质感演示",   // 烧进视频的标题
  "count": 3,                    // 产出成片数量
  "ratio": "9:16",               // 9:16 | 16:9 | 1:1 | 4:5
  "shotSeconds": 2,              // 单镜头时长
  "motion": "kenburns",          // kenburns | zoom | pan | none
  "transition": "fade",          // fade | none
  "dedupe": true,                // 素材重复利用时做镜像/变速错位
  "coverTitle": "…",             // 封面标题（缺省取 title）
  "cta": "私信领取面料色卡",       // 底部行动号召
  "voice": true,                 // 本地 TTS 配音（默认关闭）
  "subtitle": true,              // 字幕烧录（voice 开启时默认开启）
  "voiceRate": 1.1,              // 语速 0.5~3.0
  "samples": ["sp-chenille", "sp-cushion"]  // 内置示例素材 id（无需上传文件即可真实渲染）
}
```

#### 内置示例素材

`server/samples.js` 用 FFmpeg 现场合成 6 张家纺主题竖版图（1080×1920 JPEG，色卡版式 + 中文标题，中文字形缺失时自动降级为纯色块图），首次请求时生成并落盘 `DATA_DIR/samples/` 缓存。它们与上传素材走**同一条渲染链路**（解码 → 运镜 → 拼接 → 编码），解决了「界面上有示例素材、但点剪辑只能产出不可播放的参数预览」这一断层：

- 提交时把示例 id（`params.samples`）传给服务端，素材按指纹 `sample-<id>` 入正式素材表，重复提交直接复用；queue 与 renderer **零改动**。
- 前端种子素材（`m-seed1..4`）在渲染通道接通时自动绑定对应示例（`sid`），缩略图直接显示服务端真实图 —— 素材数量不变，云端恢复与统计口径不受影响。

#### 幂等设计

服务端对 `SHA-1(素材指纹 + 归一化参数)` 取前 20 位作为 `job.key`。**同一批素材 + 同一套规则再次提交，直接复用已渲染结果，不重复消耗算力**，响应体 `reused: true`。

> 因此**任何会改变成片画面/时长的参数都必须参与指纹**，包括烧进视频的标题。前端 `matrix.js` 的 `makeTitle()` 因此改为 **djb2 哈希种子**的确定性生成（而非 `Math.random()`），否则幂等永远命中不了。

### 采集契约（多通道）

同一份对外契约，四条通道各自实现。请求可带 `channel` 与 `scope` 指定走哪条：

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `POST` | `/v1/comments/collect` | 按 `channel` × `scope` 选通道后转发：`official` / `crawler` / `vendor` / `local`（`channel` 省略即 `auto`）。**无任何通道时返回 501，不静默返回空数组**；显式指定的通道未接入时返回 501 `CHANNEL_NOT_CONFIGURED`，**不降级成模拟数据** |
| `POST` | `/v1/events` | 前端上报错误/警告事件（服务端落 `events` 集合） |
| `GET`  | `/v1/events` | 读取事件流 |

**上游必须实现的契约**（`official` / `crawler` 一致；`vendor` 为冻结合同）：

```
POST {base}/v1/comments/collect
  Header  Authorization: Bearer <token>          # 令牌非空时
  Body    { platform, keyword, limit, region [, scope [, owner [, owner_id [, content_ids]]]] }
  Resp    { data: { comments: [{ nickname, comment, video_title, likes, at, region }] } }
GET  {base}/v1/health                            # 用于 /v1/health 的通道探测
```

| 通道 | body 差异 | 说明 |
| ---- | -------- | ---- |
| `vendor` | 只有 `{ platform, keyword, limit, region }` | 契约已上线，**不许多带字段**，所以不加 `scope` |
| `crawler` | 多带 `scope`（`own` = 只采自有账号；`keyword` = 按关键词搜公开内容） | 自建爬虫自行实现 |
| `official` | 多带 `scope: 'own'` 与 `owner`（自有账号标识），可选 `owner_id` / `content_ids` | 官方开放能力只能读自有账号作品 |

字段名**不必完全对齐**：`collect-adapters/normalize.js` 兼容 7 种返回壳层（`data.comments` / `data.list` / `data.items` / `comments` / `list` / `items` / 顶层数组或 `data[]`）与多套字段别名（`nick_name`、`digg_count`、`create_time`、`ip_region` …），空评论自动丢弃。

错误码：无通道 `501 UPSTREAM_NOT_CONFIGURED` · 指定通道未接入 `501 CHANNEL_NOT_CONFIGURED` · 未知通道 `501 CHANNEL_UNKNOWN` · 上游非 2xx `502 UPSTREAM_ERROR` · 超时 `504 UPSTREAM_TIMEOUT` · 不可达 `504 UPSTREAM_UNREACHABLE`。**全部 fail-loud，不静默回落。**

### 通道 × 范围：两条获客线怎么分工

| 范围 `scope` | 候选顺序（`channel=auto` 时） | 为什么 |
| ------------ | ----------------------------- | ------ |
| `own`（自有内容评论区） | `official` → `crawler` → `vendor` | 官方开放能力是唯一能读自有账号作品的合规通道 |
| `keyword`（搜公开内容） | `vendor` → `crawler` | 官方通道读不到别人作品下的评论，故不列入候选 |
| `auto`（默认） | `vendor` → `crawler` → `official` | 不预设场景，落到第一条已配置的通道 |

选中的通道**不写死在任务里**（`channel=auto` 时），所以「先上自有内容、后补爬虫」这类演进不需要改历史任务。`official` + `scope=keyword` 会被纠成 `own`；`vendor` + `scope=own` 直接拒绝（供应商合同里没有 `scope`，静默跑成关键词搜索更危险）。

> ⚠ **上线前必须解决的一处矛盾**：前端「条款与隐私」页当前写着「仅通过平台官方开放接口或具备合法资质的第三方数据服务实现」「不提供、亦不支持任何绕过第三方平台防护措施的采集手段」。**这与 `crawler` 自建爬虫通道的定位直接冲突**——自建爬虫抓第三方平台公开评论区，属于平台协议禁止的行为，也涉及个人信息保护与不正当竞争风险。
>
> 三种收敛方式，任选其一：
> 1. 移除该条款表述（不建议）；
> 2. **建议**：保留 `crawler` 通道但把它的适用范围限定为「自有账号内容或已获书面授权的内容源」，并在条款里写清这一边界；
> 3. 上线时不配 `COLLECT_CRAWLER_URL`，只用 `official` + `vendor` 两条通道，代码保留但不启用。
>
> 代码侧已做到：`crawler` 未配置时完全不可用，不会因为「代码里有这个通道」而产生任何采集行为。**决策在运营侧，不在代码侧**。

### 采集调度（Cron + 队列 + Worker）

让「采集」摆脱「手动点击」：任务由服务端常驻调度，关掉页面也会继续跑。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `GET`    | `/v1/collect/config` | 通道模式（`upstream` / `local` / `unconfigured`）、**通道清单 `channels`（含 `configured` / `missing`）**、`channelIds` / `scopes`、预设间隔档位、Cron 预设、并发与巡检周期 |
| `GET`    | `/v1/collect/channels` | **通道清单与连通性**。默认只回配置态（不打上游）；`?probe=1` 时真连各已接入通道的 `/v1/health` |
| `POST`   | `/v1/collect/preview` | 排期推演：给 `{ cron }` 或 `{ every }`，返回**未来 5 次执行时刻**与可读描述；非法表达式返回 400 |
| `GET`    | `/v1/collect/tasks` | 调度任务列表（含 `channel` / `scope` / `nextRunAt` / `scheduleText` / 累计计数 / 上次状态） |
| `POST`   | `/v1/collect/tasks` | 新建任务，可带 `channel` 与 `scope`。**同一 `(关键词, 平台)` 重复返回 409**；空关键词 400；间隔 < 30 s 返回 `EVERY_TOO_SMALL`；非法通道 `CHANNEL_INVALID`、非法范围 `SCOPE_INVALID`、通道范围不匹配 `SCOPE_UNSUPPORTED` |
| `GET`    | `/v1/collect/tasks/:id` | 单任务详情（含最近运行记录，每条带 `channel` / `scope`） |
| `PATCH`  | `/v1/collect/tasks/:id` | 更新（启停 / 改关键词 / 改平台 / **改通道与范围** / 改排期）。停用后 `nextRunAt` 归 0 |
| `DELETE` | `/v1/collect/tasks/:id` | 删除任务，**保留运行记录与线索池**（可追溯） |
| `POST`   | `/v1/collect/tasks/:id/run` | 立即执行一轮。**无任何通道时返回 501**；指定通道未接入时记 `failed`（`CHANNEL_NOT_CONFIGURED`），不伪造数据 |
| `GET`    | `/v1/collect/runs` | 运行轮次（倒序，`?limit=`），每条含实际使用的 `channel` / `scope` |
| `GET`    | `/v1/collect/leads` | 线索池（`?limit=`），每条带来源 `channel` / `scope`，`+ /v1/collect/leads/:id/status` 改客户阶段 |
| `POST`   | `/v1/collect/tick` | 手动触发一次巡检（等价于一个调度周期），用于排障 |

排期语义：

- **间隔式**：`every` 取 `realtime`(1 min) / `10m` / `15m` / `30m` / `1h` / `6h` / `12h` / `24h` / `daily2`，也接受纯秒数（`600`）与中文写法（`30分钟`、`1day`）。硬下限 **30 s**，保护上游配额。
- **计划式**：`cron` 为**标准 5 段**（分 时 日 月 周），支持 `*` / `?` / `a-b` / `*/step` / 逗号列举 / 三段式英文简写（`mon` / `jan`）。`日` 与 `周` 同时受限时按 **POSIX 并集**规则；周日 `7` 折叠为 `0`。
- 表达式**无解**（如 `0 0 31 2 *`）时 `nextRunAt` 返回 `0` 而不是死循环——内部只做有界天数扫描。

> 前端「采集器」页新增的「服务端定时调度」面板是这块的界面：多通道状态、任务列表（每行标注**采集通道与采集范围**）、立即执行、启停、**新建/调整任务时可选通道与范围（选官方通道会自动把范围锁到「自有内容」，未接入的通道标虚线并列出缺失的环境变量）**、Cron 可视化预览、本地任务一键推送到服务端、调度线索池与 CSV 导出（多出「采集通道」「采集范围」两列）。它读 `window.__COLLECTOR` 但不改它，是独立的一层。

### GEO 关键词监测

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `GET`    | `/v1/geo/config` | 引擎清单（6 个：豆包/腾讯元宝/文心一言/通义千问/DeepSeek/Kimi）、通道模式（`real` / `local`）、本地模拟开关 |
| `GET`    | `/v1/geo/tasks` | 监测任务列表（每个任务含 keyword / 引擎子集 / 周期 / enabled / 上次运行 / 运行轮次 / 捕获变化数） |
| `POST`   | `/v1/geo/tasks` | 新建监测任务。**重复关键词返回 409**；关键词为空返回 400 |
| `GET`    | `/v1/geo/tasks/:id` | 单任务详情 |
| `PATCH`  | `/v1/geo/tasks/:id` | 更新任务（启停 / 改周期 / 改引擎子集） |
| `DELETE` | `/v1/geo/tasks/:id` | 删除任务（保留历史点位与变化记录） |
| `POST`   | `/v1/geo/monitor` | 立即执行一轮探测（同步返回本轮 `results` 与 `changes`）。**未配置上游且未开本地模拟时返回 501** |
| `GET`    | `/v1/geo/runs` | 运行轮次记录（`?limit=` / `?keyword=`） |
| `GET`    | `/v1/geo/changes` | **实时变化流**（新收录 / 排名上升 / 排名下降 / 掉出答案），`?since=` 支持增量拉取 |
| `GET`    | `/v1/geo/history` | 关键词的历史点位（`?keyword=&days=30`），用于趋势图 |
| `GET`    | `/v1/geo/overview` | 总览 KPI：覆盖率、首答提及（前 3 位）、曝光量等聚合 |
| `GET`    | `/v1/geo/plan` | 针对某关键词生成内容优化方案（P0/P1/P2 选题 + 结构化建议） |
| `GET`    | `/v1/geo/stream` | **SSE 实时通道**：`hello` 握手 → `run`（轮次开始/结束）→ `change`（命中变化）→ `stats`（计数刷新），`: ping` 每 20 s 保活 |

上游契约（`GEO_UPSTREAM` 需实现）：

```jsonc
POST {GEO_UPSTREAM}/v1/geo/monitor
// Req
{ "keyword": "沙发布料批发 哪家好", "engines": ["doubao", "yuanbao"], "locale": "zh-CN" }
// Resp
{ "data": { "results": [
  { "engine": "doubao", "rank": 3, "status": "covered", "snippet": "…", "cited": true, "at": 1760000000000 }
] } }
```

`rank` 语义：`0` = 未被收录（`absent`）；`1–3` = 命中首答（`covered`）；`4–10` = 提及但靠后（`partial`）。

#### 变化检测与实时推送

`diff(prev, next, keyword)` 是**纯函数**（可直接单测），对比上一轮与本周期的排位，产出四类事件：

| kind | 触发条件 |
| ---- | -------- |
| `new`  | 上轮无排名 → 本轮有排名（**新收录**） |
| `lost` | 上轮有排名 → 本轮排名 0（**掉出答案**） |
| `up`   | 排名数字变小且仍 > 0（**排名上升**） |
| `down` | 排名数字变大且仍 > 0（**排名下降**） |

变化事件经 `GeoScheduler.emit()` 广播到所有 SSE 订阅者，`#v-geo` 的「实时变化流」与页面右上角「实时变化 N」随之刷新。

#### SSE 的鉴权注意

`EventSource` **无法自定义请求头**，因此 `authed()` 对 `/v1/geo/stream` 额外接受 `?token=` 查询参数。设了 `API_TOKEN` 时前端会自动把 token 拼到流地址上；不设则不校验。

#### 确定性本地探测（仅开发/演示）

`ALLOW_LOCAL_GEO=1` 时才启用。算法 `FNV-1a hash32 → mulberry32 rand01`，以 `(keyword, engine, day)` 为种子，因此**同一关键词 + 同一引擎 + 同一天永远得到同一个结果**——这既让演示可信，也让测试可断言分布。同一份算法在 `.build/geo.js`（前端）与 `server/geo.js`（服务端）各存一份，**两者必须保持同构**，测试会从两侧采样比对。

### 订单与支付

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `GET`  | `/v1/plans` | 套餐表（季度 ¥1980 / 基础 ¥5980 / 标准 ¥12800 / 旗舰 ¥29800） |
| `POST` | `/v1/billing/orders` | 创建订单。幂等键 `tenant\|plan\|amount`，重复提交复用未支付的 `pending_payment` 订单 |
| `GET`  | `/v1/billing/orders/:no` | 订单详情 |
| `POST` | `/v1/billing/notify` | 支付回调入口。校验 `x-pay-sign`（`PAY_NOTIFY_SECRET`），对 `paid` 状态幂等 |

**降级行为**：未配置 `PAY_GATEWAY` / `PAY_MCH_ID` 时，`createPayment()` 返回 `{ status: 'not_configured' }`，订单挂起为 `pending_payment` 而不是报错——这是刻意设计，方便前端在支付未接通时照常跑通流程。

---

## 四、渲染管线

### 模块文件地图（AI智能剪辑）

改代码前先看这张表，避免「同一件事有两份实现」再次长出来：

| 文件 | 职责 | 关系 |
| --- | --- | --- |
| `server/index.js`（剪辑段） | `POST /v1/edit/jobs`、分块上传、成片静态分发、`publicJob()` | 入口；只做参数归一化与落库，不碰 FFmpeg |
| `server/queue.js` | 任务队列：并发、指纹幂等、重试/死信、取消、素材路径自愈 | 调 `renderer.renderJob()`；主进程只调度 |
| `server/render-worker.js` | 渲染子进程（K3）：收任务、回传进度/成片 | 与 `queue.js` 用 IPC 通信，不碰 store |
| `server/renderer.js` | FFmpeg 合成引擎：逐镜头滤镜、concat、字幕、音轨、封面 | 唯一实现渲染细节的地方 |
| `server/ffmpeg.js` | 二进制发现 / 能力探测 / `run()` 进度解析 / `probe()` | 被 renderer、preflight、samples 共用 |
| `server/edit-capabilities/` | 配音（`tts.js`）与字幕（`subtitle.js`）能力插件 + 汇总 | 引擎之上做降级，不替换引擎 |
| `server/samples.js` | 内置示例 JPEG（免上传即可真实渲染） | 由 `index.js` 落成正式 asset |
| `index.html`（`matrix-layer`） | 前端：素材池、7 步工作流、任务卡、成片库、排期 | 只调 `/v1/edit/*`，不本地合成 |
| `src/matrix.js` | 上面那层的只读镜像 | 由 `node scripts/extract-src.js` 生成 |

唯一真相仍是 `index.html` 与 `server/*.js`；`src/` 镜像的层映射集中在 `scripts/layers.js`（导出与校验脚本共用一份，避免两边一起过期）。

每个成片按以下步骤生成，**全程只有一次 `libx264` 编码**，之后 `concat` 与音轨合成都走 `-c copy`，速度由构造保证：

```
素材图/视频
  ├─ scale 到画布（图片 2×、视频 1.3×，留运镜余量）→ crop 到目标比例
  ├─ 视频去重：hflip / 轻微变速（setpts）
  ├─ zoompan 运镜（kenburns / zoom / pan）
  ├─ fps=25 → setsar=1
  ├─ fade 淡入淡出
  ├─ drawtext 标题（顶部，半透明黑底）
  ├─ drawtext CTA （底部，品牌红底）
  └─ ▶ 单镜头 libx264 编码  → shots_N/sK.mp4
                    │
      concat demuxer（-c copy）→ body.mp4
                    │
      字幕烧录（仅开启时，会多一次编码）：subtitles 滤镜 → 失败自动降级 drawtext 逐条
                    │
      音轨合成：配音 + BGM → amix 混音（normalize=0）；仅配音 → 补静音对齐；
                仅 BGM → 压音量铺满；都没有 → anullsrc 静音底轨
      （-c:v copy -c:a aac，按成片真实时长 -t 对齐，避免音画不同步）
                    │
              out/<job>_NN.mp4 + 抽帧封面 .jpg
```

画布尺寸：

| ratio | 画布 |
| ----- | ---- |
| `9:16` | 720 × 1280 |
| `16:9` | 1280 × 720 |
| `1:1`  | 960 × 960 |
| `4:5`  | 864 × 1080 |

帧率固定 25 fps。

### 本地配音与字幕（能力插件）

`server/edit-capabilities/` 把配音与字幕做成**挂在渲染引擎上的能力插件**——引擎（FFmpeg 管线）本身不替换，缺哪个能力就降级，并如实上报：

- **配音（`tts.js`）**：走操作系统自带的语音合成（Windows `System.Speech` / macOS `say` / Linux `espeak-ng`），零安装、离线、不接第三方 API。逐句合成，每句时长用 `ffprobe` 实测；语速用 `atempo` 精调（如 1.1×），跨平台一致（SAPI 的 `Rate` 只有 -10..10 整数档，粒度不够）。
- **字幕（`subtitle.js`）**：配音文案是系统自己生成的，**逐句真实时长累加即得时间轴，不需要语音识别（ASR）**。优先用 `subtitles` 滤镜（libass）烧录；滤镜缺失或执行失败自动降级为 `drawtext` 逐条烧录；两者皆缺则跳过字幕并记日志——**不假装有字幕**。
- **如实降级**：TTS 不可用 → 输出无配音成片，`job.media.voice.reason` 写明原因；`/v1/edit/stats.abilities` 与前端工具条显示真实通道，界面不再「承诺后端没有的功能」。
- **幂等**：`voice / subtitle / voiceRate / voiceText` 全部参与任务指纹，改配音配置不会错误复用旧成片。
- **运维开关**：`EDIT_TTS_DISABLE=1` 显式禁用（探测直接短路）；`EDIT_TTS_VOICE` 指定语音名（未安装则回落并在启动横幅与接口里告警）；`EDIT_TTS_RATE` 设默认语速。
- **商用许可提醒**：日后若换本地神经 TTS，注意 **ChatTTS 是 AGPL-3.0**；Piper（MIT）/ Kokoro（Apache-2.0）/ CosyVoice（Apache-2.0）可商用。

> 实测（Windows 11）：`Microsoft Huihui Desktop (zh-CN)` 可合成中文女声；两句文案共 5.24s 成品音轨（含 1.1× 变速），单句「合成 + 标准化 + 测时长」约 1.5s；字幕经 libass 烧录验证画面可见。

### 两个关键的 Windows 适配

1. **驱动器冒号转义**：所有 ffmpeg 调用都以 `cwd = 任务目录` 运行并传**相对路径**。这样滤镜表达式里不会出现 `C:`，绕开 `drawtext` / `concat` 的冒号转义地狱。
2. **`textfile=` 而非 `text=`**：中文标题与特殊字符通过临时文本文件喂给 `drawtext`，彻底避免转义。

### 进度与取消

渲染用 `ffmpeg -progress pipe:1` 输出 `out_time_us=`，解析后按镜头总时长折算成 0–1 的 `ratio` 回推进度。取消通过 `AbortController` **杀掉 FFmpeg 子进程**，而不是只改数据库状态。

> 实现细节：本沙箱环境下 `spawnSync` 对所有二进制都返回 `EBUSY`，因此 `ffmpeg.js` **全程使用异步 `spawn`**，二进制探测也是 Promise 化并做了 memo。

---

## 五、数据落盘

`server/.data/`：

```
db.json              原子写（tmp + rename）+ 400ms 防抖刷盘
assets/              上传素材（按内容指纹去重，SHA-1 of size + 首尾 512KB）
out/                 成片 mp4 与封面 jpg
tmp/                 渲染临时目录（默认任务结束即删）
bgm/                 背景音乐
```

集合：`jobs` / `assets` / `orders` / `events` / `seq` / `bgm` / `geo_tasks` / `geo_runs` / `geo_points` / `geo_changes` / `collect_tasks` / `collect_runs` / `collect_leads`。

- `geo_tasks`：监测任务定义（关键词 / 引擎子集 / 周期 / enabled / 计数）
- `geo_runs`：每轮运行的元信息（开始/结束时间、引擎数、耗时、来源 `real|local-simulated`）
- `geo_points`：单个 `(关键词, 引擎, 时间)` 的点位（rank / status / snippet / cited）
- `geo_changes`：`diff()` 检出并推送过的变化事件（供 `/v1/geo/changes` 与增量拉取）
- `collect_tasks`：采集调度任务（关键词 / 平台 / **采集通道 `channel`** / **采集范围 `scope`** / 排期 / enabled / `nextRunAt` / 计数 / 去重指纹窗口 `seen`）
- `collect_runs`：每轮执行的元信息（触发方式 手动|自动、**实际使用的通道与范围**、抓到/新增/去重条数、耗时、状态 `ok|skipped|failed`）
- `collect_leads`：线索池（平台 / 昵称 / 评论原文 / 意向分 / 客户阶段 / **来源通道 `channel` 与 `scope`** / 指纹 `fp`，**库级唯一**）

> 每个集合在 `Store` 构造时都会做一次「不是数组就置空」的自愈，老 `db.json` 升上来不会因为缺字段炸掉。

---

## 六、测试

```bash
node server/test/api.test.js     # 或 npm test
```

**204 条用例**，覆盖：健康检查、素材上传与指纹去重、真实渲染产出校验（`ftyp` 魔数 + `ffprobe` 元数据）、HTTP Range 断点、错误码、幂等复用、取消与删除、套餐与订单，以及：

- **GEO 全族**：config（含通道判定字段 `upstreamConfigured` / `localAllowed` 与调度器计数）/ tasks CRUD（含 409 重复、400 空词、404 不存在）/ monitor（含 501 未配置上游）/ changes / runs / history / overview / plan / SSE 握手 / 删除，外加 `diff()` 与 `statusOf()` 的**纯函数单测**（新收录、排名上升、掉出答案、无变化不产事件、状态分档）。
- **采集调度全族**：config / 种子任务 / tasks CRUD（409 / 400 / `EVERY_TOO_SMALL`）/ Cron 任务的 `nextRunAt` 落在未来 / `preview` 返回 5 个严格递增时刻并对垃圾输入返回 400 / 立即执行的 `source: 'local-simulated'` 与 `simulated: true` 标记 / **两轮执行间的指纹去重**（`fresh + dup === got`）/ runs 倒序 / leads 指纹唯一 / 停用后 `nextRunAt` 归 0 / 改间隔后重排期 / 删除后运行记录与线索保留 / 手动 `tick`。
- **多通道采集（自有内容评论区 × 自建爬虫）**：另起一个「只接了爬虫、没接官方与供应商」的实例，断言 `mode` 转 `upstream`；通道清单列出 4 条且**未配置的通道点名缺失的环境变量**；`?probe=1` 真的连上游并把不可达如实报出来；任务默认 `channel=auto` / `scope=auto`；显式指定未接入的通道返回 501 `CHANNEL_NOT_CONFIGURED` **且不降级成模拟数据**；未知通道 `CHANNEL_UNKNOWN`；`vendor + own` 与未知通道在**任务创建阶段**即返回 400；指定官方通道时 `scope` 自动纠为 `own`；**指向 `127.0.0.1:1` 的爬虫跑一轮必须记 `failed / UPSTREAM_UNREACHABLE` 而非 `ok`**；任务显式指定未接入通道时记 `failed / CHANNEL_NOT_CONFIGURED`（配置错误不掩盖成「未接通道」）；运行记录与 `stats.tasksByChannel` 带通道信息。
- **纯函数单测**：`schedule.js` 的间隔换算、Cron 段解析、闰年 2/29、无解表达式返回 0（不死循环）、周日 `7 ≡ 0`、英文简写、错误码 `CRON_FIELDS` / `CRON_RANGE`；`collect-sched.js` 的 `normalizeRoute()`（通道范围归一化、`official` 纠 `own`、`vendor + own` 被拒、未知通道/范围报错、`local + own` 放行）；`config.js` 的生产阻断项点名（**每一项都必须带 `fix` 命令**）、`0.0.0.0` 未声明反代的告警、脱敏不回显完整令牌、**官方通道配了地址却缺 `OWNER` 的告警**。
- **「不造假」契约的实例级验证**：另起一个**未接任何通道**的隔离实例，断言采集与 GEO 双双自述 `unconfigured`、`/v1/comments/collect` 与 `/v1/collect/tasks/:id/run` 返回 501、`tick` 执行 0 个任务、线索池与运行记录**都保持为空**。
- **`CollectScheduler` 单元级验证**：把 `nextRunAt` 强行改到过去，断言通道未接时 `tick()` 返回 0 且不污染线索池；显式开 `ALLOW_LOCAL_COLLECT=1` 后按排期执行并自动推进下次排期；**撤掉豁免开关后 `stats().mode` 回落为 `unconfigured`**（通道判定是读取时按 env 推导的，不残留状态）。
- **本地配音与字幕（能力插件）**：`edit/stats` 返回 `abilities`（voice.channel / subtitle.mode）；**配音开关与文案参与幂等指纹**（改配置不复用旧成片）；分句不留句末标点、超长句二次切分；SRT 时间轴累加与按时长裁剪；TTS 探测结构完整（无语音包时 `ok:false` 必须带原因）；FFmpeg **可选能力**（subtitles / amix）缺失只降级、不阻断镜像构建。
- **内置示例素材（无文件真实渲染）**：清单字段齐全（id / url / 尺寸 / 体积）；示例图**免鉴权**可取且为合法 JPEG；路径穿越被拒；**纯 `samples` 提交（零上传文件）→ 真实渲染出 720×1280 成片**；重复提交素材层复用 + 任务幂等；未知示例 id 被忽略、已知 id 与上传素材正常合并；`samples` 为空且无文件 → `NO_ASSET`。
- **ffmpeg 能力与字体**：`capabilities()` 必须报出 `libx264` / `aac` / `drawtext` / `zoompan` / `concat` 齐备且 `ready`；`fontStatus()` 必须判定含中文字形。
- **生产闸（进程级）**：`spawn` 短命子进程验证 `NODE_ENV=production` 缺 `API_TOKEN` / 带危险开关时**退出码 78**，且拒绝启动时把阻断项与修复方式打印出来。

测试自行 spawn 一个隔离 `DATA_DIR` 的服务实例（GEO 用例带 `ALLOW_LOCAL_GEO=1`，采集用例带 `ALLOW_LOCAL_COLLECT=1`，另有一个**刻意不接通道**的实例做对照），并用 FFmpeg 现场生成测试素材，不依赖外部网络。

---

## 七、安全清单

- [x] 路径穿越防护：`/app` 静态托管屏蔽 `.build`（非 QA_MODE）/`.workbuddy`/`node_modules`/`.data`/`.git`
- [x] 上传体积上限
- [x] 参数白名单归一化（`ratio` / `motion` / `transition` 非法值回落默认）
- [x] 错误响应统一 `{ ok:false, code, message }`，不外泄堆栈
- [x] 渲染产出上限 `RENDER_MAX_OUTPUTS` 防滥用
- [x] GEO 上游不可达时**返回 501 而非伪造数据**；本地模拟数据一律带 `source: 'local-simulated'` 标记，前端界面同步标注「本地模拟通道」
- [x] 采集调度同理：上游未配置时 `tick()` **直接跳过、颗粒无收**，手动执行返回 501；模拟数据带 `simulated: true`
- [x] **启动闸**：`NODE_ENV=production` + 阻断级配置问题 ⇒ 退出码 78 拒绝启动；`ALLOW_INSECURE_BOOT=1` 豁免时会强制关闭 `QA_MODE`
- [x] 上线自检 `preflight.js`：编码器/滤镜齐备、中文字形、`DATA_DIR` 可写（真实原子 rename 探针）、磁盘余量
- [x] 令牌脱敏：`/v1/health` 只回 `abc****89(36位)`，绝不回显完整 `API_TOKEN`
- [ ] **上线前必做**：设 `API_TOKEN`；`QA_MODE` / `ALLOW_LOCAL_COLLECT` / `ALLOW_LOCAL_GEO` 留空；配好 `GEO_UPSTREAM`；**至少配一条采集通道并在 `/v1/collect/channels?probe=1` 上确认 `ok:true`**（自有内容评论区 `COLLECT_OFFICIAL_URL` + `COLLECT_OFFICIAL_OWNER`，或自建爬虫 `COLLECT_CRAWLER_URL`，或第三方数据服务 `COLLECT_UPSTREAM` + `COLLECT_TOKEN`）；`HOST` 对外时挂 TLS
- [ ] 限流（服务内未内置，已在 `nginx/conf.d/aizhiying.conf` 配好四档 `limit_req`；裸机部署需自行在网关层做）

---

## 八、部署产物

| 文件 | 作用 |
| ---- | ---- |
| `Dockerfile` | `node:20-bookworm-slim` + `ffmpeg` + `fonts-noto-cjk` + `tini`；非 root `app` 用户；`VOLUME /data`；**构建期断言** ffmpeg 必需编码器/滤镜存在，缺一个就让镜像构建失败；`HEALTHCHECK` 打 `/v1/health` |
| `.dockerignore` | 排除 `.build` / `.workbuddy` / `.git` / `.env*` / `server/.data*` / `node_modules`，**保留 `index.html` 与 `server/`** |
| `docker-compose.yml` | `bff`（`expose` 而非 `ports`，不直接暴露） + `nginx`（`depends_on: service_healthy`）。显式把 `QA_MODE` / `ALLOW_LOCAL_*` 置空，命名卷 `bff-data:/data` |
| `nginx/nginx.conf` | `limit_req_zone` 四档（api 20r/s、upload 2r/s、notify 10r/s）+ `limit_conn_zone`；gzip 开但**对 SSE 关闭**；`upstream` 带 `max_fails` / `keepalive` |
| `nginx/conf.d/aizhiying.conf` | 80→443 跳转（放行 ACME 挑战）；TLS 1.2/1.3 + HSTS + `nosniff` + `X-Frame-Options`。**四个易踩的坑已逐条注释**：SSE 必须 `proxy_buffering off`；上传必须 `client_max_body_size` + `proxy_request_buffering off`；成片要 `proxy_force_ranges on` 保住 Range/Cache；回调单独限流并预留 IP 白名单位 |
| `.env.example` | 八大分区覆盖全部 **49** 个环境变量，每个危险开关旁标了「生产必须留空」 |
| `.github/workflows/ci.yml` | 六道闸：语法 · **拼装收敛**（连跑两轮 md5 必须一致 + 五个层标记各恰好 1 次）· 服务端全量单测 · **生产闸退出码 78** · `preflight --strict` · QA 套件 |
| `DEPLOY.md` | 一分钟判断缺什么 / 容器化 / 裸机（含 systemd unit）/ 环境变量收口 / Nginx 三个必做项 / 数据与备份 / 上线检查表 / 12 行常见故障速查 |

### CI 里的「拼装收敛」闸为什么重要

`index.html` 是由 `.build/*.css` / `.build/*.js` 经 `patch_*.py` 用字符串替换拼进去的。这类构建最怕**不幂等**——跑第二遍又插一遍，层标记变成 2 处、3 处。CI 因此不检查「有没有内容」，而是检查**连续两次构建的 md5 相同**，再对 `id="geo-layer"` / `id="colsd-layer"` / `id="matrix-layer"` / `id="runtime-layer"` / `window.__UI =` 五个标记数出现次数（必须恰好 1）。这样"能跑"和"能重复跑出同一个文件"是两件被分别证明的事。
