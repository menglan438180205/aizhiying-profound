# AI智盈 · 生产上线清单

> 生成时间：2026-10-15（第 7 次更新：自动剪辑收口为「只走真实渲染通道」）  
> 对应系统：`index.html`（家纺面料 AI 获客中台）+ `server/`（零依赖 BFF）  
> P0 中能在代码与数据库层面完成的部分**已全部落地**。运行时层 48/48、采集器 76/76、矩阵获客 60/60、GEO 页面 76/76、服务端 204/204、真实剪辑端到端 44/44 —— **合计 508 条断言全绿**。
>
> 本轮做了两件事：
> **① 渲染通道自动接入**——服务端地址不再依赖手填：页面启动时自动探测（同源优先 → 本机默认 8787），探通即接入并持久化。此前 `bffBase` 为空时「一键智能剪辑」会静默落回本地模拟、产出不可播放的假成片；
> **② 本地模拟退出自动剪辑**——未接入渲染服务时点剪辑**如实失败**并给出修复指引，绝不产出模拟成片；本地模拟仅保留在 URL 显式带 `demosim=1` 的演示场景。配套新增 `server/samples.js`：FFmpeg 现场合成 6 张家纺主题竖版图作为内置示例素材，**没上传过任何文件也能走真实渲染**（示例素材按指纹 `sample-<id>` 入正式素材表，queue/renderer 零改动）。
>
> 上一轮（第 6 次）完成的本地配音 + 字幕能力插件仍然有效：系统自带 TTS（零第三方）、字幕时间轴按逐句真实时长累加、`subtitles` 滤镜烧录、失败如实降级。

---

## 一、本次已完成（无需再处理）

### 数据库层（云库已生效）

| 项         | 内容                                                                                            | 状态    |
| --------- | --------------------------------------------------------------------------------------------- | ----- |
| 订阅表写权限收回  | 移除 `subs_insert_own` / `subs_update_own`，收回 `authenticated` 的 INSERT/UPDATE/DELETE，仅保留 SELECT | ✅ 已生效 |
| 套餐表写权限收回  | 收回 `plans` 的写授权，客户端仅可读                                                                        | ✅ 已生效 |
| 匿名角色写权限收回 | `leads` / `content_tasks` / `app_records` / `subscriptions` 对 `anon` 全部只读                     | ✅ 已生效 |
| 线索幂等去重    | 新增 `leads.fingerprint` 列 + 唯一索引 `leads_owner_fp_key(owner_id, fingerprint)`                   | ✅ 已生效 |
| 新增采集任务表   | `collect_jobs`（关键字、平台、频率、启用态、最近运行状态），RLS 按 owner 隔离                                           | ✅ 已生效 |
| 新增审计日志表   | `audit_log`（只追加，无 UPDATE/DELETE 策略）                                                           | ✅ 已生效 |
| 新增运行事件表   | `obs_events`（错误/警告事件落库）                                                                       | ✅ 已生效 |
| 自动时间戳     | `leads` / `collect_jobs` 挂 `set_updated_at()` 触发器                                             | ✅ 已生效 |

### 前端层（已拼装进 index.html）

| 项             | 内容                                                                          | 状态 |
| ------------- | --------------------------------------------------------------------------- | -- |
| 服务层 `Api`     | BFF 优先、直连兜底的统一调用层，密钥不下发前端；内置 `/v1/billing/orders`、`/v1/health` 约定           | ✅  |
| 订阅流程改造        | 套餐开通改为「创建待支付订单」，不再由前端直写订阅；未接服务端时订单挂起为 `pending_payment`                     | ✅  |
| 可观测性          | `window.onerror` + `unhandledrejection` 全局捕获，错误/警告缓冲后批量落库                   | ✅  |
| 审计日志          | 关键操作写入 `audit_log`；设置页「操作日志」卡片接管为真实数据，支持导出 CSV                              | ✅  |
| 运行状态面板        | 设置页新增「生产就绪度」卡片：服务端接入、云库、会话、订阅权限、去重、错误数、待支付订单、渲染服务 8 项 + 6 个 KPI                  | ✅  |
| 合规文档          | 《用户服务协议》《隐私政策》完整文本 + 登录前强制同意门禁                                              | ✅  |
| **既有 Bug 修复** | `colRenderTasks()` 调用了未定义的 `qa()`，同步抛错中断采集器初始化链——已改为 `colQa()`，采集任务列表渲染随之恢复 | ✅  |
| 按钮冲突修复        | 运行时层按钮统一加 `data-use`，避免被应用的文字前缀动作表（`T['查看']`、`T['配置']`、`T['导出']`）误触发        | ✅  |

### 服务端层（新增 `server/`，零依赖 Node HTTP 服务）

> 这是 P0 清单中**唯一必须新增的架构单元**。承载会话校验、第三方密钥、租户隔离、限流、计费扣减、支付回调的落点，并让「剪辑」从浏览器假进度条变成 FFmpeg 真实渲染。

