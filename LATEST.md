# 最新版测试入口

更新时间：2026-11-18

## 一键测试

双击根目录：

```text
TEST-LATEST.cmd
```

它会：

1. 通过 `aizhiying://start` 拉起本机桥
2. 打开线上最新版：<https://aizhiying.online/app/>

浏览器如果询问是否打开 `aizhiying://`，点 **允许**。

## 当前版本

| 组件 | 最新版 | 位置 |
|---|---|---|
| 前端页面 | `index.html` · 2026-11-18 17:24 | 根目录，线上已部署同版本 |
| 前端源码 | `src/` | 改完执行 `node scripts/build.js` |
| 浏览器扩展 | **1.3.8** | `tools/browser-collector` |
| 本机桥 | `tools/mediacrawler-bridge/server.js` | 已安装开机启动 |
| 一键安装桥 | `tools/mediacrawler-bridge/install-bridge.cmd` | 换电脑时双击一次 |
| 官网 | `web/` | `/` 官网，`/app/` 应用 |
| 生产服务器 | Ubuntu `62.234.109.9` | `/opt/aizhiying`，`aizhiying.service` + `cloudflared.service` |

当前 `index.html` SHA256：

```text
D77AA2D69C7E6D3102084D35887567D9BBDECE31224691A6528DAF9A60DFD4E8
```

## 后台邀请码（2026-11-18）

管理员登录后：

```text
系统 → 风控与设置 → 邀请码与自助注册
```

- 开关：允许/关闭新成员凭邀请码注册
- 修改邀请码，随机生成、复制、复制注册链接
- 点「保存设置」立即生效，无需重启服务
- 保存在服务器 `/opt/aizhiying/.data/auth-settings.json`（权限 600）
- 只有 owner/admin 能查看和修改；其他角色会提示“仅所有者可改”

`.env.local` 的 `REGISTER_CODE` 只在后台从未保存过设置时作为兜底。后台保存过一次后，以 `.data/auth-settings.json` 为准。

## 测试前检查

1. Edge/Chrome 打开 `edge://extensions` 或 `chrome://extensions`
2. 把「AI智盈 · 浏览器采集器」刷新到 **1.3.8**
3. 页面左栏第①步显示 **在线**
4. 账号「采集/小时」设为 **30**，不要设为 1
5. 「评论/小时」测试可设为 **1 或 2**

## 评论测试

- 作品池按钮：**逐条评论（一次一条）**
- 一次只打开一条链接，成功关闭后再点下一次
- 失败时只保留“文字已写入但没发送”的页面
- 清空用：**清空作品+排队**，点一次即执行

## 清理说明

已移出仓库的旧文件在：

```text
C:\Users\ALIENWARE\Documents\deepseek-harness\_archive-aizhiying\cleanup-20261112
```

包含旧 `archive/`、桥的旧 inbox 快照、旧打包脚本。需要追溯时可查，不参与运行。

不要删除：

- `.data/`：本机数据
- `tools/mediacrawler-bridge/browser_data/`：登录态
- `.env.local`：本机令牌
