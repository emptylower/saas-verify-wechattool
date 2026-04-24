# SaaS 后端集成指南

本文说明 SaaS 业务系统如何接入本服务。

## 推荐数据模型

业务系统不需要保存真实微信号。建议保存：

```text
platform_account_id
wechat_binding_status
wechat_binding_ref
verified_at
```

本服务内部绑定身份是：

```text
tenant_id + wechat_official_account_appid + openid
```

## 新手任务集成流程

### 1. 用户打开免费额度任务

SaaS 后端为当前登录用户创建 pending bind intent：

```http
POST /v1/tenants/{tenantId}/pending-bind-intents
```

请求体：

```json
{
  "platformAccountId": "user_123",
  "ttlSeconds": 600,
  "correlationId": "onboarding_task_abc"
}
```

`platformAccountId` 必须是业务系统能唯一识别用户账号的值。可以是用户 ID、邮箱、用户名，但不要使用用户可以随意改动的昵称。

### 2. 页面展示公众号验证指引

页面展示：

- 公众号二维码。
- 用户需要发送的平台账号。
- 验证状态刷新按钮或轮询。

推荐前端每 2 到 5 秒查询一次业务后端，不要让浏览器直接拿本服务的 `clientSecret`。

### 3. 用户发送平台账号到公众号

微信回调进入本服务，本服务完成：

- 校验微信签名。
- 解析 `OpenID`。
- 查询微信关注状态。
- 查找 pending bind intent。
- 执行一对一绑定。

### 4. SaaS 后端查询绑定状态

业务后端调用：

```http
GET /v1/tenants/{tenantId}/bindings/{platformAccountId}
```

当返回：

```json
{
  "binding_status": "bound",
  "is_bound": true
}
```

即可发放免费额度并开放后续任务。

## 安全建议

- `clientSecret` 只能保存在 SaaS 后端，不能出现在浏览器、移动端、日志、前端配置。
- `platformAccountId` 应使用不可歧义的稳定账号标识。
- pending bind intent 设置较短有效期，推荐 5 到 10 分钟。
- 免费额度发放必须由 SaaS 后端完成，不要把“是否发额度”的决策放在本服务。
- 如果用户重复发送消息，本服务会对同一绑定对返回幂等成功。
- 如果同一个 `OpenID` 尝试绑定其他平台账号，本服务会拒绝。
- 如果其他 `OpenID` 尝试绑定已绑定的平台账号，本服务会拒绝。

## 失败处理

常见失败和用户提示：

- `missing_or_expired_pending_intent`：请回到网站重新点击微信验证。
- `wechat_already_bound`：该微信已绑定其他平台账号。
- `platform_account_already_bound`：该平台账号已绑定其他微信。
- `missing_platform_account_id`：请发送正确的平台账号。

## 查询审计记录

排查用户反馈时调用：

```http
GET /v1/tenants/{tenantId}/audit/attempts?platformAccountId=user_123
```

审计记录可以判断用户是否发错账号、验证是否过期、是否触发一对一绑定冲突。