| 模块 | 文件 | 内容 | 状态 |
| --- | --- | --- | --- |
| 路由与静态托管 | `server/index.js` | `/v1/*` 全部接口 + `/app/*` 同源托管前端（绕开 CORS）+ `/files/*` 支持 HTTP Range | ✅ |
| FFmpeg 执行器 | `server/ffmpeg.js` | 异步 spawn（沙箱内 `spawnSync` 恒返 `EBUSY`，已全量 Promise 化）；二进制自动探测；`-progress pipe:1` 真实进度 | ✅ |
| 渲染引擎 | `server/renderer.js` | 单镜头 `libx264` 编码 → `concat -c copy` → 音轨合成 `-c:v copy`；4 种画布、运镜、淡入淡出、中文字幕、BGM/静音轨 | ✅ |
| 渲染队列 | `server/queue.js` | 并发上限、指数退避重试、死信、`AbortController` 真取消（杀子进程）、**素材指纹幂等复用** | ✅ |
| 持久化 | `server/store.js` | JSON 原子写（tmp+rename）+ 400ms 防抖刷盘，集合 `jobs/assets/orders/events/seq/bgm` | ✅ |
| 表单解析 | `server/multipart.js` | 零依赖 `multipart/form-data` 解析 + data-URL 上传通道 | ✅ |
| 计费与订单 | `server/billing.js` | 套餐表、订单幂等、支付回调验签；未配置支付通道时**显式降级**为 `not_configured` | ✅ |
| 采集多通道 | `server/collect-adapters/` | 通道注册表 + 通用 HTTP 转发 + 归一化；`official`（自有内容评论区）/ `crawler`（自建爬虫）/ `vendor`（第三方数据服务，契约冻结）/ `local`（本地模拟）。默认按 `scope` 优先级自动选，无通道时 **501**、指定通道未接入时**记 failed 不降级** | ✅ |
| 前端接入 | `.build/matrix.js` / `.build/runtime.js` | 真实渲染通道自动切换、成片 `video` 播放、封面色卡、幂等提示、渲染服务与队列 KPI | ✅ |
| 服务端文档 | `server/README.md` | 环境变量全表、接口契约、渲染管线、安全清单 | ✅ |

**关键工程决策**

1. **`spawnSync` 在本沙箱环境对所有二进制返回 `EBUSY`** → `ffmpeg.js` 全程使用异步 `spawn`，二进制探测 Promise 化并 memo。
2. **Windows 驱动器冒号转义** → 所有 ffmpeg 调用以 `cwd = 任务目录` 运行并传相对路径，滤镜表达式里不出现 `C:`。
3. **`textfile=` 而非 `text=`** → 中文标题与特殊字符走临时文本文件，彻底避免转义。
4. **幂等键必须包含所有影响画面的参数**（含烧进视频的标题）→ 前端 `makeTitle()` 改为 **djb2 哈希种子**的确定性生成，替换掉 `Math.random()`，否则幂等永远命中不了。

### GEO 搜索获客层（本次新增）

> 原 `#v-geo` 是纯静态页：6 张引擎卡写死「收录 42 个关键词」、5 行假排名、静态趋势柱。本次把它重建为**数据驱动的监测工作台**，并接上服务端调度器与 SSE 实时推送。

| 模块 | 文件 | 内容 | 状态 |
| --- | --- | --- | --- |
| 服务端监测层 | `server/geo.js` | `GeoScheduler`（30s tick、任务 CRUD、`runOnce` 探测、SSE 广播）+ 纯函数 `diff()` / `statusOf()` + 确定性本地探测 | ✅ |
| 服务端接口族 | `server/index.js` | `/v1/geo/*` 共 13 个端点：config / tasks(CRUD) / monitor / runs / changes / history / overview / plan / stream(SSE) | ✅ |
| 前端数据层与界面 | `.build/geo.js` | 引擎卡、关键词列表+筛选、任务管理、实时变化流、SVG 趋势图、曝光柱、内容方案、通道面板、运行日志 | ✅ |
| 前端样式 | `.build/geo.css` | GEO 专有样式（KPI/覆盖率条/变化流脉冲动画/表单弹窗/明细弹窗），全部跟随明暗主题 | ✅ |
| 实时推送 | SSE `/v1/geo/stream` | `hello` / `run` / `change` / `stats` 四类事件，`: ping` 每 20 s 保活；前端「实时变化 N」随推送跳动 | ✅ |
| 拼装脚本 | `.build/patch_geo.py` | 幂等：整块替换 `#v-geo`，备份到 `.build/index.before-geo.html` | ✅ |
| 自动化验证 | `.build/qa_geo.js` + `.build/runqa_geo.py` | 74 条浏览器断言，覆盖页面骨架 / 筛选 / 明细 / 监测轮次 / 变化流 / 任务增删停启 / 趋势图 / 方案导出 / **真实通道通道面板** / 无未捕获异常 | ✅ |

**关键工程决策**

