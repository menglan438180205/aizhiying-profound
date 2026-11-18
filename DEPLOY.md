# AI智盈 · 部署手册

> **2026-11-10 注**：当前生产是 **Windows Server + Cloudflare Tunnel**（目录 `C:\aizhiying`，
> 计划任务 `aizhiying-bff`），Windows 步骤见 `deploy/win/` 和根目录 `start-local.cmd`；
> 本文的 systemd / Docker / Nginx 段落适用于 Linux 方案。
>
> 面向运维与交付。覆盖「把 BFF 搬上生产环境」这一段的全部手工步骤。
> 代码侧的上线前自检：`node server/preflight.js --strict`（不占端口，可进 CI）

---

## 0. 一分钟判断你现在缺什么

```bash
# 在项目根目录
node server/preflight.js
```

输出会明确列出**阻断项**与**告警项**。典型输出：

```
 ✓ Node v20.11.0
 ✓ 运行模式 production
 ✓ API_TOKEN 已设置 9f2****a7(48位)
 ✓ ffmpeg 可用
 ✓ 编码与滤镜能力齐备   libx264 / aac / drawtext / zoompan / concat
 ✓ 渲染字体就绪（含中文字形） /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
 ✓ 前端入口就绪 589 KB
 ✓ 数据目录可写（含原子 rename）
--------------------------------------------------------------
 阻断 0 项 · 告警 0 项 · 检查 11 项
 结果：通过，可以启动服务。
```

`--strict` 把告警也算失败；`--json` 输出机器可读结果，便于流水线断言。

---

## 1. 架构与端口约定

```
                公网
                 │ 80 / 443
                 ▼
        ┌──────────────────┐
        │   Nginx (TLS)    │  限流 · HSTS · SSE 不缓冲 · 大文件直转
        └────────┬─────────┘
                 │ bff:8787（仅容器网络内可达，不映射宿主机端口）
                 ▼
        ┌──────────────────────────────┐
        │  BFF + 渲染 Worker + 调度器   │
        │  · /app   前端单文件 SPA      │  同源 → 零跨域
        │  · /v1/*  接口族              │
        │  · /files/* 成片（HTTP Range）│
        │  · RenderQueue → FFmpeg       │
        │  · GeoScheduler / CollectScheduler │
        └──────────────┬───────────────┘
                       │ 持久卷 /data
                       ▼
                 db.json + assets/ + out/
```

**为什么 BFF 不直接暴露端口**：它没有内置 TLS、限流、防爆破。直接对公网开放等于把 `/v1/*` 全部接口（下单、提交渲染、读取订单）裸露出去。

---

## 2. 容器化部署（推荐）

### 2.1 准备

```bash
git clone <repo> && cd <repo>

# 1) 环境变量
cp .env.example .env
#    至少要填 API_TOKEN：
echo "API_TOKEN=$(openssl rand -hex 24)" >> .env
#    然后按需填 COLLECT_UPSTREAM / GEO_UPSTREAM / PAY_* 等

# 2) TLS 证书（正式环境用真实证书；内网自测用自签）
mkdir -p nginx/certs
# 自签（仅测试）：
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout nginx/certs/privkey.pem -out nginx/certs/fullchain.pem \
  -subj "/CN=localhost"
```

### 2.2 启动

```bash
docker compose up -d --build
docker compose ps            # bff 应为 healthy
docker compose logs -f bff   # 看启动横幅
```

启动横幅会打印**环境变量收口的自检结论**、FFmpeg 能力、字体状态、两条调度器的通道模式。

### 2.3 验证

```bash
curl -k https://localhost/v1/health | python3 -m json.tool | head -40
# 关键字段：
#   "ffmpeg": { "ok": true, "capabilities": { "ready": true }, "font": { "cjk": true } }
#   "config": { "mode": "production", "guard": { "ok": true, "warnings": 0 } }
#   "collect": { "mode": "upstream" | "unconfigured" }
#   "geo":     { "mode": "upstream" | "unconfigured" }
```

浏览器打开 `https://<域名>/app` → 应看到登录页；打开 `https://<域名>/` 是服务端状态页。

---

## 3. 裸机部署（无 Docker）

