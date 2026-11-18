# 安全策略

## 报告问题

不要公开提交包含以下内容的 Issue：

- 生产服务器地址、SSH 私钥、管理员密码
- API Token、LLM Key、支付密钥、Cloudflare Tunnel 凭据
- 邀请码、客户手机号/微信/线索数据
- 可被直接利用的未授权接口细节

请私下联系项目维护者，并附上复现步骤和影响范围。确认修复后再决定是否公开。

## 密钥管理

- 真实配置只存在本机 `.env.local` 或服务器 `/opt/aizhiying/.env.local`，文件权限 `600`。
- 邀请码等可运营配置存 `.data/auth-settings.json`，不要写进源码或文档。
- `*.pem`、`bridge-config.json`、浏览器 `browser_data/` 都是敏感文件，已加入 `.gitignore`。
- CI 不注入生产密钥；测试使用临时目录和一次性 Token。

## 如果密钥进了 Git

1. 立即在对应平台轮换/吊销密钥。
2. 用 `git filter-repo` 清理历史，不要只删除当前文件。
3. 强制推送后通知所有协作者重新克隆。
4. 检查服务器日志是否有异常调用。

## 生产权限

- 只有维护者拥有服务器 SSH 和 Cloudflare 权限。
- 生产发布走 `release/deploy-linux.ps1`，失败自动回滚。
- 不在聊天、Issue、PR 中粘贴生产密码或邀请码。
