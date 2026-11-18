# 生产迁移记录：Windows → Ubuntu（2026-11-18）

## 结论

- 生产已切到 Ubuntu：`ubuntu@62.234.109.9`
- 访问入口不变：`https://www.aizhiying.online/app/`
- 域名和 Cloudflare Tunnel 不变，DNS 不需要改
- 旧 Windows 服务器 `118.25.44.79` 已停止 BFF，Cloudflare Tunnel 服务已禁用，保留作回滚

## 服务器与目录

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 24.04.4 LTS，x86_64 |
| 配置 | 2 vCPU / 1.9 GiB RAM / 50 GB 磁盘 / 1.9 GiB swap |
| 应用目录 | `/opt/aizhiying` |
| 数据目录 | `/opt/aizhiying/.data` |
| 环境文件 | `/opt/aizhiying/.env.local`（600，仅 root 可读） |
| 运行用户 | `aizhiying`（系统用户，无登录 shell） |
| BFF 监听 | `127.0.0.1:8787` |
| 公网入口 | Cloudflare Tunnel → `127.0.0.1:8787` |

## systemd 服务

```bash
sudo systemctl status aizhiying
sudo systemctl restart aizhiying
sudo journalctl -u aizhiying -n 100 --no-pager

sudo systemctl status cloudflared
sudo systemctl restart cloudflared
sudo journalctl -u cloudflared -n 100 --no-pager
```

两个服务都已 `enable`，服务器重启后会自动拉起。

## 迁移时修正的环境项

- `FFMPEG_PATH=/usr/bin/ffmpeg`
- `FFPROBE_PATH=/usr/bin/ffprobe`
- `RENDER_CONCURRENCY=1`（2 GB 内存，避免并发渲染 OOM）
- 其余生产配置保留：`HOST=127.0.0.1`、`PORT=8787`、`DATA_DIR=.data`、`GEO_MODE=manual`、`PAY_PROVIDER=mock`、`REGISTER_CODE` 等

## 数据迁移

1. 旧服务器停止 BFF 后，打包 `.data`（不含日志和 pid）
2. 新服务器解压到 `/opt/aizhiying/.data`
3. 切换前只同步了最后变化的 3 个文件：
   - `db/collect_accounts.json`
   - `db/collect_tasks.json`
   - `db/collect_runs.ndjson`
4. `meta.json` 取新旧 `seq` 的较大值，避免 ID 回退
5. 切换前数据备份：`/opt/aizhiying/.data/db.pre-cutover-*`

## 验证结果

- 本地 `/v1/health`：200
- 公网 `https://www.aizhiying.online/v1/health`：200
- 公网 `https://aizhiying.online/v1/health`：200
- `/v1/auth/status`：`users=2`、`register=code`
- 管理员登录：200，`role=owner`、`company=ProFound`
- 作品、任务、账号、线索接口均返回 200
- AI 剪辑端到端：提交 → 渲染 → 产出 MP4 → 公网可访问，全部通过
- 渲染能力：FFmpeg 6.1.1、libx264、aac、drawtext、zoompan、subtitles、中文 Noto 字体、espeak-ng 配音

## 已知差异

- 旧 Windows 用系统 SAPI（Huihui）中文配音；Ubuntu 用 `espeak-ng`，机器音更明显
- 云服务器不能直接访问用户电脑上的 `127.0.0.1:8801`；评论区获客仍走“本机桥主动连云端 + 浏览器扩展”的原有链路，本机桥需要在用户电脑上启动一次
- 旧的 `release/deploy.ps1` 面向 Windows，已加迁移提示；Linux 发布用 `release/deploy-linux.ps1`

## 回滚

旧机保留至少 7 天。回滚步骤：

1. 在新服务器停服务：

   ```bash
   sudo systemctl stop cloudflared
   sudo systemctl stop aizhiying
   ```

2. 在旧 Windows 服务器恢复：

   ```powershell
   sc config cloudflared start= auto
   sc start cloudflared
   # 启动原 BFF（按旧机实际启动方式）
   ```

3. 确认 `https://www.aizhiying.online/v1/health` 返回旧机 uptime，再决定是否继续排查新机。

回滚会丢失切换后在新机产生的数据；如需保留，先备份 `/opt/aizhiying/.data`。