```bash
# 依赖
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-noto-cjk

# 环境（写进 systemd unit 或 /etc/profile.d/）
export NODE_ENV=production
export HOST=127.0.0.1          # 由 Nginx 反代，不直接对公网
export PORT=8787
export DATA_DIR=/var/lib/aizhiying
export API_TOKEN=$(openssl rand -hex 24)
export RENDER_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
export TRUST_PROXY=1

# 自检 → 启动
node server/preflight.js --strict
node server/index.js
```

### systemd unit 示例

```ini
# /etc/systemd/system/aizhiying-bff.service
[Unit]
Description=AI智盈 BFF + 渲染 Worker
After=network.target

[Service]
Type=simple
User=aizhiying
WorkingDirectory=/opt/aizhiying
EnvironmentFile=/etc/aizhiying/env
ExecStartPre=/usr/bin/node server/preflight.js --strict
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
# 优雅退出：服务端会停掉两条调度器并把 db.json 落盘
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/aizhiying

[Install]
WantedBy=multi-user.target
```

> `ExecStartPre` 里的 `preflight` 会在**每次重启前**重新自检 —— 这样即使有人手工改坏了环境变量，服务也不会带着问题起来。

---

## 4. 环境变量收口（最关键的一节）

服务端内置了守卫：`NODE_ENV=production` 时，只要存在**阻断项**就会以退出码 `78` 拒绝启动。

| 阻断项 | 后果 | 修复 |
|---|---|---|
| `API_TOKEN` 未设置 | 所有 `/v1/*` 无鉴权，任何人可下单、可提交渲染、可读订单 | `API_TOKEN=$(openssl rand -hex 24)` |
| `QA_MODE=1` | 暴露 `.build` 目录 + 开启 `/v1/qa/report` 上报后门 | 取消设置 |
| `ALLOW_LOCAL_COLLECT=1` | 上游未接时**用生成的假评论冒充采集结果**，会把假线索写进业务库 | 取消设置，改配 `COLLECT_UPSTREAM` |
| `ALLOW_LOCAL_GEO=1` | 用本地算法生成 AI 收录排名，`AI 曝光率` 变成自说自话 | 取消设置，改配 `GEO_UPSTREAM` |

**为什么用「拒绝启动」而不是「警告」**：这三项一旦漏上生产，功能看起来完全正常，但对外输出的是假数据 —— 不报错的故障最难发现。宁可起不来。

确实需要在生产上临时带病启动时（不推荐）：

```bash
ALLOW_INSECURE_BOOT=1 node server/index.js
```

此时：
- 进程会启动，但横幅与状态页会明确标注「豁免启动」与原阻断项；
- **`QA_MODE` 会被强制关闭**（它是攻击面，不是业务选择）。

告警项（不阻断，但要在意）：

| 告警 | 说明 |
|---|---|
| `API_TOKEN` 长度 < 16 | 强度不足 |
| `COLLECT_UPSTREAM` 有值但 `COLLECT_TOKEN` 为空 | 上游大概率返回 401 |
| `GEO_UPSTREAM` 有值但 `GEO_TOKEN` 为空 | 同上 |
| `PAY_GATEWAY` 有值但 `PAY_MCH_ID` 为空 | 支付回调无法对账 |
| 生产 + 监听 `0.0.0.0` 但未设 `TRUST_PROXY` | 确认由 Nginx 终止 TLS |
| 生产 + 未显式设置 `DATA_DIR` | 数据落在镜像内，容器重建即丢 |

---

## 5. Nginx 的三个必做项

`nginx/conf.d/aizhiying.conf` 里已经写好，这一节解释**为什么**：

### 5.1 SSE 路径必须关缓冲

```nginx
location = /v1/geo/stream {
  proxy_buffering off;   # ← 关键
  proxy_cache     off;
  gzip            off;
  proxy_read_timeout 3600s;
  proxy_set_header X-Accel-Buffering no;
}
```

Nginx 默认开启 `proxy_buffering`，会把 SSE 事件攒成一批再下发。前端看起来仍有数据、页面也没报错，但「实时变化」已经退化成「批量推送」—— 语义错了，功能测试还测不出来。

