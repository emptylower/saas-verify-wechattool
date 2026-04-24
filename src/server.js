import http from 'node:http';
import { URL } from 'node:url';

import { authenticateHost } from './lib/auth.js';
import { loadConfig, getTenantConfig } from './lib/config.js';
import { HttpError } from './lib/errors.js';
import { readJsonBody, sendJson, sendText, sendXml, handleError, readRequestBody } from './lib/http.js';
import { JsonStore } from './lib/store.js';
import { BindingService } from './lib/service.js';
import { WeChatOfficialAccountClient } from './lib/wechat_api.js';
import { buildWeChatTextResponse, parseWeChatXml, verifyWeChatSignature } from './lib/wechat.js';

function matchRoute(method, pathname) {
  const segments = pathname.split('/').filter(Boolean);

  if (method === 'GET' && pathname === '/health') {
    return { name: 'health', params: {} };
  }

  if (segments[0] === 'v1' && segments[1] === 'tenants' && segments[3] === 'pending-bind-intents') {
    if (method === 'POST' && segments.length === 4) {
      return { name: 'createPendingBindIntent', params: { tenantId: segments[2] } };
    }
  }

  if (segments[0] === 'v1' && segments[1] === 'tenants' && segments[3] === 'bindings') {
    if (method === 'GET' && segments.length === 5) {
      return {
        name: 'getBindingStatus',
        params: { tenantId: segments[2], platformAccountId: decodeURIComponent(segments[4]) }
      };
    }
  }

  if (segments[0] === 'v1' && segments[1] === 'tenants' && segments[3] === 'audit') {
    if (method === 'GET' && segments[4] === 'bindings' && segments.length === 6) {
      return {
        name: 'getAuditBinding',
        params: { tenantId: segments[2], platformAccountId: decodeURIComponent(segments[5]) }
      };
    }

    if (method === 'GET' && segments[4] === 'attempts' && segments.length === 5) {
      return { name: 'listAttempts', params: { tenantId: segments[2] } };
    }
  }

  if (segments[0] === 'v1' && segments[1] === 'tenants' && segments[3] === 'wechat') {
    if (method === 'GET' && segments[4] === 'followers' && segments.length === 5) {
      return { name: 'listWeChatFollowers', params: { tenantId: segments[2] } };
    }

    if (method === 'GET' && segments[4] === 'users' && segments.length === 6) {
      return {
        name: 'getWeChatUserInfo',
        params: { tenantId: segments[2], openId: decodeURIComponent(segments[5]) }
      };
    }
  }

  if (segments[0] === 'wechat' && segments.length === 3 && segments[2] === 'webhook') {
    if (method === 'GET') {
      return { name: 'verifyWeChatWebhook', params: { tenantId: segments[1] } };
    }

    if (method === 'POST') {
      return { name: 'receiveWeChatWebhook', params: { tenantId: segments[1] } };
    }
  }

  return null;
}

function getTenantOrThrow(config, tenantId) {
  const tenantConfig = getTenantConfig(config, tenantId);

  if (!tenantConfig) {
    throw new HttpError(404, 'tenant_not_found', `Unknown tenant: ${tenantId}`);
  }

  return tenantConfig;
}

function getMessageReply(result) {
  switch (result.outcome) {
    case 'bound':
      return 'Binding completed successfully.';
    case 'idempotent_success':
      return 'This WeChat account is already bound to that platform account.';
    case 'rejected_wechat_already_bound':
      return 'This WeChat account is already bound to another platform account.';
    case 'rejected_platform_account_already_bound':
      return 'This platform account is already bound to another WeChat account.';
    case 'rejected_missing_or_expired_intent':
      return 'No active binding session exists for this platform account. Please restart verification in the platform.';
    case 'rejected_malformed':
      return 'The message format is invalid. Please send your platform account identifier.';
    default:
      return 'The bind request could not be processed.';
  }
}

