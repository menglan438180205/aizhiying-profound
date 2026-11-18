# AI 智盈 ProFound

[![CI](https://github.com/menglan438180205/aizhiying-profound/actions/workflows/ci.yml/badge.svg)](https://github.com/menglan438180205/aizhiying-profound/actions/workflows/ci.yml)

面向企业增长的全栈工作台：AI 评论区获客、GEO 优化、AI 智能剪辑、AI 数字人、客户管理与经营分析。

> GitHub 私有仓库：<https://github.com/menglan438180205/aizhiying-profound>（需要仓库所有者邀请）。

- **前端**：`src/` → `scripts/build.js` → 单文件 `index.html`（无前端框架、无 npm 运行时依赖）
- **后端**：`server/`，Node.js BFF，文件存储 `.data/`（JSON/NDJSON，无数据库）
- **渲染**：FFmpeg + libass
- **本机执行端**：`tools/mediacrawler-bridge`（本机桥）+ `tools/browser-collector`（Chrome/Edge 扩展），负责真实浏览器扫码登录、采集和评论
- **线上**：Ubuntu + systemd + Cloudflare Tunnel，入口 `https://www.aizhiying.online/app/`

> 本仓库只保存代码、模板和文档。`.data/`、`.env.local`、浏览器登录态、邀请码截图等运行数据**绝不入库**，详见 [安全与密钥](#安全与密钥)。

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | 18+，推荐 22 LTS | BFF、构建、测试 |
| FFmpeg / ffprobe | 5.x+ | AI 剪辑渲染（可选，不跑渲染可不装） |
| Git | 2.40+ | 协作 |
| Chrome / Edge | 最新版 | 本机桥和采集扩展 |

项目没有 npm 依赖，**不需要 `npm install`**；`package.json` 只提供脚本。

## 本地启动

```bash
git clone https://github.com/menglan438180205/aizhiying-profound.git aizhiying
cd aizhiying

# 1. 生成本地配置（不要提交）
cp .env.local.example .env.local
# 编辑 .env.local，至少设置 API_TOKEN、ADMIN_PHONE、ADMIN_PASSWORD
# Linux/macOS 的 FFMPEG_PATH 用 /usr/bin/ffmpeg，Windows 用 C:\ffmpeg\bin\ffmpeg.exe

# 2. 启动 BFF
npm start
# 或：node start-local.js
```

> 如果本机访问 `github.com:443` 超时，可改用 GitHub 的 SSH 443 端口：
> `git remote set-url origin ssh://git@ssh.github.com:443/menglan438180205/aizhiying-profound.git`
> 需要先把本机 SSH 公钥添加为仓库 Deploy Key（勾选 write）或账号 SSH Key。

打开 <http://127.0.0.1:8787/app/>，用 `.env.local` 里的管理员手机号和密码登录。

数据默认写入 `.data/`。首次启动会自动建目录和初始管理员；演示模式使用 `.data/demo/`。

常用命令：

```bash
npm run build        # src/ -> index.html
npm run check        # 校验 index.html 与 src/ 一致
npm run start        # 前台启动
node start-local.js --daemon   # 后台启动（Windows 友好）
node start-local.js --status   # 查看运行状态
node start-local.js --stop     # 停止
node release/gate.js           # 发布前静态检查
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `server/` | BFF：路由、鉴权、文件存储、渲染队列、采集/GEO/计费 |
| `src/` | 前端源码：`js/`、`css/`、`tpl/index.tpl.html` |
| `index.html` | 构建产物；**不要直接改**，改 `src/` 后重新构建 |
| `scripts/` | 构建、校验、数据初始化脚本 |
| `release/` | 发布门禁和部署脚本 |
| `deploy/` | Linux / Windows 部署与恢复脚本 |
| `docs/` | 架构、认证、数据、迁移和验收文档 |
| `tools/browser-collector/` | Manifest V3 浏览器扩展 |
| `tools/mediacrawler-bridge/` | 本机桥（`127.0.0.1:8801`） |
| `data-samples/` | 接口示例数据，不含真实业务数据 |

## 开发约定

1. **改前端只改 `src/`**，然后执行 `npm run build`；提交前执行 `npm run check`。
2. 服务端改完先做语法检查：`node --check server/index.js`（或对改动文件逐个执行）。
3. 提交前至少跑：
   ```bash
   npm run check
   node release/gate.js
   ```
4. 不要提交生成物之外的临时文件、日志、截图、录屏、`.data/`、`.env.local`。
5. 详细协作流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 本机执行端（可选）

评论区获客依赖本机 Chrome/Edge，不在服务器上跑：

1. 启动本机桥：
   - Windows：双击 `tools/mediacrawler-bridge/start-local.cmd`
   - 或：`node tools/mediacrawler-bridge/server.js`
2. 在应用左栏点「启动并重连」，按提示扫码登录平台账号。
3. 在 `chrome://extensions` / `edge://extensions` 打开开发者模式，加载 `tools/browser-collector/`。
4. 本机桥首次配对会写入 `tools/mediacrawler-bridge/bridge-config.json`，该文件含设备令牌，**不要提交**。

## 部署

当前生产为 Ubuntu + systemd + Cloudflare Tunnel。发布使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File release\deploy-linux.ps1 -Files `
  index.html,server\auth.js,server\index.js
```

脚本会：跑 `release/gate.js` → 上传到 `/tmp/aizy-deploy` → 远端备份 → `node --check` → 安装到 `/opt/aizhiying` → 重启 `aizhiying` → 健康检查，失败自动回滚。

首次部署、systemd、Tunnel、数据迁移和回滚步骤见 [`docs/MIGRATION-UBUNTU-2026-11-18.md`](docs/MIGRATION-UBUNTU-2026-11-18.md)。旧 Windows 部署脚本仅作历史参考，不再使用。

## 安全与密钥

- **绝不提交**：`.env.local`、`*.pem`、`*.key`、`.data/`、`tools/mediacrawler-bridge/browser_data/`、`bridge-config.json`、`inbox/`、含邀请码/手机号/客户数据的截图。
- `.env.local.example` 是占位模板，可以提交；真实值只放本机或服务器。
- 邀请码、管理员密码、API Token、LLM Key、支付密钥只通过环境变量或后台设置保存，不写进源码。
- 如果密钥曾进入 Git 历史，仅删除文件不够；必须**立即轮换**，再用 `git filter-repo` 清理历史。
- 安全问题请按 [`SECURITY.md`](SECURITY.md) 私下联系维护者，不要公开提 Issue。

## 文档索引

- [认证与邀请码](docs/AUTH-SYSTEM.md)
- [数据结构](docs/DATA-STRUCTURE-2026-11.md)
- [GEO 外部资料清单](docs/GEO-EXTERNAL-DATA-CHECKLIST.md)
- [Ubuntu 迁移记录](docs/MIGRATION-UBUNTU-2026-11-18.md)
- [最新版本与测试步骤](LATEST.md)
