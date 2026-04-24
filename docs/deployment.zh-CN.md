# 部署与运维说明

本项目是零依赖 Node.js HTTP 服务。V1 使用 JSON 文件存储，适合原型验证、小流量私有部署和真实公众号联调。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `127.0.0.1` | HTTP 监听地址；公网部署通常设为 `0.0.0.0` 并放在反向代理后 |
| `WVB_CONFIG_PATH` | `./config/integrations.example.json` | 租户和公众号配置文件 |
| `WVB_DATA_PATH` | `./data/store.json` | JSON 数据文件路径 |
| `WVB_ADMIN_TOKEN` | 空 | Web 控制台管理 API token；为空时只允许 localhost 管理访问 |

## 最小生产启动

```bash
WVB_CONFIG_PATH=./config/integrations.local.json \
WVB_DATA_PATH=./data/store.json \
WVB_ADMIN_TOKEN=change-me \
HOST=0.0.0.0 \
PORT=3000 \
npm start
```

建议在服务外层放置反向代理，提供 HTTPS：

```text
https://your-domain.com/wechat/{tenantId}/webhook -> http://127.0.0.1:3000/wechat/{tenantId}/webhook
https://your-domain.com/v1/* -> http://127.0.0.1:3000/v1/*
https://your-domain.com/console -> http://127.0.0.1:3000/console
```

## Web 控制台

控制台随服务启动，访问：

```text
http://127.0.0.1:3000/console
```

控制台能力：

- 新增或更新租户配置，保存到 `WVB_CONFIG_PATH` 指向的 JSON 文件。
- 展示微信公众号服务器 URL 和接入教程。
- 查询用户验证状态。
- 查看最近验证尝试。

公网部署必须设置 `WVB_ADMIN_TOKEN`。控制台会把 token 存在当前浏览器的 `localStorage`，服务端不会额外保存 admin token。

## 微信侧网络要求

- 微信服务器必须能访问你的公网 URL。
- 公众号服务器 URL 建议使用 HTTPS。
- 如果调用用户信息或关注者列表失败，检查公众号后台的 IP 白名单是否包含服务器出口 IP。
- 服务器时间应保持准确，否则排查签名问题会更困难。

## 数据存储

V1 使用单个 JSON 文件保存：

- `bindings`：绑定记录。
- `pendingBindIntents`：待绑定会话。
- `attempts`：绑定尝试审计。

注意：

- 不要把 `data/store.json` 提交到公开仓库。
- 部署时需要保证数据目录可写。
- 多实例部署时，JSON 文件存储不适合并发共享，应迁移到数据库。

## 建议的上线检查

1. `npm test`
2. `npm run lint`
3. `npm run build`
4. 使用公众号后台提交服务器 URL，确认验证通过。
5. 用真实微信关注公众号并发送平台账号。
6. 查询 `GET /v1/tenants/{tenantId}/bindings/{platformAccountId}`，确认 `is_bound: true`。
7. 测试同一个微信再次绑定另一个账号，确认被拒绝。
8. 测试另一个微信绑定已绑定账号，确认被拒绝。

## 从 JSON 迁移到数据库

当满足任一条件时，应迁移数据库：

- 需要多实例部署。
- 绑定量或审计量增长明显。
- 需要管理后台查询、导出、删除或合规审计。
- 需要更强的一致性和备份恢复能力。

数据库表建议：

- `tenants`
- `pending_bind_intents`
- `wechat_bindings`
- `binding_attempts`

唯一约束建议：

- `tenant_id + wechat_appid + wechat_openid` 唯一。
- `tenant_id + platform_account_id` 唯一。

## 日志与监控

V1 当前只返回结构化 JSON 错误，没有引入日志框架。生产化建议补：

- 请求 ID。
- webhook 签名失败计数。
- 微信 API 调用失败计数。
- 绑定成功率。
- 冲突绑定次数。
- pending bind intent 过期次数。

## 安全注意事项

- `wechatAppSecret` 和 `clientSecret` 必须只放在服务端。
- `WVB_ADMIN_TOKEN` 必须使用高强度随机值，公网部署不要留空。
- 不要在日志中输出完整 `wechatAppSecret`、`clientSecret`、`access_token`。
- API 入口应只暴露给 SaaS 后端，不建议直接给浏览器访问。
- 反向代理应限制请求体大小，避免异常 XML 或 JSON 请求消耗资源。
- 定期轮换 `clientSecret` 和微信公众号 `AppSecret`。