### 5.2 上传与大文件

```nginx
location = /v1/edit/jobs {
  client_max_body_size    512m;
  proxy_request_buffering off;   # 边收边转，不先落 Nginx 磁盘
  proxy_read_timeout      600s;
}
location /files/ {
  proxy_buffering off;           # Range 请求立刻回 206，播放器可拖动
  proxy_force_ranges on;
}
```

`client_max_body_size` 必须 ≥ 服务端 `MAX_UPLOAD_BYTES`，否则会在 Nginx 就 413。

### 5.3 限流与安全头

`limit_req_zone` 已按接口分桶：一般接口 20 r/s、上传 2 r/s、支付回调 10 r/s，另有按 IP 的并发连接限制（SSE 长连接常驻，给了 32 的余量）。安全头包含 HSTS / nosniff / `X-Frame-Options` / `Referrer-Policy`。

支付回调 `location = /v1/billing/notify` 内预留了 IP 白名单，**正式上线请按支付网关出口 IP 收紧**。

---

## 6. 数据与备份

| 路径 | 内容 | 是否可再生 |
|---|---|---|
| `/data/db.json` | 渲染任务、订单、事件、GEO 任务、调度任务、运行记录、线索池 | **不可再生** |
| `/data/assets/` | 上传的素材（按指纹去重） | 可重传 |
| `/data/out/` | 成片与封面 | 可重渲 |
| `/data/tmp/` | 渲染中间文件（正常会自清） | 无所谓 |

```bash
# 每日热备（db.json 是原子写，直接 cp 即一致）
mkdir -p /backup/aizhiying
cp /var/lib/aizhiying/db.json /backup/aizhiying/db-$(date +%F).json
gzip -f /backup/aizhiying/db-$(date +%F).json
# 只保留 30 天
find /backup/aizhiying -name 'db-*.json.gz' -mtime +30 -delete
```

---

## 7. 持续集成

`.github/workflows/ci.yml` 六道关卡：

1. **语法检查** —— 服务端全部 `.js` + 四个前端分层 bundle
2. **拼装幂等性** —— 按规范顺序复跑 `.build/*.py` 两轮，`index.html` 必须逐字节一致；并断言四层增强标记各自唯一
3. **上线前自检** —— development 与 production 两套环境变量各跑一次 `preflight --strict`
4. **生产守卫负向测试** —— 缺 `API_TOKEN` / 危险开关非空时必须退出码 78；豁免路径必须强制关掉 `QA_MODE`
5. **服务端测试** —— 接口、渲染、GEO、采集调度、cron 纯函数
6. **六套浏览器回归** —— 运行时层 / 采集器 / 矩阵获客 / GEO / 真实剪辑（headless Chrome）

本地复现整套：

```bash
CHROME_PATH=/usr/bin/google-chrome python3 .build/runqa_rt.py
CHROME_PATH=/usr/bin/google-chrome python3 .build/runqa.py
CHROME_PATH=/usr/bin/google-chrome python3 .build/runqa_mx.py
CHROME_PATH=/usr/bin/google-chrome python3 .build/runqa_geo.py
CHROME_PATH=/usr/bin/google-chrome python3 .build/runqa_real.py
node server/test/api.test.js
```

> QA 脚本会自动寻找 `CHROME_PATH` / `CHROME_BIN`，未设置时回退到 Windows 默认安装路径。

---

## 8. 上线检查表（照着点）

- [ ] `node server/preflight.js --strict` 全绿
- [ ] `.env` 里没有 `QA_MODE` / `ALLOW_LOCAL_COLLECT` / `ALLOW_LOCAL_GEO`
- [ ] `API_TOKEN` 是 48 位随机串，且已存入密钥管理而不是聊天记录
- [ ] `DATA_DIR` 指向持久卷，并已接入每日备份
- [ ] `docker compose ps` 两个容器 healthy
- [ ] `https://<域名>/v1/health` 里 `config.guard.ok === true`
- [ ] `https://<域名>/app` 可打开、可登录、可上传一张图跑通剪辑
- [ ] SSE 实时性已验证（打开 GEO 页，触发一轮监测，变化应在 1 秒内出现而非攒批）
- [ ] Nginx 支付回调已按网关出口 IP 收紧
- [ ] `docker compose logs bff | grep 阻断` 无输出