export async function createApp({
  configPath = process.env.WVB_CONFIG_PATH ?? './config/integrations.example.json',
  dataPath = process.env.WVB_DATA_PATH ?? './data/store.json',
  officialAccountClient = new WeChatOfficialAccountClient()
} = {}) {
  const config = await loadConfig(configPath);
  const store = new JsonStore(dataPath);
  await store.ensureFile();
  const service = new BindingService({ store });

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://localhost');
      const match = matchRoute(request.method, requestUrl.pathname);

      if (!match) {
        sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
        return;
      }

      if (match.name === 'health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (match.name === 'verifyWeChatWebhook') {
        const tenantConfig = getTenantOrThrow(config, match.params.tenantId);
        const signature = requestUrl.searchParams.get('signature');
        const timestamp = requestUrl.searchParams.get('timestamp');
        const nonce = requestUrl.searchParams.get('nonce');
        const echoString = requestUrl.searchParams.get('echostr') ?? '';

        if (!signature || !timestamp || !nonce) {
          throw new HttpError(400, 'invalid_signature_params', 'Missing signature parameters.');
        }

        const isValid = verifyWeChatSignature({
          token: tenantConfig.wechatToken,
          signature,
          timestamp,
          nonce
        });

        if (!isValid) {
          throw new HttpError(401, 'invalid_signature', 'WeChat signature verification failed.');
        }

        sendText(response, 200, echoString);
        return;
      }

      if (match.name === 'receiveWeChatWebhook') {
        const tenantConfig = getTenantOrThrow(config, match.params.tenantId);
        const signature = requestUrl.searchParams.get('signature');
        const timestamp = requestUrl.searchParams.get('timestamp');
        const nonce = requestUrl.searchParams.get('nonce');

        if (!signature || !timestamp || !nonce) {
          throw new HttpError(400, 'invalid_signature_params', 'Missing signature parameters.');
        }

        const isValid = verifyWeChatSignature({
          token: tenantConfig.wechatToken,
          signature,
          timestamp,
          nonce
        });

        if (!isValid) {
          throw new HttpError(401, 'invalid_signature', 'WeChat signature verification failed.');
        }

        const xmlBody = await readRequestBody(request);
        const message = parseWeChatXml(xmlBody);

        if (message.messageType === 'event' && message.event?.toLowerCase() === 'subscribe') {
          const reply = buildWeChatTextResponse({
            toUserName: message.fromUserName,
            fromUserName: message.toUserName,
            content: '请发送你在平台上的账号，完成微信验证绑定。'
          });
          sendXml(response, 200, reply);
          return;
        }

        if (message.messageType !== 'text') {
          const reply = buildWeChatTextResponse({
            toUserName: message.fromUserName,
            fromUserName: message.toUserName,
            content: '当前只支持发送文本账号完成绑定。'
          });
          sendXml(response, 200, reply);
          return;
        }

        const wechatProfile = await officialAccountClient.getUserInfo(tenantConfig, message.fromUserName);

        if (wechatProfile && !wechatProfile.subscribe) {
          const reply = buildWeChatTextResponse({
            toUserName: message.fromUserName,
            fromUserName: message.toUserName,
            content: '请先关注公众号，再发送平台账号完成绑定。'
          });
          sendXml(response, 200, reply);
          return;
        }

        const result = await service.processWeChatMessage({
          tenantId: match.params.tenantId,
          wechatOpenId: message.fromUserName,
          platformAccountId: message.content,
          messageId: message.messageId,
          wechatAppId: tenantConfig.wechatAppId ?? null,
          wechatProfile
        });

        const reply = buildWeChatTextResponse({
          toUserName: message.fromUserName,
          fromUserName: message.toUserName,
          content: getMessageReply(result)
        });

        sendXml(response, 200, reply);
        return;
      }

      const tenantConfig = getTenantOrThrow(config, match.params.tenantId);
      authenticateHost(request, tenantConfig);

      if (match.name === 'createPendingBindIntent') {
        const body = await readJsonBody(request);
        const pendingIntent = await service.createPendingBindIntent({
          tenantId: match.params.tenantId,
          platformAccountId: body.platformAccountId,
          ttlSeconds: body.ttlSeconds ?? 600,
          correlationId: body.correlationId ?? null
        });

        sendJson(response, 201, pendingIntent);
        return;
      }

      if (match.name === 'getBindingStatus') {
        const payload = await service.getBindingStatus({
          tenantId: match.params.tenantId,
          platformAccountId: match.params.platformAccountId
        });
        sendJson(response, 200, payload);
        return;
      }

      if (match.name === 'getAuditBinding') {
        const binding = await service.getAuditBinding({
          tenantId: match.params.tenantId,
          platformAccountId: match.params.platformAccountId
        });
        sendJson(response, 200, { binding });
        return;
      }

      if (match.name === 'listAttempts') {
        const limitParam = requestUrl.searchParams.get('limit');
        const platformAccountId = requestUrl.searchParams.get('platformAccountId');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

        const attempts = await service.listAttempts({
          tenantId: match.params.tenantId,
          platformAccountId,
          limit: Number.isInteger(limit) && limit > 0 ? limit : 50
        });
        sendJson(response, 200, { attempts });
        return;
      }

      if (match.name === 'getWeChatUserInfo') {
        const user = await officialAccountClient.getUserInfo(tenantConfig, match.params.openId);

        if (!user) {
          throw new HttpError(
            400,
            'wechat_credentials_not_configured',
            'wechatAppId and wechatAppSecret are required for WeChat user lookup.'
          );
        }

        sendJson(response, 200, {
          open_id: user.openId,
          union_id: user.unionId,
          subscribe: user.subscribe,
          subscribe_time: user.subscribeTime
        });
        return;
      }

      if (match.name === 'listWeChatFollowers') {
        const followers = await officialAccountClient.listFollowerOpenIds(
          tenantConfig,
          requestUrl.searchParams.get('nextOpenId') ?? ''
        );

        if (!followers) {
          throw new HttpError(
            400,
            'wechat_credentials_not_configured',
            'wechatAppId and wechatAppSecret are required for WeChat follower lookup.'
          );
        }

        sendJson(response, 200, {
          total: followers.total,
          count: followers.count,
          open_ids: followers.openIds,
          next_open_id: followers.nextOpenId
        });
        return;
      }
    } catch (error) {
      handleError(response, error);
    }
  });

  return { server, service, config };
}
