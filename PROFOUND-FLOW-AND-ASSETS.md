# ProFound / AI智盈 · 全局流程与资料清单

> 生成时间：2026-10-28
> **现状（2026-11-10）**：本地根目录已迁到 `C:\Users\ALIENWARE\Documents\deepseek-harness\aizhiying`；
> 一次性脚本/工具已集中归档到 `archive/`，`release/` 只保留 `deploy.ps1` / `remote-swap.ps1` / `gate.js`。
> 线上是 **Windows Server + Cloudflare Tunnel**，不是早期设想的 Linux/Docker。
> 本文保留为资产索引，个别路径可能滞后；以 `archive/README.md` 和 `docs/REFACTOR-PLAN-2026-11.md` 为准。
> 核对方式：按实际代码与线上探测，非文档推断
> 本文档为索引，不替代根目录已有的 `TECH-ARCHITECTURE.md` / `BUSINESS-CONFLICTS.md` 等原始评审

---

## 0. 一句话认知

ProFound 是一套**零 npm 依赖的 Node 原生 HTTP BFF + 单文件前端 SPA**，用 FFmpeg 子进程做视频渲染，围绕**获客 / 剪辑 / GEO / 计费**四条业务流展开，卖给本地生活与中小企业做「AI 全域运营」。

技术底座健康（能力探测、幂等指纹、fail-loud 启动闸、端到端真渲染测试都比同规模项目扎实），**真正的短板不在代码，而在边界**：

- 向上游：**6 个外部依赖，0 个已接入**
- 向出口：**4 条业务流，0 条是闭环的**
- 向组织：**四域并列，互不调用，只共享 store**

---

## 1. 全局流程

### 1.1 双入口（当前最大的结构性矛盾）

| 入口 | 地址 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 官方域名版 | `https://aizhiying.app.workbuddy.host/?sharecode=L7X7PH5LQE` | 静态前端、手机号/微信登录全通、云数据库 | 连不上 BFF → 渲染/采集/GEO 全部不可用 |
| 服务器 IP 版 | `http://118.25.44.79:8787/app/?token=<API_TOKEN>` | BFF 全功能可用 | 云端按 Origin 校验白名单，手机号/微信登录必然失败 |

**根因**：云端 `/.cloud/auth/v1/*` 严格校验 Origin，白名单只含 `localhost:*`、`127.0.0.1:*`、`https://aizhiying.app.workbuddy.host`。用 `IP:端口` 访问必然 403。

**已解法**：`server/cloud-relay.js` 同源中继 —— 服务端到服务端不带 Origin 头，请求可通。前端 `resolveCloudEndpoint()` 改为：官方域名直连，其余 http(s) 来源走 `location.origin` 同源中继。中继挂载在鉴权网关**之前**（登录发生在拿到 token 之前），并加两道防滥用闸：同源限制（Origin 的 host 必须等于本站 Host）+ 限流（普通 120 次/分/IP，验证码 6 次/分/IP）。

**判定中继是否生效**：`GET /.cloud/auth/v1/user/me` 返回 **401/400 = 生效**，**403 = 未生效**。

### 1.2 请求链路

```
浏览器
  ├─ 官方域名版 → 静态托管 index.html
  └─ IP 版 → 同源 8787
        ↓
   cloud-relay.js （仅 /.cloud/ 前缀，早于鉴权）
        ↓
   server/index.js · handle()
        ├─ ROUTES 表（新增端点）→ 显式 auth 字段
        ├─ 存量 60+ if 分支（鉴权靠代码位置隐式决定）
        ├─ serveStatic（白名单 + 拒绝回溯）
        └─ GET /v1/events（SSE 真流 + 快照兼容）
        ↓
   领域层：collector / collect-sched | queue / renderer | geo / schedule | billing
        ↓
   store.js（分表 + NDJSON）+ .data/{assets,out,db.json}
```

### 1.3 四条业务流与各自的断点

