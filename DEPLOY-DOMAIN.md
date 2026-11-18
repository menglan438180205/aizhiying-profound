# AI智盈 · 上线到 https://www.aizhiying.online

> **2026-11-10 现状（以此为准）**：域名 NS 已在 Cloudflare（`carlane/rick.ns.cloudflare.com`），
> 线上通过 **Cloudflare Tunnel** 指向 Windows Server 的 `http://127.0.0.1:8787`，生产目录 `C:\aizhiying`。
> 本文下方「DNSPod / 没有 A 记录 / 买 Linux 服务器」是 2026-10-18 的历史方案，仅作参考，不要再照它改 DNS。
>
> 目标：让自家域名跑起这套系统。~~当前状态：域名买了，但还没指向任何地方。~~
> 本文按「先诊断 → 再选型 → 最后照命令执行」组织，可以只挑需要的章节看。

---

## 0. 结论先说（三句话）

1. **域名没坏，是没配置。** `aizhiying.online` 已注册、DNS 托管在腾讯云 DNSPod（NS：`status.dnspod.net` / `arc.dnspod.net`），但**没有任何 A 记录**——`@` 空、`www` 返回 NXDOMAIN。所以现在谁也访问不到。
2. **本平台的在线发布给不了你这个域名。** 它只能分配自带的随机子域（用于快速预览/分享），不支持绑定任意外部域名。想要 `www.aizhiying.online`，必须有一台**公网服务器**让域名指过去。
3. **上线路径唯一且已备好：** 买服务器 → DNS 加 A 记录 → 跑两个脚本。项目和容器配置原本就是完备的（Dockerfile / Compose / Nginx 含 TLS、SSE、大文件上传），我已把站点配置绑定到你的域名，并把上线脚本补齐。

**唯一的阻塞项是：需要一台公网服务器。** 代码侧没有欠账。

---

## 1. 域名现状体检（实测，2026-10-18）

| 查询 | 结果 | 含义 |
|---|---|---|
| `NS aizhiying.online` | `status.dnspod.net` / `arc.dnspod.net` | 已注册，DNS 在腾讯云 DNSPod |
| `A aizhiying.online` | 无记录 | 根域名没指向任何服务器 |
| `A www.aizhiying.online` | NXDOMAIN | `www` 主机名根本不存在 |
| `https://www.aizhiying.online` | 无法连接 | 因为上面两条，必然失败 |
| `SOA` | `arc.dnspod.net`，serial `1792252589` | 域名正常服役中 |

复检命令（配完 DNS 用它确认生效）：

```bash
nslookup www.aizhiying.online 8.8.8.8
```

---

## 2. 选购服务器（这一节最关键，选错地域会白等半个月）

### 2.1 先讲红线：ICP 备案

**中国大陆地域的服务器，未备案域名访问 80/443 会被直接阻断**（不含祖国港澳台地区）。
`.online` 域名可以正常备案，流程约 **7–20 个工作日**，且要求域名已完成实名认证。

所以地域决定了你的等待时间：

| 选项 | 地域 | 备案 | 何时能用 | 说明 |
|---|---|---|---|---|
| **A（推荐）** | 中国香港 / 新加坡 | **免备案** | 当天 | 立刻上线验证业务。后续做完备案可再迁回内地 |
| B | 中国大陆 | 必须 | +7~20 天 | 延迟最低、国内访问最快，适合正式商用 |

> 建议走 **A**：先把站点跑起来看效果、给客户演示；备案可以同时并行申报，审核通过后再迁移，不浪费等待时间。

### 2.2 配置怎么选

这套系统的 **AI 剪辑渲染（FFmpeg）是 CPU 密集型**，是靠服务器一帧帧转码出来的，不像静态网页那样省资源。

