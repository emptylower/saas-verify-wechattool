# SaaS Verify WeChat Tool

面向 SaaS 站长的微信公众号绑定验证服务。它把“关注公众号并发送平台账号”变成一个可查询的后端绑定证明，用来降低批量注册领取免费额度的攻击收益。

V1 采用最快落地方案：站长使用自己的微信公众号 `AppID`、`AppSecret`、服务器 `Token` 接入本服务；用户关注公众号后发送 SaaS 平台账号；服务收到微信回调中的 `OpenID`，确认平台账号存在待绑定会话后完成 `OpenID <-> 平台账号` 绑定。

## 核心能力

- 接收 SaaS 后端创建的待绑定会话。
- 接收微信公众号关注事件和文本消息回调。
- 使用微信官方接口查询 `OpenID` 是否仍关注公众号。
- 绑定 `tenant_id + official_account_appid + openid <-> platform_account_id`。
- 强制 `1 个微信 OpenID <-> 1 个平台账号`，V1 不支持解绑。
- 提供绑定状态查询接口，供 SaaS 后端决定是否发放免费额度。
- 提供最小审计记录，方便排查冲突绑定、过期会话、异常消息。
- 随服务启动内置 Web 控制台，用于保存公众号配置、查看教程和查询用户验证状态。

## 不解决什么

- 不获取用户真实微信号、手机号、实名身份。
- 不证明用户是真人，只证明该公众号下的 `OpenID` 完成绑定。
- 不设计免费额度策略。
- 不支持非微信渠道验证。
- V1 不支持解绑、换绑、加密消息模式。

## 快速开始

要求 Node.js 18+。

```bash
npm test
npm start
```

默认读取：

- 配置文件：`config/integrations.example.json`
- 数据文件：`data/store.json`
- 监听端口：`3000`
- 监听地址：`127.0.0.1`
- 控制台：`http://127.0.0.1:3000/console`

生产环境建议复制一份私有配置文件：

```bash
cp config/integrations.example.json config/integrations.local.json
WVB_CONFIG_PATH=./config/integrations.local.json WVB_ADMIN_TOKEN=change-me HOST=0.0.0.0 npm start
```

## Web 控制台

启动服务后打开：

```text
http://127.0.0.1:3000/console
```

控制台可以：

- 新增或更新租户配置，并长期保存到 `WVB_CONFIG_PATH` 指向的 JSON 文件。
- 查看微信公众号接入教程和当前租户的 Webhook URL。
- 查询某个 `tenantId + platformAccountId` 的微信验证状态。
- 查看最近验证尝试，排查过期会话、发错账号和绑定冲突。

如果部署在公网，必须设置 `WVB_ADMIN_TOKEN`，并在控制台顶部输入同一个 token。未设置 token 时，管理 API 只允许 localhost 访问。

## 配置示例

```json
{
  "tenants": {
    "demo-tenant": {
      "clientId": "demo-client",
      "clientSecret": "demo-secret",
      "wechatToken": "demo-wechat-token",
      "wechatAppId": "wx-your-official-account-appid",
      "wechatAppSecret": "your-official-account-appsecret"
    }
  }
}
```

字段含义：

- `clientId` / `clientSecret`：SaaS 后端调用本服务 API 的租户鉴权凭证。
- `wechatToken`：微信公众号后台服务器配置中的自定义 `Token`。
- `wechatAppId` / `wechatAppSecret`：微信公众号开发者凭据，用于获取 `access_token`、查询关注状态、拉关注者 OpenID 列表。

## 主要接口

- `POST /v1/tenants/:tenantId/pending-bind-intents`
- `GET /v1/tenants/:tenantId/bindings/:platformAccountId`
- `GET /v1/tenants/:tenantId/audit/bindings/:platformAccountId`
- `GET /v1/tenants/:tenantId/audit/attempts`
- `GET /v1/tenants/:tenantId/wechat/users/:openId`
- `GET /v1/tenants/:tenantId/wechat/followers`
- `GET /wechat/:tenantId/webhook`
- `POST /wechat/:tenantId/webhook`

OpenAPI 文件见 [openapi/openapi.yaml](openapi/openapi.yaml)。

## 文档

- [微信公众号接入指南](docs/wechat-official-account-setup.zh-CN.md)
- [SaaS 后端集成指南](docs/saas-integration.zh-CN.md)
- [API 调用示例](docs/api-examples.zh-CN.md)
- [部署与运维说明](docs/deployment.zh-CN.md)

## 验证

```bash
npm test
npm run lint
npm run build
```

当前测试覆盖后端绑定主链路、签名校验、关注状态校验、双向唯一绑定、审计记录、微信 API 客户端缓存和无凭据降级行为。

## 重要边界

微信官方不会开放用户真实微信号。本项目使用 `OpenID` 作为绑定身份。`OpenID` 是用户在某一个公众号下的稳定唯一标识，足够用于“一个微信身份只能领取一次平台免费额度”的反薅羊毛门槛。

如果一个服务接入多个站长公众号，不能只用 `OpenID` 做全局唯一键，必须同时带上 `tenant_id` 和 `official_account_appid`。