```
A 获客流  评论源 → collector(4 通道选路) → collect-sched(去重入池) → 线索池 → ✂ CRM/跟进
                        ↑ 断点 B1：上游全断，100% 本地模拟数据

B 剪辑流  素材 → queue(指纹幂等) → renderer(TTS+字幕+amix+FFmpeg) → out/*.mp4 → ✂ 投放
                        ↑ 断点 B3：成片不入 assets，无 publish 路由
                        ↑ 断点 B8：beatSync 参数进指纹但未实现，前端开关静默失效

C GEO 流  GEO 上游 → geo(排名采集) → geo_changes 看板 → ✂ 内容回灌
                        ↑ 断点 B5：GEO_UPSTREAM 未配，返回 501，本地模拟自说自话

D 计费流  下单 → 订单 → ✂ 支付网关 → ✂ 订阅云库
                        ↑ 断点 B6/B10：PAY_* 未配，SERVICE_DB_KEY 未配，订阅不落库
```

**核心架构债（B7）**：四域互不调用。没有「关键词 → 选题 → 文案 → 成片 → 投放」的自动管线，产品只能靠人工在模块间搬运。修法是引入编排层 `pipeline.js`，用任务表驱动跨域步骤，每步可重试、可观测。

### 1.4 六层架构

| 层 | 组成 | 现状 |
|---|---|---|
| L1 表现层 | `index.html`（878 KB 单文件）+ `src/{runtime,matrix,geo,geosite,colsd}.js` 镜像 | 可跑；层间靠全局变量耦合 |
| L2 接入层 | `http.createServer` + `handle()` + `ROUTES` 表 | 可跑；存量 if 链未迁 |
| L3 领域层 | 采集 / 剪辑 / GEO / 计费 四域 | **并列，互不调用** |
| L4 能力层 | `ffmpeg.js`（能力探测）、`edit-capabilities/`（TTS+字幕）、`multipart.js`、`config.js` + `preflight.js` | 质量最高的一层 |
| L5 存储层 | `store.js`（分表 + NDJSON）+ `.data/{assets,out,samples}` | 单进程单实例 |
| L6 外部 | 采集上游 / GEO 上游 / 支付网关 / 云库 / CloudBase / FFmpeg 二进制 | **0 / 6 已接入** |

---

## 2. 线上真实状态（2026-10-28 实测）

| 项 | 实测值 | 结论 |
|---|---|---|
| 服务器连通性 | ping 10ms，正常 | 机器活着 |
| `http://118.25.44.79:8787/v1/health` | `code=000`，`Connection refused` | **BFF 当前宕机，端口无监听** |
| 端口 8787 | refused | 不是慢启动，是进程没起来 |

**启动即退出的两条确定性死法**：

1. **`server/cloud-relay.js` 缺失** → `server/index.js:40` 顶层 `require('./cloud-relay')` → `MODULE_NOT_FOUND` → exit 1
2. **生产守卫拒绝启动** → `server/config.js:86` `gate()` —— production 下 `API_TOKEN` 为空，或 `QA_MODE/ALLOW_LOCAL_COLLECT/ALLOW_LOCAL_GEO/DEMO_MODE` 任一为真 → `process.exit(78)`（EX_CONFIG）

**「重启无效」的固有坑**：`deploy/win/start-service.cmd` 有端口守卫（`netstat` 命中就 `[skip]`），而 node 是 `start-local.js --daemon` 用 `spawn(detached:true)` 派生的孤儿进程，`Stop-ScheduledTask` 只杀外层 cmd.exe → 旧 node 永远活着。**唯一可靠办法：按端口反查 PID**（`Get-NetTCPConnection -LocalPort 8787 -State Listen`），不能用 `.data\server.pid`（实测与真实监听者不一致）。

---

## 3. 资料清单

### 3.1 根目录文档（6 份）

| 文件 | 体量 | 作用 | 何时看 |
|---|---|---|---|
| `TECH-ARCHITECTURE.md` | 20 KB | 11 个技术卡点（K0–K11）+ 四阶段改造路线 + 完整疏通记录 | **先读这份**，是系统技术真相 |
| `ARCHITECTURE-REVIEW.md` | 8.5 KB | 6 层架构 + 4 条数据流 + 11 处业务断点（B1–B11）+ 7 步优化路线 | 想看数据流断点时 |
| `BUSINESS-CONFLICTS.md` | 19 KB | 18 条业务冲突（X1–X18）+ 合规红线 + 商业模式 + 建议动作顺序 | **做商业决策前必读** |
| `PRODUCTION-CHECKLIST.md` | 37 KB | 上线清单：已完成 / 必须人工完成 / 工程化后续 / 风险提示 | 准备上线时逐条点 |
| `DEPLOY.md` | 14 KB | 容器化 + 裸机部署 + 环境变量收口 + Nginx 三必做 + CI + 故障速查 | 部署到服务器 |
| `DEPLOY-DOMAIN.md` | 10 KB | 域名上线八步：买服务器 → 备案 → DNS → 打包 → 初始化 → 验收 | 要挂自有域名 |