| 用途 | 推荐配置 | 说明 |
|---|---|---|
| 演示 / 个人试用 | 2 核 4G | 能跑，但一个渲染任务会占满 CPU，多人并发会排队 |
| **正式使用（推荐）** | **4 核 8G** | 渲染 + Node 服务 + Nginx 有余量，支持 2 路并发渲染 |
| 多客户 / 商用 | 8 核 16G | 按 `RENDER_CONCURRENCY` 调高并发 |

其他要求：系统盘 ≥ 60G SSD（成片与素材很占空间）、Ubuntu 22.04 / 24.04、**必须带公网 IP**。

### 2.3 成本参考

> 下方价格为**第三方优惠渠道 2026-10 时点的汇总，仅供预算参考，实际以云控制台实时报价为准。**

| 方案 | 参考月费 |
|---|---|
| 腾讯云轻量 · 中国香港 · 2核4G · 约 200Mbps | ~95 元/月 |
| 腾讯云轻量 · 中国香港 · 4核8G · 约 200Mbps | ~230–280 元/月 |
| 腾讯云轻量 · 中国大陆 · 4核8G（年付活动） | ~880 元/年（新客活动价） |

**省钱路径**：先买 2核4G 试跑一周，看 `/v1/metrics` 里的 CPU 与队列水位；不够用再在线升配（轻量支持热升级，不用重装系统）。

**为什么推荐腾讯云**：你的 DNS 在 DNSPod，与腾讯云同控制台，DNS 解析配置更顺手，备案也能一起办。

---

## 3. 上线步骤（照着执行即可）

### Step 1 · 买服务器，记下公网 IP

买好后记下 **公网 IPv4 地址**，下文记作 `<IP>`。

### Step 2 · 云控制台放行端口（最容易漏的一步）

- 腾讯云轻量 → 控制台「**防火墙**」页
- 腾讯云 / 阿里云 CVM → 「**安全组**」

放行：**TCP 22（SSH）、80（HTTP）、443（HTTPS）**。

> 这一步漏了，后面所有操作都正常，但浏览器就是打不开 —— 而且报错信息不会告诉你是端口被拦了。

### Step 3 · 加 DNS 解析