---

## 9. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 容器起来就退出，日志有 `拒绝启动` | 生产守卫拦截 | 按日志逐项修复环境变量；临时豁免用 `ALLOW_INSECURE_BOOT=1` |
| `ffmpeg 缺失` | 镜像未装 ffmpeg 或 `FFMPEG_PATH` 指错 | `apt-get install -y ffmpeg`；或设 `FFMPEG_PATH` |
| 渲染任务全失败、日志有 `missing libx264` | FFmpeg 构建不完整 | 换用发行版完整包；`preflight` 会提前报出 |
| 成片里中文字幕是方块 | 字体无中文字形 | `apt-get install -y fonts-noto-cjk`，并设 `RENDER_FONT` |
| 接口全部 401 | 设了 `API_TOKEN` 但前端未带令牌 | 前端「设置 → 配置服务端」重新保存；SSE 走 `?token=` |
| `/v1/comments/collect` 返回 501 | 未配 `COLLECT_UPSTREAM` | 配置上游；**不要**用 `ALLOW_LOCAL_COLLECT` 在生产顶替 |
| 采集调度一直「未接入」 | 同上 | 同上；`/v1/collect/config` 的 `stats.mode` 会如实说明 |
| SSE 有数据但不实时 | Nginx 缓冲 | 确认 `/v1/geo/stream` 的 `proxy_buffering off` 生效 |
| 上传 413 | Nginx 限制 | 调大 `client_max_body_size` 并与 `MAX_UPLOAD_BYTES` 对齐 |
| 成片不能拖动播放 | `/files/` 缓冲或未透传 Range | 保留 `proxy_buffering off` 与 `proxy_force_ranges on` |
| 容器重建后订单没了 | `DATA_DIR` 未挂卷 | 挂载持久卷并设 `DATA_DIR=/data` |
| GEO/采集调度 30s 巡检但从不执行 | 通道未接通（刻意设计，不造数据） | 配 `GEO_UPSTREAM` / `COLLECT_UPSTREAM` |

---

## 鉴权与运维接口（2026-10 更新）

### 开启 API_TOKEN 后怎么用

服务端设置 `API_TOKEN` 后，所有 `/v1/*`（除 `/v1/health`、`/v1/metrics`、`/v1/session`）都要凭证。三种等价方式：

| 场景 | 用法 |
|---|---|
| 浏览器（推荐） | 控制台或设置页执行 `PF.setToken('你的令牌')` —— 会写入 localStorage 并自动换成 `pf_bff` HttpOnly Cookie |
| 脚本 / CI | `Authorization: Bearer <token>` |
| EventSource / 无法设头的场景 | `/v1/events?stream=1&token=<token>` |
| 清除 | `PF.clearToken()` |

> 首次部署建议先不设 token 把功能跑通，再设 token 并执行一次 `PF.setToken()` 验证；
> 服务端 `GET /v1/session` 会返回 `{auth:'ok'|'required'|'open'}`，可用来判断当前状态。

### 新增运维接口

- `GET /v1/metrics` —— 请求数、状态码分布、p50/p95/p99、队列水位、各表行数、SSE 连接数、内存
- `GET /v1/metrics?format=prom` —— Prometheus 文本格式，可直接挂探针
- `GET /v1/tenants` —— 按 `owner` 统计各表记录数（多客户隔离自检）
- `GET /v1/events?stream=1` —— SSE 实时事件流（心跳 15s，支持 `Last-Event-ID` 断线补发）

### 数据目录变化

旧版单文件 `db.json` 会在首次启动时自动拆分到 `db/` 子目录（每表一个文件，线索/运行记录为 NDJSON），
原文件归档为 `db.json.migrated-<时间戳>`。**回滚前请先把 `db.json.migrated-*` 改回 `db.json`**。

### 渲染进程

默认渲染跑在子进程（`server/render-worker.js`），主进程只处理 API 与调度。
排障时可设 `RENDER_INLINE=1` 退回进程内执行；`/v1/metrics` 的 `queue.mode` 会显示 `worker` 或 `inline`。