### 3.2 服务端文档

| 文件 | 作用 |
|---|---|
| `server/README.md`（44 KB） | 服务端权威手册：启动、生产建议、preflight 自检、环境变量全表、接口契约、渲染管线、数据落盘、测试、安全清单、部署产物 |

### 3.3 项目记忆（`.workbuddy/memory/`）

| 文件 | 内容 |
|---|---|
| `MEMORY.md` | 长期记忆：云端 Origin 硬限制、同源中继解法、服务器部署、官方域名发布、FFmpeg 三条硬经验、「重启无效」坑、启动即退出两条死法 |
| `2026-10-03` ~ `2026-10-28`（15 份日报） | 逐日开发轨迹：架构评审 → 卡点疏通 → 生产化 → 部署踩坑 → 体检脚本 |

### 3.4 服务端源码（`server/`，零 npm 依赖）

| 文件 | 职责 |
|---|---|
| `index.js`（73 KB） | 主服务：路由分发、鉴权、静态托管、SSE |
| `store.js` | 存储：分表 + NDJSON 追加写 + 自动压缩 |
| `queue.js` | 剪辑任务队列：指纹幂等、并发 fork |
| `render-worker.js` | 渲染 Worker 子进程（IPC 回传进度） |
| `renderer.js` | 渲染管线：TTS + 字幕 + amix + FFmpeg |
| `ffmpeg.js` | FFmpeg 能力探测与三档降级 |
| `edit-capabilities/{tts,subtitle,index}.js` | 配音与字幕能力插件 |
| `collector.js` + `collect-sched.js` | 采集与去重调度 |
| `collect-adapters/{registry,local,http-provider,normalize}.js` | 4 通道适配层 + 归一化（兼容 7 种返回壳层） |
| `geo.js` + `schedule.js` | GEO 排名监测与调度 |
| `billing.js` | 订单、套餐、订阅 |
| `sites.js` | AI 秒搭建站 |
| `publish.js` / `cloudbase.js` / `cloud-relay.js` | 发布 / 云库 / 同源中继 |
| `config.js` + `preflight.js` | 环境变量守卫（生产 gate）+ 上线自检 10 项 |
| `store/queue` 之外 | `demo.js`、`samples.js`、`data-samples.js`、`multipart.js`、`zip.js`、`util.js`、`deploy.js` |
| `server/test/api.test.js` | 端到端真渲染测试（起真进程、真渲染、验 mp4 头与 ffprobe） |

### 3.5 前端源码（`src/`，index.html 的只读镜像）

| 文件 | 体量 |
|---|---|
| `runtime.js` | 54 KB |
| `matrix.js` | 100 KB |
| `geo.js` | 64 KB |
| `geosite.js` | 109 KB |
| `collector_sched.js` | 47 KB |
| `app.css` | 107 KB |

`scripts/extract-src.js` 从 index.html 导出镜像，`scripts/check-sync.js` 校验镜像是否过期（`--strict` 退出码 1）。**`src/` 是只读镜像，权威源是 `index.html`**。

### 3.6 脚本工具（`scripts/`）

| 脚本 | 作用 |
|---|---|
| `extract-src.js` / `check-sync.js` | 单向构建与同步校验（防 `.build` 双真相） |
| `pack-release.sh` / `pack-win.js` | 打包发布产物 |
| `push-dev.sh` | 推送开发版本 |
| `shot.js`、`cb-doctor.js`、`retarget-site.js`、`split-demo-data.js` | 已归档到 `archive/cleanup-20261110/dev-tools/`（一次性截图 / 旧云诊断 / 站点重定向 / 演示数据拆分） |

### 3.7 部署产物（`release/`）