1. **「不造数据」优先于「看起来有数据」**：上游未配置且未开本地模拟时，调度器**完全空转**；`POST /v1/geo/monitor` 返回 501 而非空数组。本地模拟数据一律带 `source: 'local-simulated'`，界面醒目标注「本地模拟通道（时间压缩 60×）」。
2. **确定性探测让演示与测试同时成立**：`FNV-1a hash32 → mulberry32`，种子是 `(keyword, engine, day)`。同一关键词同一天永远同一结果，因此既能演示「排名在变」，又能让测试断言分布。**同一份算法存在于 `.build/geo.js` 与 `server/geo.js` 两处，必须保持同构**——测试从两侧采样比对。
3. **`diff()` 是纯函数**：不碰 IO、不碰时间，因此可以直接单测「新收录 / 排名上升 / 掉出答案」三类变化，而不必去跑一轮真实探测。
4. **趋势图必须按「被探测的那一天」落点**：`applyResults(text, results, day)` 显式接收 `day`。最初图是空的，原因是 14 天历史回填全部用了 `dayIdx()`（今天），所有点塌缩到同一天，`days.length < 2` 直接把图表 bail 掉了。
5. **覆盖率阈值回调**：首轮 `AI 答案覆盖率` 读到可疑的 100%。把探测阈值从 `0.66/0.44/0.26` 调为 `0.72/0.55/0.40`、成熟度从 `0.18+(day%90)*0.011` 调为 `0.25+(day%90)*0.008`，服务端与前端**同步修改**。
6. **SSE 鉴权走查询参数**：`EventSource` 无法自定义请求头，因此 `authed()` 对 `/v1/geo/stream` 额外接受 `?token=`。
7. **通道面板的判定依据必须落到状态对象上**：`pullRemote()` 最初把 `/v1/geo/config` 的 `stats` 读进了局部变量 `st`，没有写回 `GEO.stats`，于是接入服务端后通道面板**永远**显示「未配置上游」——而后端其实配得好好的。已改为 `GEO.stats = r.data.stats`，并补了 5 条浏览器断言（离线打桩 `Api` + `EventSource`，不发起真实连接）与 2 条服务端契约断言，把这个假象钉死。

### 服务端定时调度 · 配置收口 · 部署产物（本轮新增）

> 这一节对应的正是上一版清单里「② 自己就能补（不阻塞，但生产必需）」的六项缺口——**全部已闭合**。

| 缺口（上版） | 本轮落地 | 文件 | 状态 |
| --- | --- | --- | --- |
| 采集只有「手动点击」 | `CollectScheduler`：30 s tick 巡检、Cron/间隔双模式、并发闸、`(关键词,平台)` 唯一、指纹去重、`tick()` 在**一条真实通道都没接时**直接跳过 | `server/collect-sched.js` | ✅ |
| 采集只有「一个上游」 | 升级为多通道：`official` / `crawler` / `vendor` / `local` 并存，任务级 `channel` × `scope`；`scope=own` 走自有内容评论区、`scope=keyword` 走爬虫或供应商；`/v1/collect/channels` 暴露配置态与缺失的环境变量，`?probe=1` 真连探测 | `server/collect-adapters/registry.js`、`http-provider.js`、`normalize.js`、`local.js` | ✅ |
| Cron 语义 | 纯函数 `schedule.js`：标准 5 段、POSIX 日/周并集、英文简写、闰年、无解返回 0 不死循环、`describeCron()` 可读描述、`preview()` 推演未来 5 次 | `server/schedule.js` | ✅ |
| `API_TOKEN` 不设则无鉴权 | 生产缺 token ⇒ 阻断启动（退出码 **78 `EX_CONFIG`**）；`/v1/health` 只回脱敏串 | `server/config.js` | ✅ |
| 反向代理缺失 | 四档 `limit_req` + `limit_conn`；**SSE 路径 `proxy_buffering off`**；上传 `proxy_request_buffering off` + 512 MB；成片 `proxy_force_ranges on` 保 Range；80→443 跳转放行 ACME；TLS 1.2/1.3 + HSTS | `nginx/nginx.conf`、`nginx/conf.d/aizhiying.conf` | ✅ |
| 环境变量收口 | `config.snapshot()` / `enforce()`：4 项阻断 + 5 项告警，每项都带**可执行修复命令**；`ALLOW_INSECURE_BOOT=1` 豁免时**强制关闭 `QA_MODE`** | `server/config.js` | ✅ |
| Linux 适配 | 字体按平台候选（Noto Sans CJK / wqy / DroidSansFallback），`fontStatus()` 判定是否含中文字形；`capabilities()` 断言 `libx264`/`aac`/`drawtext`/`zoompan`/`concat` 齐备，**缺一个就让镜像构建失败**；可选能力（`subtitles`/`amix`）缺失只降级、**不**阻断构建 | `server/renderer.js`、`server/ffmpeg.js` | ✅ |
| 渲染通道收口（本轮） | 页面启动**自动探测**服务端（同源 → 本机 8787），探通即接入；未接入时自动剪辑**如实失败**、不产出模拟成片（`demosim=1` 才允许演示模拟）；`server/samples.js` 现场合成 6 张示例素材，示例 id 走正式素材表（指纹 `sample-<id>`），**queue / renderer 零改动** | `server/samples.js`、`server/index.js`、`.build/runtime.js`、`.build/matrix.js` | ✅ |
| 自动剪辑「AI 配音 + 字幕」只是界面开关 | 新增**本地能力插件层**：配音走操作系统自带语音合成（Windows System.Speech / macOS say / Linux espeak-ng，零安装、离线、不接第三方），字幕时间轴由逐句真实时长累加（**不需要语音识别**），`subtitles` 滤镜烧录、失败自动降级 `drawtext`。**此前 `voice` 参数在服务端白名单就被丢弃，勾了也不会产出**——现已贯通并如实降级 | `server/edit-capabilities/{tts,subtitle,index}.js` | ✅ |
| 部署产物全待建 | Dockerfile（非 root + tini + HEALTHCHECK + `VOLUME /data`）· compose（`expose` 不暴露 + 命名卷 + 健康依赖）· `.env.example`（49 个变量八大分区）· `.dockerignore` · GitHub Actions 六道闸 · `DEPLOY.md` 九节手册 | 见下表 | ✅ |
| 上线自检 | `preflight.js`：10 项检查、`--json` / `--strict`、退出码 0/1/2，可放 CI 与 systemd `ExecStartPre` | `server/preflight.js` | ✅ |
| 前端无调度界面 | 「采集器」页新增**服务端定时调度**面板：多通道状态、任务列表（每行标注通道与范围）、立即执行、启停、**新建/调整任务可选通道 × 范围（选官方通道自动锁范围到「自有内容」，未接入的通道标虚线并列出缺失变量）**、Cron 可视化预览、本地任务一键推送、调度线索池 + CSV 导出（含通道与范围两列） | `.build/collector_sched.{css,html,js}` + `.build/patch_collector_sched.py` | ✅ |
| 运行态面板未反映新增能力 | 「生产就绪度」加两行（采集定时调度、环境变量收口）+ 一个 KPI（调度线索），共 10 行 / 7 KPI | `.build/runtime.js` | ✅ |

