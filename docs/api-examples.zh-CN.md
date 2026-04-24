# API 调用示例

以下示例默认：

- 服务地址：`http://127.0.0.1:3000`
- 租户：`demo-tenant`
- `clientId`：`demo-client`
- `clientSecret`：`demo-secret`

## 健康检查

```bash
curl -sS http://127.0.0.1:3000/health
```

预期：

```json
{
  "status": "ok"
}
```

## 创建待绑定会话

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/tenants/demo-tenant/pending-bind-intents \
  -H 'content-type: application/json' \
  -H 'x-client-id: demo-client' \
  -H 'x-client-secret: demo-secret' \
  -d '{
    "platformAccountId": "alice",
    "ttlSeconds": 600,
    "correlationId": "onboarding-free-quota"
  }'
```

返回示例：

```json
{
  "id": "intent-id",
  "tenantId": "demo-tenant",
  "platformAccountId": "alice",
  "createdAt": "2026-04-24T10:00:00.000Z",
  "expiresAt": "2026-04-24T10:10:00.000Z",
  "consumedAt": null,
  "correlationId": "onboarding-free-quota"
}
```

## 查询绑定状态

```bash
curl -sS http://127.0.0.1:3000/v1/tenants/demo-tenant/bindings/alice \
  -H 'x-client-id: demo-client' \
  -H 'x-client-secret: demo-secret'
```

绑定成功后：

```json
{
  "tenant_id": "demo-tenant",
  "platform_account_id": "alice",
  "binding_status": "bound",
  "is_bound": true,
  "bound_at": "2026-04-24T10:01:00.000Z",
  "wechat_binding_ref": "2df67c3a05faa891",
  "wechat_official_account_appid": "wx1234567890abcdef",
  "wechat_subscribe_status": "subscribed",
  "reason_code": null
}
```

未绑定时：

```json
{
  "tenant_id": "demo-tenant",
  "platform_account_id": "alice",
  "binding_status": "unbound",
  "is_bound": false,
  "bound_at": null,
  "wechat_binding_ref": null,
  "wechat_official_account_appid": null,
  "wechat_subscribe_status": null,
  "reason_code": "binding_not_found"
}
```

## 查询微信关注状态

需要配置 `wechatAppId` 和 `wechatAppSecret`。

```bash
curl -sS http://127.0.0.1:3000/v1/tenants/demo-tenant/wechat/users/OPENID \
  -H 'x-client-id: demo-client' \
  -H 'x-client-secret: demo-secret'
```

返回：

```json
{
  "open_id": "OPENID",
  "union_id": null,
  "subscribe": true,
  "subscribe_time": 1713945600
}
```

## 拉关注者 OpenID 列表

```bash
curl -sS 'http://127.0.0.1:3000/v1/tenants/demo-tenant/wechat/followers' \
  -H 'x-client-id: demo-client' \
  -H 'x-client-secret: demo-secret'
```

分页继续拉取：

```bash
curl -sS 'http://127.0.0.1:3000/v1/tenants/demo-tenant/wechat/followers?nextOpenId=NEXT_OPENID' \
  -H 'x-client-id: demo-client' \
  -H 'x-client-secret: demo-secret'
```

## 查询绑定尝试审计

```bash
curl -sS 'http://127.0.0.1:3000/v1/tenants/demo-tenant/audit/attempts?platformAccountId=alice' \
  -H 'x-client-id: demo-client' \
  -H 'x-client-secret: demo-secret'
```

## 本地模拟微信消息

真实生产环境由微信服务器调用 webhook。本地可以用签名模拟：

```bash
TS=1713945600
NONCE=nonce-1
TOKEN=demowechattoken
SIG=$(node -e "const crypto=require('node:crypto'); const token=process.argv[1]; const ts=process.argv[2]; const nonce=process.argv[3]; process.stdout.write(crypto.createHash('sha1').update([token,ts,nonce].sort().join('')).digest('hex'))" "$TOKEN" "$TS" "$NONCE")

XML='<xml><ToUserName><![CDATA[official-account]]></ToUserName><FromUserName><![CDATA[wechat-openid-a]]></FromUserName><CreateTime>1713945600</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[alice]]></Content><MsgId>1001</MsgId></xml>'

curl -sS -X POST "http://127.0.0.1:3000/wechat/demo-tenant/webhook?signature=$SIG&timestamp=$TS&nonce=$NONCE" \
  -H 'content-type: application/xml' \
  --data-binary "$XML"
```

预期返回 XML 文本消息，内容包含 `Binding completed successfully.`。

## 控制台管理 API

如果设置了 `WVB_ADMIN_TOKEN`，需要带上：

```bash
-H 'x-admin-token: change-me'
```

列出租户：

```bash
curl -sS http://127.0.0.1:3000/v1/admin/tenants \
  -H 'x-admin-token: change-me'
```

保存租户配置：

```bash
curl -sS -X PUT http://127.0.0.1:3000/v1/admin/tenants/demo-tenant \
  -H 'content-type: application/json' \
  -H 'x-admin-token: change-me' \
  -d '{
    "clientId": "demo-client",
    "clientSecret": "demo-secret",
    "wechatToken": "demowechattoken",
    "wechatAppId": "wx-your-official-account-appid",
    "wechatAppSecret": "your-official-account-appsecret"
  }'
```

控制台查询绑定状态：

```bash
curl -sS 'http://127.0.0.1:3000/v1/admin/bindings?tenantId=demo-tenant&platformAccountId=alice' \
  -H 'x-admin-token: change-me'
```

控制台查询最近验证尝试：

```bash
curl -sS 'http://127.0.0.1:3000/v1/admin/attempts?tenantId=demo-tenant&platformAccountId=alice' \
  -H 'x-admin-token: change-me'
```