登录 [DNSPod 控制台](https://console.dnspod.cn) → 域名解析 → `aizhiying.online`，添加：

| 主机记录 | 记录类型 | 记录值 | TTL |
|---|---|---|---|
| `@` | A | `<IP>` | 600 |
| `www` | A | `<IP>` | 600 |

生效 1–10 分钟。确认：

```bash
nslookup www.aizhiying.online 8.8.8.8
# 应返回 <IP>
```

### Step 4 · 本机打包

项目根目录**不是 git 仓库**（无 remote），服务器上没法 clone，所以要打包上传。

```bash
bash scripts/pack-release.sh
```

产物在 `release/aizhiying-<时间戳>.tar.gz`。已自动剔除本地的 `.data/`（运行时素材/成片，通常几百 MB）、`.build/` 备份、以及含本机密钥的 `.env.local`。

上传到服务器：

```bash
scp release/aizhiying-*.tar.gz root@<IP>:/tmp/
```

### Step 5 · 服务器初始化（只跑一次）

```bash
ssh root@<IP>

mkdir -p /opt/aizhiying
tar -xzf /tmp/aizhiying-*.tar.gz -C /opt/aizhiying
cd /opt/aizhiying
chmod +x deploy/*.sh
sudo bash deploy/bootstrap.sh
```

它会自动安装 Docker / Compose / Certbot、放通端口，并打印你的公网 IP 供核对。

### Step 6 · 一键上线

```bash
cd /opt/aizhiying
sudo bash deploy/deploy.sh
```

脚本依次完成：代码完整性检查 → **DNS 自检**（域名没解析到本机就直接报错并告诉你该填什么）→ 生成 `.env` 与 `API_TOKEN` → 签发 Let's Encrypt 证书 → 构建启动容器 → 健康验证。

**结尾会打印一串 `API_TOKEN`，只显示这一次，务必保存。**

### Step 7 · 首次使用：设置令牌

生产模式强制要求接口令牌（这是刻意设计，避免接口裸奔）。打开 https://www.aizhiying.online/app ，按 F12 打开控制台执行：

```js
PF.setToken('上一步显示的令牌')
```

执行后刷新页面即可。清除用 `PF.clearToken()`。

### Step 8 · 装证书自动续期

```bash
sudo bash deploy/install-cron.sh
```

> 为什么需要它：Certbot 用 standalone 签发时要占 80 端口，而线上 Nginx 常驻 80 —— Certbot 自带的自动续期会静默失败，等证书过期那天站点才突然挂掉。这个脚本接管了续期，并在失败时也会保证 Nginx 被重新拉起。

---

## 4. 验收清单

```bash
# 1. 接口健康
curl -s https://www.aizhiying.online/v1/health | head -40
#    关注：ffmpeg.ok = true、config.guard.ok = true

# 2. 页面
curl -s -o /dev/null -w '%{http_code}\n' https://www.aizhiying.online/app   # 期望 200

# 3. HTTP 自动跳转 HTTPS
curl -s -o /dev/null -w '%{redirect_url}\n' http://www.aizhiying.online

# 4. SSE 实时性（不要被攒批）
curl -N "https://www.aizhiying.online/v1/events?stream=1" --max-time 10
```

浏览器侧确认：`/app` 打开正常 → 登录后**上传一张图跑通一次 AI 剪辑** → 成片能下载播放。

---

## 5. 故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器一直转圈/连接被拒 | 安全组没放行 443 | 回到 Step 2 |
| `deploy.sh` 报「还没有解析记录」 | DNS 没配或没生效 | Step 3，重跑脚本即可（可重复执行） |
| 证书签发失败 `Connection refused` | 80 端口被占或未放行 | 先 `docker compose stop nginx`，确认 80 放行 |
| 容器起来就退出，日志有「拒绝启动」 | 生产守卫拦截 | 检查 `.env` 的 `API_TOKEN` 是否为空 |
| 页面打开后接口全 401 | 未设置令牌 | 浏览器执行 `PF.setToken('...')` |
| 成片中文字幕是方块 | 缺中文字体 | 镜像内已装 `fonts-noto-cjk`，若改动过镜像请检查 `RENDER_FONT` |
| 接口有数据但不实时 | Nginx 缓冲 SSE | 确认 `nginx/conf.d` 里 `/v1/geo/stream` 的 `proxy_buffering off` |
| 上传报 413 | Nginx 限制 | `client_max_body_size` 需 ≥ `MAX_UPLOAD_BYTES` |

日常运维：

```bash
docker compose logs -f bff      # 看日志
docker compose ps               # 看容器状态
curl -s https://www.aizhiying.online/v1/metrics | head -50   # 看水位
```

---

## 6. 额外收益：微信登录终于能闭环了

之前排查出的「微信扫码登录失败」和「账号池无法扫码」，根因之一就是**缺少一个公网 HTTPS 域名** —— 微信 OAuth 的回调地址不允许是 `localhost`，必须是公网可达且合规的域名。

站点上线到 `https://www.aizhiying.online` 之后，回调地址就可以合法配置为：

```
https://www.aizhiying.online/app/oauth/callback
```

届时还需要两步（缺一不可）：
1. 在云后端把该地址登记为合法的 `callback_url`；
2. 在微信开放平台把该域名加入授权回调域。

> 另外重申一条合规红线：**个人微信没有官方 API**，所以「自动加好友/群控」这条路走不通，账号池功能已改为走企业微信/服务商授权。不要尝试用第三方协议库扫码托管个人号。

---

## 7. 附：数据与安全提醒

- 数据在 Docker 具名卷 `bff-data`（含订单、线索、成片索引），**不可再生**；建议加每日备份（见 `DEPLOY.md` 第 6 节）。
- `.env` 含接口令牌，权限已设 600，**不要提交到任何代码仓库**。
- 支付回调 `/v1/billing/notify` 上线后请按支付网关出口 IP 收紧白名单。