**关键工程决策（本轮）**

1. **「不造假」纪律从一层扩到三层**：`collector.js` 的 `mode()`（自述 `unconfigured`）→ `CollectScheduler.tick()` 的提前返回（到点也不执行）→ `index.js` 的 `tasks/:id/run` 返回 501。**每一层都有独立测试**，因为只靠一层时，绕过它的路径（手动执行 / 直接调 tick）就会漏。
2. **启动闸用退出码表达，而不是打印一句警告**：进程起不来才是真阻断。`78` 是 `EX_CONFIG`，systemd / K8s 都能据此判定「配置问题，别重启我」。豁免开关存在，但它**只豁免启动、不豁免 `QA_MODE`**——测试后门是攻击面，不是业务选择。
3. **`mode()` 必须是「读取时按 env 推导」的纯查询**，不能缓存。测试里专门有一条断言：撤掉 `ALLOW_LOCAL_COLLECT` 后 `stats().mode` 必须回落为 `unconfigured`，用来钉死「不残留 local」。
4. **CI 不检查「有没有内容」，检查「能不能重复跑出同一个文件」**：连跑两轮拼装脚本比对 `index.html` 的 md5，再对五个层标记断言出现次数恰好为 1。因为 `patch_*.py` 是字符串替换式拼装，最怕的是不幂等。
5. **`DATA_DIR` 自检要做真实的原子 rename 探针**，而不是 `access()`。`access()` 说可写但在某些挂载（只读层 / 特殊 fs）上 rename 会失败——而 `store.js` 落盘恰恰依赖 tmp+rename。
6. **Nginx 的四个坑必须写在配置文件里当注释**，不能只写在文档里。运维改配置时不会先翻手册，但一定会看到那行 `proxy_buffering off;` 上面的说明。
7. **多通道的关键不是「能选通道」，而是「选错时不许静默兜底」**。`channel=auto` 允许按范围自动选，但一旦任务**显式指定**了通道而该通道未接入，必须记 `failed / CHANNEL_NOT_CONFIGURED` 并给出修复命令——如果这里回落到本地模拟，产出就是假线索，而这条链路的下游是 CRM 和成交金额。
8. **通道不写死在任务里**。`channel=auto` + `scope` 两层解耦，使「先上线自有内容评论区、三个月后再补自建爬虫」这种演进不需要改任何历史任务——`resolveChannel()` 是读取时按当前 env 推导的纯函数，和 `mode()` 同一纪律。
9. **供应商契约冻结，绝不因为改造而多带字段**。`vendor` 通道的 body 仍是 `{ platform, keyword, limit, region }`，只有 `crawler` / `official` 才带 `scope` / `owner`。供应商那边已经按原契约联调过，多一个字段就可能是 400。
10. **`scope=own` 越权组合必须拦在入参层**。`vendor + own` 在契约里没有对应语义（供应商按关键词搜公开内容），若放行会「成功返回一批公开评论」而用户以为在监控自己的评论区——这类错配不报错，最难发现，所以在 `normalizeRoute()` 里直接 400。
11. **能力插件挂在引擎上，而不是换引擎**。配音与字幕没有替换 FFmpeg 管线，而是新增 `edit-capabilities/` 挂在既有挂点上（音轨混音 / 画面烧录）。这保留了「零依赖、可无人值守批量、已被 42 条端到端验证」的引擎优势——剪映类桌面工具做不了服务端批量，Remotion 类的底层也还是 FFmpeg。
12. **字幕不需要语音识别**。配音文案是系统自己写的，逐句合成后每句的真实时长（`ffprobe` 实测）累加即得时间轴。ASR 只在「转写素材自带人声」时才需要——把它从关键路径拿掉，补齐成本少了一半。
13. **可选能力与必需能力分开验收**。`subtitles` / `amix` 进 `OPTIONAL_CAPS`，缺失只降级；`libx264` / `aac` 进 `REQUIRED_CAPS`，缺一个镜像就构建失败。混在一起的结果要么误杀构建、要么静默降级。
14. **修「界面承诺、后端没有」这类落差时，前后端要一起改**。本次 `voice` 参数在前端是默认开启的开关，但服务端白名单没有这个字段——单独改任何一边，要么参数还是被丢，要么配音在没人要求时偷偷跑。

