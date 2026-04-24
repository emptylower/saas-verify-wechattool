# 微信公众号接入指南

本文面向 SaaS 站长，说明如何把自己的微信公众号接入本服务。

## 你需要准备什么

- 一个可登录的微信公众号后台。
- 一个公网 HTTPS 域名，能访问本服务。
- 本服务中的一个 `tenantId`，例如 `demo-tenant`。
- 本服务配置文件中的 `clientId`、`clientSecret`、`wechatToken`、`wechatAppId`、`wechatAppSecret`。

## 从公众号后台取得配置

进入微信公众号后台后，打开开发相关页面，找到开发者配置。

需要记录：

- `AppID`：填入本服务配置的 `wechatAppId`。
- `AppSecret`：填入本服务配置的 `wechatAppSecret`。
- 服务器配置 `Token`：可以由你自己生成一串随机字符串，填入本服务配置的 `wechatToken`。
- `EncodingAESKey`：V1 使用明文模式，先不需要写入服务配置，但建议保存，后续升级加密模式会用到。

如果公众号后台要求配置 IP 白名单，把运行本服务的服务器出口 IP 加入白名单。否则获取 `access_token`、查询用户信息、拉关注者列表可能失败。

## 配置本服务

复制示例配置：

```bash
cp config/integrations.example.json config/integrations.local.json
```

编辑 `config/integrations.local.json`：

```json
{
  "tenants": {
    "your-tenant": {
      "clientId": "your-host-client-id",
      "clientSecret": "your-host-client-secret",
      "wechatToken": "same-token-as-wechat-console",
      "wechatAppId": "wx1234567890abcdef",
      "wechatAppSecret": "your-official-account-appsecret"
    }
  }
}
```

启动：

```bash
WVB_CONFIG_PATH=./config/integrations.local.json npm start
```

## 配置公众号服务器 URL

在微信公众号后台的服务器配置中填写：

```text
https://your-domain.com/wechat/your-tenant/webhook
```

其他配置：

- `Token`：必须和 `wechatToken` 完全一致。
- 消息加解密方式：V1 选择明文模式。
- `EncodingAESKey`：可随机生成并保存，但 V1 明文模式不会使用。

提交配置时，微信会向本服务发送一次 `GET /wechat/:tenantId/webhook` 验证请求。本服务会校验签名并返回 `echostr`。

## 用户绑定流程

1. 用户登录 SaaS 网站。
2. SaaS 后端调用本服务创建 pending bind intent。
3. 网站页面引导用户关注公众号。
4. 用户向公众号发送自己的平台账号，例如邮箱、用户名、用户 ID。
5. 微信把消息 POST 到本服务 webhook。
6. 本服务读取 `FromUserName` 作为 `OpenID`，读取 `Content` 作为平台账号。
7. 本服务查询微信用户信息，确认该 `OpenID` 仍关注公众号。
8. 本服务检查是否存在未过期的 pending bind intent。
9. 绑定成功后，SaaS 后端查询绑定状态并发放免费额度。

## 用户侧推荐文案

在 SaaS 网站的新手任务中可以这样写：

```text
第一步：完成微信验证
请关注我们的公众号，并向公众号发送你的平台账号：{platformAccountId}
系统验证成功后，会自动解锁免费额度。
```

公众号关注后的自动回复可以这样写：

```text
请发送你在平台上的账号，完成微信验证绑定。
```

## 常见问题

### 能拿到真实微信号吗？

不能。微信官方接口不会返回用户真实微信号、手机号、实名身份。

本服务使用 `OpenID`。`OpenID` 是用户在某一个公众号下的唯一标识，足够完成“一个微信身份只能绑定一个平台账号”的反薅羊毛需求。

### 用户取关后怎么办？

V1 绑定成功后不会自动解绑。你可以在发放后续额度前调用 `GET /v1/tenants/:tenantId/wechat/users/:openId` 二次确认 `subscribe` 状态。

### 为什么本地测试收不到微信回调？

微信服务器必须访问公网 URL。本地开发需要使用公网隧道或部署到一台公网服务器。

### 什么时候需要加密模式？

V1 为了最快落地使用明文模式。生产环境如果对消息内容传输有更高要求，再升级到兼容模式或安全模式，并接入 `EncodingAESKey` 解密。