| 文件 | 用途 |
|---|---|
| `deploy.ps1` | 一键部署：gate → 上传 `.new` → remote-swap → 公网 SHA256 校验，失败自动回滚 |
| `remote-swap.ps1` | 服务器端：语法检查 → 备份 → 替换 → 重启 `aizhiying-bff` → 健康检查 |
| `gate.js` | 部署前检查：server 语法 / 内联脚本 / 标记 / require 模块存在性 |
| 历史一次性脚本（`swap-*`、`clean-geo*`、`deploy-bridge*`、`diag-*` 等） | 已归档到 `archive/cleanup-20261110/release-oneoffs/` |

### 3.8 部署与基础设施

| 路径 | 内容 |
|---|---|
| `deploy/` | `bootstrap.sh`、`deploy.sh`、`dev-init.sh`、`install-cron.sh`、`renew-cert.sh`、`sync-geosite.sh`、`win/` |
| `nginx/` | `nginx.conf` + `conf.d/aizhiying.conf`（四档 limit_req、SSE 关缓冲） |
| `Dockerfile` / `docker-compose.yml` | 容器化（含 crawler 服务位 profiles: collectors） |
| `.github/workflows/ci.yml` | CI 六道闸 |
| `.env.example`（7.6 KB）/ `.env.local`（2.7 KB）/ `.env.local.example` | 环境变量模板与生产模板 |
| `tools/crawler-verify/server.js` | 合规验证桩：零依赖、返回合成样例、不抓任何平台、不含真实 PII |

### 3.9 数据与样例

| 路径 | 内容 |
|---|---|
| `data-samples/*.json` | 8 份契约样例：collect-task / edit-job / geo-keyword / geo-site / lead / order / plan / index |
| `demo/dataset.js` | 演示数据集 |
| `.data/db.json` + 11 张分表 | 主库（分表 + NDJSON） |
| `.data/assets` / `out` / `samples` / `bgm` | 素材、成片、样例、BGM |
| `.data/demo/` | 演示库（250 条线索，切生产后前台变空库不是丢数据） |
| `server/.data/out/*.mp4` | 真实渲染产物（每任务 2–3 段） |

---

## 4. 常用命令速查

```bash
# 本地起服务（前端自动探测本机 BFF）
node start-local.js            # 或 start-local.cmd
# → http://127.0.0.1:8787/app/

# 一键体检（服务器上，管理员 PowerShell）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\aizhiying\diag-bff.ps1

# 真重启（唯一可靠）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\aizhiying\restart-bff.ps1

# 查真实监听进程（不要信 .data\server.pid）
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select OwningProcess

# 健康检查
curl http://127.0.0.1:8787/v1/health
# 关键字段：ffmpeg.ok / ffmpeg.ffprobe / demo.enabled / demo.mode /
#           demo.localCollect / demo.localGeo / dataDir / collect.mode / uptime

# 同步校验（src 镜像是否过期）
node scripts/check-sync.js --strict

# 上线自检
node server/preflight.js --strict
```

---

## 5. 优先级建议

**先做（解阻塞）**
1. 线上 BFF 当前宕机 → 用 `diag-bff.ps1` 定位并恢复（大概率是 cloud-relay.js 位置或 API_TOKEN 丢失）
2. 部署同源中继热修复 + 跑 `apply-prod.ps1`（关 DEMO、关本地模拟、装 FFmpeg）

**再做（补闭环）**
3. 接一条真实采集通道（自有内容评论区优先，合规最干净）
4. 补 CRM 最小闭环 + 导出（B2）
5. 成片入 assets + publish 占位（B3）
6. GEO 变化 → 选题 → 注入剪辑文案（B7 编排层第一步）

**最后（能售卖）**
7. 多租户读隔离（X9）+ 前端逐页迁移到服务端（K8）
8. 支付接入 + 订阅落库 + 域名备案 + 私有化交付包

> 顺序原则：先修「会泄露/会丢数据」的，再修「会抖的」，最后修「会拖慢团队」的。**不要按代码美观度排序。**

---

## 6. 两句话总结

**技术底座是健康的**——零依赖、能力探测、幂等指纹、启动闸、端到端真渲染测试都做得比同规模项目扎实。问题只有两个性质：**一个安全口子（静态根越界，已在 K0 修掉）**和**一个数据结构假设（单租户 + 无编排层）**。

**但商业侧的错位比任何技术断点都更早决定它卖不卖得动**——系统现在像「给已经有运营团队的公司用的效率工具」，客户画像恰恰是「没有团队、需要有人替他把事做了」的。**先把承诺收回到能力边界内，再把能力补到承诺的高度。**