### 验证结果

- 运行时层自动化验证：**48 / 48 通过**
- 采集器回归验证：**76 / 76 通过**（含服务端定时调度面板、通道 × 范围选择与联动锁定、未接入通道的缺失变量提示、请求体带 `channel` / `scope`）
- 矩阵获客回归验证：**60 / 60 通过**（本轮新增 4 条：未接入渲染服务时剪辑**如实失败且不产出模拟成片**、日志说明不产出模拟成片、渲染通道芯片如实显示「未接入」；主链路改由显式演示入口 `simulate()` 驱动）
- GEO 页面自动化验证：**76 / 76 通过**
- **服务端 + 渲染 Worker + GEO + 采集调度 + 多通道 + 配音能力：204 / 204 通过**（`node server/test/api.test.js`；本轮新增 10 条：示例素材清单字段齐全、示例图免鉴权为合法 JPEG、路径穿越被拒、**纯 `samples` 提交零上传文件 → 真实渲染 720×1280 成片**、重复提交素材层复用 + 任务幂等、未知示例 id 被忽略且与上传素材正常合并、`samples` 为空且无文件 → `NO_ASSET`）
- **真实剪辑端到端（浏览器 → BFF → FFmpeg → 可播放成片）：44 / 44 通过**（本轮新增 2 条：种子素材绑定服务端示例图、日志说明混合服务端示例素材；验证「3 条本地上传 + 4 条服务端示例」混合渲染 + 幂等复用）
- **配音端到端实测（本机 Windows 11）**：`Microsoft Huihui Desktop (zh-CN)` 合成 2 句 5.24s（含 1.1× 变速）→ `amix` 混音 → `subtitles` 滤镜烧录；成片实测 `mean_volume -26.3 dB / max -3.6 dB`（非静音），抽帧确认字幕在画面中可见
- **示例素材端到端实测（本轮）**：6 张 1080×1920 JPEG 现场生成（单张约 45KB，2.8s）→ 纯示例素材（零上传文件）渲染 2 条 7.56s 成片（含 Huihui 配音 + libass 字幕）→ 抽帧确认素材画面运镜与字幕清晰可见
- 页面级未捕获异常：**0**
- 拼装幂等性：`patch_collector_sched.py` / `patch_runtime.py` 各自连跑两次 md5 不变；CI 口径的五个层标记（`id="geo-layer"` / `id="colsd-layer"` / `id="matrix-layer"` / `id="runtime-layer"` / `window.__UI =`）各 1 处
- `preflight.js` 本机实测：阻断 0 项 · 告警 1 项（本机未设 `API_TOKEN`，属预期）

---

## 二、必须由人工完成（代码无法替代）

### 1. 部署与账号体系（不做到这一步，登录与支付都无法真实走通）

- [ ] 将 `index.html` 发布为线上站点（HTTPS 域名）
- [ ] 域名 ICP 备案
- [ ] 在 WorkBuddy 云服务管理页开启 **「手机号登录」** Provider 开关（需先接入短信通道并配置签名与模板）
- [ ] 在云服务管理页开启 **「微信登录」** Provider 开关

### 2. 支付闭环（当前订单只能创建、不能收款）

- [ ] 接入微信支付 / 支付宝，完成商户号申请与签约
- [ ] 在服务端配置 `PAY_GATEWAY` / `PAY_MCH_ID` / `PAY_PROVIDER`
- [x] 支付回调入口 `POST /v1/billing/notify` + 验签（`PAY_NOTIFY_SECRET`）+ 对 `paid` 状态幂等
- [ ] 配置 `SERVICE_DB_KEY`，让回调成功后由**服务端**把订阅写进 `subscriptions` 表（**这是唯一允许写订阅的位置**）
- [ ] 实现订单状态机：`待支付 → 已支付 → 生效 → 到期 → 续费 / 退款`
- [ ] 对账与发票

### 3. 服务端层（BFF / Edge Function）— 代码已就绪，只剩部署

