# 团队协作指南

## 分支与提交

- `main` 保持可部署；不要直接往 `main` 推功能代码。
- 每个功能/修复开一个短分支：
  ```bash
  git switch -c feat/collect-queue
  # 开发、构建、验证
  git add ...
  git commit -m "feat: 评论队列支持暂停和恢复"
  git push -u origin feat/collect-queue
  ```
- 提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀；一个提交只做一件事。
- 合并前至少一位同事 Review；涉及鉴权、支付、部署、数据迁移的改动必须 Review。

## 提交前检查

```bash
npm run build       # 只改前端时
npm run check       # index.html 必须与 src/ 一致
node release/gate.js
```

服务端改动另做语法检查：

```bash
node --check server/index.js
# 或对改动文件逐个执行
```

涉及接口的改动，补充/更新 `data-samples/` 示例或 `docs/` 说明。不要把真实客户数据写进测试。

## 不要提交的内容

以下内容由 `.gitignore` 拦截，仍然要在提交前确认：

- `.env.local`、`*.pem`、`*.key`、任何真实 Token/密码
- `.data/`（业务数据、素材、成片）
- `tools/mediacrawler-bridge/browser_data/`、`data/`、`inbox/`、`bridge-config.json`
- `docs/invite-code-settings.png` 等含邀请码/手机号/客户信息的截图
- `node_modules/`、`.build/`、`.workbuddy/`、日志、录屏、压缩包

如果误提交密钥：不要只 `git rm`。先轮换密钥，再通知维护者清理历史。

## 代码风格

- 前端仍是原生 JS/CSS，不引入构建框架；新逻辑放对应 `src/js/NN-*.js`，按现有加载顺序注册。
- 服务端零 npm 依赖；新增模块用 CommonJS `require`，不要引入第三方包，除非团队明确同意。
- 文件存储继续走现有 store 封装；不要在路由里直接拼 `.data/` 路径。
- 面向非技术用户的文案要短、明确；新增按钮要有 loading/失败提示。

## 部署

- 只有维护者可以部署生产；开发同学用本地实例验证。
- 生产发布：`release/deploy-linux.ps1 -Files ...`，详见 `README.md` 和 `docs/MIGRATION-UBUNTU-2026-11-18.md`。
- 部署后必须验证 `/v1/health`、登录、核心页面，再通知团队。

## Issue / PR

- Issue 写清楚：现象、复现步骤、期望结果、实际结果、环境。
- PR 描述包含：改了什么、为什么、怎么验证、风险点、截图（如有）。
- 不把生产密码、客户手机号、邀请码贴到 Issue/PR。
