# 本机采集桥（127.0.0.1:8801）

给「评论区获客」页面用的本机服务：扫码登录、登录态保存、浏览器采集器转发、云端设备配对。

## 一键安装（推荐）

双击 `install-bridge.cmd` 一次：

- 在 Windows 启动项里创建快捷方式，开机自动启动；
- 注册 `aizhiying://start` 协议，页面第①步「启动并连接」可以直接拉起本机桥；
- 立即启动一次并检查 `http://127.0.0.1:8801/v1/ping`。

SmartScreen 提示「未知发布者」是正常的，点 **运行** 即可。

## 手动启动

1. 双击 `start-local.cmd`，黑窗口留着别关。
2. 打开 `https://aizhiying.online/app/`，在左栏第①步点 **启动并连接**。
   - 页面取 6 位配对码后，会**新开一个本机窗口**打开
     `http://127.0.0.1:8801/v1/pair?code=…&cloud=…`；
   - 桥拿码去云端换设备令牌，成功后窗口自动关闭。
   - HTTPS 页面不能直接 `fetch` 本机地址，所以配对用顶层窗口完成，不靠 CORS。
3. 回到页面，执行端显示「采集器已连接」。

默认端口 **8801**，只监听 `127.0.0.1`，不对局域网开放。

## 扫码登录（二维码显示在中间栏）

HTTPS 页面拿不到 `http://127.0.0.1:8801`，所以登录走**本机桥主动外连云端**：

```
页面 → 云端 POST /v1/collect/login/start
云端 ← 本机桥 GET  /v1/device/login/next（设备令牌）
本机桥：启动 Chrome → CDP 截图二维码 → POST 回云端
页面：轮询 /v1/collect/login/:id/status，<img> 读 /v1/collect/login/:id/qr
```

- 中间栏出现二维码，也可以直接扫本机 Chrome 窗口里的码。
- 登录成功后，本机 Chrome 用户目录（`browser_data/<profileDir>`）里会写入
  `.login-ok.json`；下次登录直接返回「已登录」，不再弹码。
- 需要换号/重扫时，页面点「扫码登录」会带 `force`，重新打开浏览器。

## 本机接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/ping` | 探测本机桥 |
| GET | `/v1/bridge/status` | 配对 / 扩展状态 |
| GET | `/v1/pair?code=&cloud=` | 顶层窗口配对页（HTTPS 页面用） |
| POST | `/v1/pair` | 同机页面直接配对 |
| POST | `/v1/login/start` | 直接启动登录（本机调试用） |
| GET | `/v1/login/status` | 直接登录状态 |
| GET | `/v1/login/qr` | 登录页截图（本机调试用） |
| POST | `/v1/login/cancel` | 取消直接登录 |
| GET/POST | `/v1/plugin/*` | 浏览器扩展报到 / 领活 / 回传 |

## 云端中转接口（设备令牌）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/device/login/next` | 桥领登录任务 |
| POST | `/v1/device/login/:id/qr` | 桥回传二维码（base64 + mime） |
| POST | `/v1/device/login/:id/status` | 桥回传状态 |
| GET | `/v1/device/login/:id/state` | 桥查询页面是否取消 |

## 注意

- 本目录里的 MediaCrawler 导出读取部分是非商用研究用途，**不要打进部署包**
  （`scripts/pack-win.js` 已排除 `tools/mediacrawler-bridge/`）。
- 本机桥无鉴权，只监听回环地址；不要在公网机器上改成 `0.0.0.0`。
- 二维码截图只截页面像素；不读取、不上传 Cookies 的值。