> 实现已完成并通过 **164/164** 自动化验证，见 `server/` 与 `server/README.md`。部署产物见 `Dockerfile` / `docker-compose.yml` / `nginx/` / `.env.example` / `.github/workflows/ci.yml`，步骤见 `DEPLOY.md`。

- [x] 实现 `POST /v1/billing/orders`、`GET /v1/health`
- [x] 实现 `POST /v1/edit/jobs` 剪辑任务接口族（创建/查询/取消/删除/统计）
- [x] 实现 `/v1/geo/*` 关键词监测接口族（13 个端点 + SSE 实时通道）
- [x] 实现 `/v1/collect/*` 采集调度与多通道接口族（13 个端点：config / channels / preview / tasks CRUD / run / runs / leads / tick + Cron 推演）
- [x] 第三方采集 Token、支付密钥、GEO Token 等敏感凭据**全部只存在于服务端环境变量**
- [x] 设置页「配置服务端」填入地址即可接入（前端零改动，已通过 E2E 验证）
- [x] **上线前必做**：设 `API_TOKEN`（否则 `/v1/*` 无鉴权）——**已改为启动闸**：生产环境不设直接退出码 78
- [x] **上线前必做**：确认 `QA_MODE` / `ALLOW_LOCAL_COLLECT` / `ALLOW_LOCAL_GEO` 留空——同上，生产环境带这些开关会拒绝启动
- [x] **上线前必做**（Linux）：镜像里已内置 `fonts-noto-cjk` 并把 `RENDER_FONT` 指向 `NotoSansCJK-Regular.ttc`；构建期断言 `libx264`/`aac`/`drawtext`/`zoompan`/`concat` 齐备，**缺一个镜像就构建不出来**
- [x] 限流：`nginx/conf.d/aizhiying.conf` 已配四档 `limit_req`（api 20r/s、upload 2r/s、notify 10r/s）+ `limit_conn`；**裸机部署若不走这套 Nginx 需自行在网关层补**
- [x] 反向代理的 SSE 攒批问题：`/v1/geo/stream` 已加 `proxy_buffering off` + `X-Accel-Buffering: no` + `gzip off` + 3600 s 读超时
- [x] 上线自检 `preflight.js`（10 项，退出码 0/1/2）与 CI 六道闸
- [ ] **仍需人工**：把服务部署到公网主机（HTTPS），域名解析与证书签发
- [ ] 多租户隔离：当前 `DATA_DIR` 是单实例单租户，横向扩容需外接对象存储 + 数据库

### 4. 采集服务与 GEO 监测上游

**采集（三条真实通道，至少配一条）**

- [ ] **自有内容评论区**：选定平台官方开放能力（抖音开放平台 / 视频号等），拿到企业应用资质后配置 `COLLECT_OFFICIAL_URL` + `COLLECT_OFFICIAL_OWNER`。**只能读自有账号作品的评论**，获客半径取决于自有内容量——若内容量不够，这条通道的产出会很有限，需要矩阵获客先跑起来
- [ ] **自建爬虫**：实现 `POST /v1/comments/collect`（Body 多带 `scope`）+ `GET /v1/health`，配 `COLLECT_CRAWLER_URL`（内网地址即可，如 `http://crawler:8801`）。`docker-compose.yml` 里已留 `crawler` 服务位（`profiles: collectors`，`expose` 不 `ports`，挂 `crawler-state` 卷持久化登录态）
- [ ] **第三方数据服务**：选定具备资质、能签数据处理协议的供应商（极致了数据 / 八爪鱼 / 拓尔思 / 蚁坊等），配置 `COLLECT_UPSTREAM` + `COLLECT_TOKEN`。契约已冻结，body 只有 `{ platform, keyword, limit, region }`
- [x] 服务端多通道适配层已就绪：通道注册表 + 通用转发 + 归一化（兼容 7 种返回壳层与多套字段别名），`/v1/collect/channels` 可查配置态与缺失变量，`?probe=1` 真连探测
- [x] 部署定时调度（Cron）+ 队列 + Worker，替代早先的「手动点击采集」——`CollectScheduler` 随服务启动，30 s 巡检，无需外部 crontab
- [ ] **上线前必做**：确认 `collect(channels)` 探测结果 `ok:true`；`COLLECT_DEFAULT_CHANNEL` 显式声明（接入 ≥2 条通道时启动闸会告警）
- [ ] **仍需人工**：确认各通道的频控配额（`COLLECT_CONCURRENCY` 默认 2、最小间隔 30 s；爬虫超时默认放宽到 60 s，因为带重试的爬虫会超过 30 s 巡检周期）
- [ ] **合规（优先级最高的未决项）**：自建爬虫抓第三方平台评论区违反平台协议，且高频请求涉个人信息保护与不正当竞争风险。建议自有内容走官方通道、第三方数据走有资质供应商；**自建爬虫只用于自有账号或已获授权的内容源**

**GEO 监测**

