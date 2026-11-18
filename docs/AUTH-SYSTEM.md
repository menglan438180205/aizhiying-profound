# 注册 / 登录系统说明（当前版本）

更新时间：2026-11-18

## 1. 设计定位

当前是**单工作区 SaaS 账号体系**：

- 一个部署 = 一个工作区
- 工作区内有 owner / admin / member 三种角色
- 注册采用**邀请码**，不开放匿名注册
- 数据隔离仍按单一工作区处理；多租户独立工作区尚未启用

> 当前生产已开启邀请码注册。owner 可在「系统 → 风控与设置 → 邀请码与自助注册」里直接修改，保存后立即生效，写入服务器 `.data/auth-settings.json`（权限 600）。
> `.env.local` 的 `REGISTER_CODE` 仍作为首次/兜底值；后台保存过设置后以文件为准。邀请码不要放进代码仓库或前端。
> 没有直接开放匿名注册，是因为 GEO / 采集 / 客户数据还没有全部按租户隔离。

## 2. 登录流程

```text
打开 /app/
  ↓
读取 localStorage 里的 pf.auth.token
  ↓
GET /v1/auth/me 验证
  ├─ 有效 → 进入应用，state.session.user 带上 name/company/role/tenant
  └─ 无效/过期 → 清票 → 登录页
```

旧版本的问题是：只要本地有 token 就直接进应用，token 过期后进入一个空壳页面：

- 账号 0
- 作品 0
- 漏斗一直加载
- 执行端假离线

现在已改为**先验证再进应用**。

## 3. 注册流程

```text
登录页 → 注册
  ↓
手机号 + 密码 + 确认密码
  ↓
姓名 + 公司/工作区名称
  ↓
邀请码（后台设置）
  ↓
POST /v1/auth/register
  ↓
创建 member 账号 → 自动登录
```

注册入口只有在服务端允许邀请码注册时才显示。

### 后台设置邀请码（推荐）

owner 登录后进入：

```text
系统 → 风控与设置 → 邀请码与自助注册
```

可以：

- 打开/关闭「允许新成员凭邀请码注册」
- 修改邀请码（6–64 位字母、数字、下划线或短横线）
- 随机生成、复制邀请码
- 复制注册链接
- 保存后立即生效，无需重启 BFF

保存位置是服务器 `.data/auth-settings.json`，权限 600；内容包含当前开关、邀请码、修改时间和修改人。前端只有 owner 能读取/写入，非 owner 调接口返回 403。

### `REGISTER_CODE` 兜底

如果从未在后台保存过设置，服务端会读取 `.env.local` 的 `REGISTER_CODE`：

```env
REGISTER_CODE=你的邀请码
COMPANY_NAME=你的公司名
```

后台保存过一次后，以 `.data/auth-settings.json` 为准；改 `.env.local` 不再覆盖后台设置。要回到 env 兜底，删除 `.data/auth-settings.json` 并重启 BFF。

关闭注册：以后台开关为准；如果从未保存过后台设置，也可以把 `REGISTER_CODE=` 设为空。

## 4. 账号字段

登录返回的用户：

```json
{
  "id": "u...",
  "phone": "199****0001",
  "name": "管理员",
  "company": "ProFound",
  "tenant": "default",
  "role": "owner"
}
```

角色：

- `owner`：工作区所有者
- `admin`：管理员
- `member`：普通成员

当前前端已显示公司/角色；成员权限的细粒度控制后续再补。

## 5. 密码

### 修改密码（已登录）

顶栏头像 → **修改密码**：

- 原密码
- 新密码（至少 8 位）
- 确认新密码
- 保存后自动换发新会话票

接口：

```http
POST /v1/auth/password
```

### 忘记密码

登录页 → **忘记密码？**

当前没有接短信/邮件通道，所以走人工：

```text
请联系管理员重置密码；当前未接短信/邮件服务
```

后续接 SMTP 或短信服务商后，可补：

- 邮件重置链接
- 短信验证码
- 一次性 reset token

## 6. 退出登录

顶栏头像 → **退出登录**：

- 清除 `pf.auth.token`
- 清除 `pf.bff.token`
- 调 `/v1/auth/logout`
- 调 `/v1/session` 清 Cookie
- 回到登录页

服务端会话票是无状态的，退出以客户端清票为准。

## 7. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/auth/status` | 登录页初始化：注册开关、公司名、用户数 |
| POST | `/v1/auth/register` | 邀请码注册 |
| POST | `/v1/auth/login` | 手机号 + 密码登录 |
| POST | `/v1/auth/logout` | 退出 |
| POST | `/v1/auth/forgot` | 忘记密码（当前转人工） |
| GET | `/v1/auth/me` | 当前身份 |
| POST | `/v1/auth/password` | 修改密码 |
| GET | `/v1/auth/settings` | 读取邀请码/注册开关（仅 owner/admin） |
| PUT | `/v1/auth/settings` | 保存邀请码/注册开关（仅 owner/admin，立即生效） |

## 8. 安全策略

- 密码：scrypt + 随机盐
- 会话票：HMAC-SHA256 签名，30 天有效期
- 登录失败：同 IP 10 分钟 6 次锁定
- 注册：必须邀请码（或 owner 显式关闭注册）
- 密码最小长度：8 位
- 邀请码管理：仅 owner/admin；设置文件 `.data/auth-settings.json`，权限 600
- 密钥：使用 `API_TOKEN` 作为 HMAC secret；换 token 会让全部会话失效

## 9. 当前边界

1. **单工作区**：注册用户加入默认工作区，不创建独立租户。
2. **未接邮件/短信**：忘记密码只能联系管理员。
3. **角色未做细粒度鉴权**：owner/admin/member 已写入票和用户信息，但业务接口尚未全部按角色限制。
4. **多租户隔离未完成**：GEO、采集、客户数据仍有部分全局表，不能开放匿名注册。

## 10. 如果要升级成完整多租户 SaaS

需要按顺序补：

1. 注册时创建独立 tenant + owner
2. 所有业务表加 tenant 过滤（GEO org/packs/assets/sites/channels、采集任务/作品/线索、客户/订单）
3. 管理后台：用户列表、邀请、禁用、重置密码
4. 邮件/短信服务：验证、找回密码
5. 套餐/配额按 tenant 计费
6. 审计日志与操作权限

在这些完成前，保持邀请码注册是安全的。
