# 微信公众号接入指南

本文面向 SaaS 站长，说明如何在新版微信开发者平台完成公众号接入，并把配置回填到本项目控制台。

> Web 版图文教程：启动服务后打开 `/console/wechat-setup.html`。

## 0. 先明确两个配置端

接入要配置两边：

1. **微信开发者平台**：拿到 `AppID`、`AppSecret`，配置 API IP 白名单，启用消息推送。
2. **本项目控制台**：保存接入标识、SaaS API 凭据、微信 `Token`、`AppID`、`AppSecret`，以及闭环回调接口。

消息推送 URL 的格式固定是：

```text
https://your-domain.com/wechat/{tenantId}/webhook
```

其中 `{tenantId}` 就是控制台里的「接入标识」。它只是这条接入的内部名字，例如 `acme-prod`。

## 1. 进入新版公众号开发者后台

旧的公众号开发配置入口已经迁移。现在从这里登录：

```text
https://developers.weixin.qq.com/
```

登录后：

1. 进入 **我的业务与服务**。
2. 在 **我的业务** 里选择 **公众号**。
3. 点击要接入的公众号，进入公众号开发者后台。

## 2. 获取 AppID 和 AppSecret

进入公众号详情页后，在基础信息与开发密钥区域：

- 复制 `AppID`，填入本项目控制台的 `微信 AppID`。
- 启用或重置 `AppSecret`，填入本项目控制台的 `微信 AppSecret`。
- 不要把 `AppSecret` 写入公开文档、截图、前端代码或日志。

示例打码：

```text
AppID: wx8bd26******20c6
AppSecret: ************
```

## 3. 启用 API IP 白名单

在开发密钥区域找到 **API IP 白名单**，把运行本服务的服务器出口 IP 加入白名单。

如果不加，换取微信 `access_token` 会失败，典型错误是：

```json
{
  "errcode": 40164,
  "errmsg": "invalid ip ... not in whitelist"
}
```

本项目 V1 在公众号没有 `user/info` 权限时也能完成绑定，因为微信消息回调里的 `FromUserName` 已经是该公众号下的唯一 `OpenID`。但 `access_token` 仍建议配置通，用于后续扩展关注状态校验、关注者列表、运维诊断。

## 4. 启用消息推送

在 **域名与消息推送配置** 区域找到 **消息推送**，点击 **启用** 或 **编辑**。

填写：

```text
URL:
https://your-domain.com/wechat/{tenantId}/webhook

Token:
建议使用微信页面随机生成的 Token

消息加密方式:
明文模式

数据格式:
XML
```

注意：

- `Token` 必须和本项目控制台的 `微信 Token` 完全一致。
- 不要手写带短横线的 token；如果微信提示「请输入正确的 Token」，直接使用页面随机生成值。
- `EncodingAESKey` 在明文模式下不会被本项目 V1 使用；如果页面强制要求，可以随机生成并保存备用。
- 保存后必须确认消息推送处于 **启用** 状态。保存成功不等于已启用。

## 5. 回填本项目控制台

打开：

```text
http://127.0.0.1:3000/console
```

填写：

| 控制台字段 | 来源 | 说明 |
| --- | --- | --- |
| `接入标识` | 自定义 | 原 `Tenant ID`。给这条接入起一个稳定名字，例如 `acme-prod`，会出现在 webhook URL 中。 |
| `SaaS API Key` | 自定义 | 原 `Host Client ID`。SaaS 后端调用本服务 API 时使用。 |
| `SaaS API Secret` | 自定义 | 原 `Host Client Secret`。只能保存在 SaaS 后端，不要暴露给浏览器。 |
| `微信 Token` | 微信消息推送配置 | 必须和微信开发者平台里填的一致。 |
| `微信 AppID` | 公众号详情页 | 复制 AppID。 |
| `微信 AppSecret` | 开发密钥区域 | 复制或重置 AppSecret。 |
| `绑定前确认接口` | SaaS 后端 | 推荐。收到公众号消息后，本服务先问 SaaS 是否允许绑定该账号。 |
| `绑定结果接收接口` | SaaS 后端 | 推荐。绑定成功或失败后，本服务主动通知 SaaS。 |
| `回调签名密钥` | 自定义 | 可选。用于 SaaS 校验本服务发出的回调签名。 |

保存后，控制台会长期写入 `WVB_CONFIG_PATH` 指向的 JSON 文件。

## 6. SaaS 后端验证流程

用户要领取免费额度时，SaaS 后端先创建待绑定会话：

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/tenants/acme-wechat/pending-bind-intents \
  -H 'content-type: application/json' \
  -H 'x-client-id: your-host-client-id' \
  -H 'x-client-secret: your-host-client-secret' \
  -d '{
    "platformAccountId": "user_123",
    "ttlSeconds": 600,
    "correlationId": "onboarding-free-quota"
  }'
```

然后引导用户：

```text
请关注我们的公众号，并向公众号发送你的平台账号：user_123
```

如果配置了「绑定前确认接口」，本服务会先调用 SaaS 后端确认该账号是否有效。返回 `{"allowed": true}` 后才会写入绑定。

绑定成功后，SaaS 后端可以等待「绑定结果接收接口」的主动通知，也可以继续查询：

```bash
curl -sS http://127.0.0.1:3000/v1/tenants/acme-wechat/bindings/user_123 \
  -H 'x-client-id: your-host-client-id' \
  -H 'x-client-secret: your-host-client-secret'
```

返回：

```json
{
  "binding_status": "bound",
  "is_bound": true
}
```

即可发放免费额度。

## 7. 验收标准

必须验证这三件事：

1. 第一次发送正确平台账号，绑定成功。
2. 同一个微信号再次发送另一个平台账号，返回 `wechat_already_bound`，不能绑定第二个用户。
3. 另一个微信号发送已绑定的平台账号，返回 `platform_account_already_bound`，不能抢占账号。

## 常见问题

### 能拿到真实微信号吗？

不能。微信官方不会返回真实微信号、手机号、实名信息。本项目使用公众号下的 `OpenID`，足够实现「一个微信身份只能绑定一个平台账号」。

### 为什么绑定状态里是 `wechat_subscribe_status: unchecked`？

这表示公众号没有 `user/info` 权限或未开启相关能力。本项目仍可基于消息回调里的 `OpenID` 完成绑定。

### 为什么用户发消息后项目收不到？

优先检查：

- 消息推送 URL 是否是公网 HTTPS。
- URL 中的 `{tenantId}` 是否和本项目控制台「接入标识」一致。
- Token 是否完全一致。
- 消息推送是否已启用。
- 数据格式是否是 XML。

### 本地开发怎么暴露公网 URL？

可以使用临时隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

把生成的 `https://*.trycloudflare.com/wechat/{tenantId}/webhook` 填到微信消息推送 URL。