- [ ] **必做**：选定 AI 答案监测上游（自建爬测 / 第三方 AI 可见度服务），配置 `GEO_UPSTREAM` + `GEO_TOKEN`；未配置且未开本地模拟时调度器空转、`/v1/geo/monitor` 返回 501
- [ ] 确认上游实现 `POST /v1/geo/monitor` 契约（见 `server/README.md`），返回每引擎的 `rank` / `status` / `snippet` / `cited`
- [ ] 按引擎配额评估探测成本：6 引擎 × N 关键词 × 每日轮次的调用量，据此定 `GEO_TIMEOUT_MS` 与任务周期
- [x] 服务端调度器已就绪（30 s tick、任务 CRUD、SSE 实时推送），前端契约已固化
- [x] **必做**：确认 `ALLOW_LOCAL_GEO` 与 `GEO_NO_SEED` 在生产环境**留空/不设**——`ALLOW_LOCAL_GEO` 已由启动闸强制（生产带该开关直接拒绝启动）；`GEO_NO_SEED` 只影响空库首次启动，生产建议显式设 `GEO_NO_SEED=1` 以免写入示例任务
- [x] 如需在反向代理后使用 SSE：关闭该路径的响应缓冲（Nginx `proxy_buffering off;`、`X-Accel-Buffering: no`）——已在 `nginx/conf.d/aizhiying.conf` 落好，并附注释说明原因
- [ ] **仍需人工**：确认上游的配额与计费口径（`GEO_TIMEOUT_MS` 默认 20 s、任务周期由前端设定）
- [ ] 监测结果落库后的长期存储策略（`geo_points` 会随关键词数 × 引擎数 × 轮次线性增长，建议按天归档）

### 5. 监控与运维

- [ ] 配置告警接收通道（采集失败率、队列积压、支付回调失败、错误事件）
- [ ] 建立日志留存与备份策略

---

## 三、建议后续（工程化，可延后）

- [ ] 单文件拆分为模块化构建（当前 ~605 KB / 13 个注入层，`.build/` 目录已有 7 个幂等拼装脚本可作起点。**注意**：拆分前先看清楚层与层的依赖——`collector_sched.js` 刻意读 `window.__COLLECTOR` 但不改它，就是为了让这层能独立摘出去）
- [x] 纳入 CI（`.github/workflows/ci.yml` 六道闸：语法 · 拼装收敛 + 层标记唯一性 · 服务端全量单测 · 生产闸退出码 78 · `preflight --strict` · 五套 QA）
- [ ] 多环境（开发 / 预发 / 生产）+ 灰度发布 + 一键回滚
- [ ] 数据模型补全：`tenant_id` 多租户、`usage_quota` 用量配额、`leads` 分页索引
- [ ] 采集与企业微信对接的合规评审（涉及个人微信的功能必须走企业微信）
- [ ] 日志结构化（当前是 `console.log` 文本；接采集后可换 JSON 行并加 `requestId` 贯穿）
- [ ] 前端 E2E 纳入 CI 时需自备无头 Chrome（七套 Python 脚本已统一改为读 `CHROME_PATH` / `CHROME_BIN`，Windows 默认路径仅作兜底）

---

## 四、关键风险提示

1. **`subscriptions` 现在只能由服务端写入**。任何试图从浏览器直接写订阅的旧代码都会收到 42501 权限错误——这是有意设计，请勿为了「方便」而加回写策略。
2. **订单目前只能创建、不能收款**。在支付接入完成前，用户开通套餐只会产生 `pending_payment` 订单，不会生效订阅——这是正确的降级行为，不是 Bug。
3. **采集去重已改为数据库唯一索引兜底**。若需要清洗历史重复数据，可按 `(owner_id, fingerprint)` 处理。
4. **`leads.fingerprint` 为新增列**，历史数据该列为 NULL，不受唯一索引约束，无需回填。
5. **渲染是 CPU 密集型**。`RENDER_CONCURRENCY` 默认 1，按机器核数调整；单机不建议超过「核数 ÷ 2」。并发过高会让成片时长与排队时间一起劣化。
6. **幂等键是「素材指纹 + 归一化参数」的哈希**。若后续新增任何会影响画面或时长的参数，**必须同步加入指纹计算**（`queue.js` 的 `fingerprint()`），否则会错误地把不同成片判定为同一任务并复用旧结果。
7. **成片目前落在本机磁盘**（`server/.data/out`）。横向扩容或多实例部署前，必须把素材与成片迁到对象存储并改造 `/files/*` 为签名直链。
8. **`server/.data/` 是运行时数据目录，不要纳入 Git、不要手动删**。删掉会丢失任务与订单记录（素材可重传，订单不可再生）。
9. **GEO 的两份 `localProbe` 必须保持同构**。`.build/geo.js` 与 `server/geo.js` 各有一份相同算法，测试会从两侧采样比对；只改一侧会让回归失败，也会让「同一关键词同一天结果一致」这个前提破掉。
10. **本地模拟通道的数据不能对外当作真实数据**。它的初衷是让演示与测试可跑，所有产出都带 `source: 'local-simulated'`、界面标注「本地模拟通道（时间压缩 60×）」。上线前务必确认 `ALLOW_LOCAL_GEO` 留空。
11. **`AI 答案覆盖率` 依赖上游返回的 `rank`**。若上游只给布尔「是否收录」而不给位次，`首答提及（前 3 位）` 与「进入前三位的引擎数」两项指标会失真，需要在上游侧补齐 `rank`。
12. **生产环境配错就起不来，这是刻意的**。`NODE_ENV=production` 下缺 `API_TOKEN`、或带着 `QA_MODE` / `ALLOW_LOCAL_COLLECT` / `ALLOW_LOCAL_GEO` 任何一个，进程都会以退出码 **78** 退出。如果 CI/编排只看「进程活着」而不看退出码，会误判为「部署成功」。**`ALLOW_INSECURE_BOOT=1` 只应用于应急排障**，它会强制把 `QA_MODE` 关掉，横幅会打印「⚠ 豁免启动」。
13. **`COLLECT_TICK_MS` 调小不会让任务跑得更密**。它只是巡检周期；真正的执行节奏由任务的 `cron` / `every` 决定，且间隔硬下限 30 s。改巡检周期只影响「到点后最多晚多久被执行」。
14. **`collect_leads` 是只增不减的集合**。删除调度任务**不会**删它的运行记录与线索（这是为了可追溯）。线索会随关键词数 × 轮次持续增长，上线前应定好归档/清理策略，别等 `db.json` 涨到几十 MB 才处理。
15. **`db.json` 仍是单文件**。`CollectScheduler` 的 `seen` 指纹窗口每个任务最多保留 3000 条、线索池上限 5000 条、运行记录上限 300 条——这些上限是为了让单文件存储不至于失控。真要多租户或多实例，必须换数据库，而不是把这些数字调大。
16. **改 Nginx 配置时别把 SSE 那段删了**。`/v1/geo/stream` 的 `proxy_buffering off` 一旦被顺手改成默认，实时推送会静默退化成「攒一批再发」——功能看起来还在，但「实时」没了。配置文件里该段上方有注释说明，这一段必须留在所有 `location` 的最前面（Nginx 前缀匹配取最长者，但 `=` 精确匹配优先，保持显式更好读）。
17. **官方通道配了地址却缺 `COLLECT_OFFICIAL_OWNER` 时，采集会「成功但返回空」**。平台开放能力无法定位代表哪个自有账号，它不会报错，只会给一个空列表——最容易被当成「今天没有评论」。启动闸已有告警，`/v1/collect/channels` 也会把该项列进 `missing`，上线前请确认它是空的。
18. **`crawler` 通道的 60 s 超时会占住调度并发位**。`CollectScheduler` 一轮并发由 `COLLECT_CONCURRENCY`（默认 2）决定，若同时有多个爬虫任务到点，带重试的爬虫可能各跑数十秒，把这一轮的其他任务挤到下一轮。爬虫数量多时请降低任务频率或提高并发（上游配额允许的前提下）。
19. **云端 `collect_jobs` 表还没有 `channel` / `scope` 列**。BFF 侧（`collect_tasks`）已完整支持，但云库那张表是上一版建的，只存「关键词 × 平台 × 频率」。若要把调度任务同步到云库做多端展示，需要先补这两列——**当前不影响运行**（CRM 与看板读的是 `leads`，不是任务表）。
20. **线索池的通道字段是老数据补不齐的**。`collect_leads.channel` 是本轮新增，早于本轮采集的线索该字段为空，界面会显示「—」。若需要按通道回溯历史线索，用 `runId` 关联 `collect_runs` 反而更准。
21. **配音在 Linux 容器里默认没有**。Debian 镜像不含 espeak-ng，生产容器要配音需在 Dockerfile 里 `apt install espeak-ng`；不装则 `/v1/edit/stats.abilities.voice.ok` 为 `false`、成片输出无配音版本——这是如实降级不是故障，但别等用户问「配音呢」才发现。启动横幅与 `preflight` 都会报。
22. **Windows 的中文语音包决定配音音色**。系统没有 zh-CN 语音包时，TTS 只剩英文语音（中文读不出），abilities 会标 `cjk:false`；家用 Win11 一般自带 Microsoft Huihui。可用 `EDIT_TTS_VOICE` 指定（未安装会回落并告警）。
23. **内置示例素材是程序合成的版式图，不是实拍**。没上传过文件时点剪辑会用服务端示例图产出真实成片——链路是真的（解码/运镜/编码/配音/字幕），但画面是色卡版式图。这类成片可用于验证链路与演示界面，**不要直接当商用内容发布**；商用前请上传真实素材。
24. **渲染通道自动探测只认同源与 `127.0.0.1:8787`**。服务端部署在其它主机/端口时仍需在系统设置手动填写地址；前端探测失败会静默保持「未接入」状态，此时点剪辑会得到明确的失败提示而非模拟成片——这是有意行为，别把它当 Bug 修掉。
23. **开字幕会多一次全片编码**。字幕在 `concat` 后要重编码一次，渲染时间约 +30%~50%；不开字幕走原有的 `-c copy` 快路径。批量出片时若不需要字幕，把开关关掉能明显提速。
