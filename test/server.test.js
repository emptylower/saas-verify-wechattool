import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { createApp } from '../src/server.js';
import { HttpError } from '../src/lib/errors.js';

const originalFetch = globalThis.fetch;

function createSignature(token, timestamp, nonce) {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''), 'utf8')
    .digest('hex');
}

function buildMessageXml({ toUserName, fromUserName, content, messageId }) {
  return `<xml>
<ToUserName><![CDATA[${toUserName}]]></ToUserName>
<FromUserName><![CDATA[${fromUserName}]]></FromUserName>
<CreateTime>1713945600</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
<MsgId>${messageId}</MsgId>
</xml>`;
}

function tenantMetadata(tenantId) {
  if (tenantId === 'tenant-a') {
    return {
      clientId: 'client-a',
      clientSecret: 'secret-a',
      wechatToken: 'wechat-token-a'
    };
  }

  return {
    clientId: 'client-b',
    clientSecret: 'secret-b',
    wechatToken: 'wechat-token-b'
  };
}

async function createPendingIntent(app, platformAccountId, { tenantId = 'tenant-a' } = {}) {
  const tenant = tenantMetadata(tenantId);

  return fetch(`${app.baseUrl}/v1/tenants/${tenantId}/pending-bind-intents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client-id': tenant.clientId,
      'x-client-secret': tenant.clientSecret
    },
    body: JSON.stringify({ platformAccountId })
  });
}

async function sendWebhookMessage(
  app,
  { tenantId = 'tenant-a', fromUserName, content, messageId, timestamp = '1713945600', nonce = 'nonce-default' }
) {
  const tenant = tenantMetadata(tenantId);
  const signature = createSignature(tenant.wechatToken, timestamp, nonce);

  return fetch(
    `${app.baseUrl}/wechat/${tenantId}/webhook?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/xml'
      },
      body: buildMessageXml({
        toUserName: 'official-account',
        fromUserName,
        content,
        messageId
      })
    }
  );
}

async function listAttempts(app, platformAccountId) {
  const tenant = tenantMetadata('tenant-a');

  const response = await fetch(
    `${app.baseUrl}/v1/tenants/tenant-a/audit/attempts?platformAccountId=${platformAccountId}`,
    {
      headers: {
        'x-client-id': tenant.clientId,
        'x-client-secret': tenant.clientSecret
      }
    }
  );

  return {
    response,
    body: await response.json()
  };
}

function createJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

async function startServer({ tenantOverrides = {}, officialAccountClient, adminToken = '', externalFetch } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechat-binding-server-'));
  const configPath = path.join(directory, 'integrations.json');
  const dataPath = path.join(directory, 'store.json');
  const tenants = {
    'tenant-a': {
      clientId: 'client-a',
      clientSecret: 'secret-a',
      wechatToken: 'wechat-token-a',
      ...(tenantOverrides['tenant-a'] ?? {})
    },
    'tenant-b': {
      clientId: 'client-b',
      clientSecret: 'secret-b',
      wechatToken: 'wechat-token-b',
      ...(tenantOverrides['tenant-b'] ?? {})
    }
  };

  await writeFile(
    configPath,
    JSON.stringify(
      {
        tenants
      },
      null,
      2
    )
  );

  const { handleRequest } = await createApp({ configPath, dataPath, officialAccountClient, adminToken });
  const baseUrl = 'http://127.0.0.1';
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(String(url));

    if (parsedUrl.origin !== baseUrl) {
      const externalResponse = await externalFetch?.(parsedUrl, options);

      if (externalResponse) {
        return externalResponse;
      }

      return originalFetch(url, options);
    }

    return dispatchRequest(handleRequest, parsedUrl, options);
  };

  return {
    configPath,
    baseUrl,
    async close() {
      globalThis.fetch = originalFetch;
    }
  };
}

async function dispatchRequest(handleRequest, parsedUrl, options) {
  const requestBody = options.body ? Buffer.from(String(options.body)) : Buffer.alloc(0);
  const request = Readable.from(requestBody.length ? [requestBody] : []);
  request.method = options.method ?? 'GET';
  request.url = `${parsedUrl.pathname}${parsedUrl.search}`;
  request.headers = Object.fromEntries(new Headers(options.headers ?? {}).entries());
  request.socket = { remoteAddress: '127.0.0.1' };

  const chunks = [];
  let endResponse;
  const finished = new Promise((resolve) => {
    endResponse = resolve;
  });
  const response = {
    statusCode: 200,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload = '') {
      if (payload) {
        chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
      }
      endResponse();
    }
  };

  await handleRequest(request, response);
  await finished;
  const responseBody = Buffer.concat(chunks).toString('utf8');

  return {
    status: response.statusCode,
    headers: response.headers,
    async text() {
      return responseBody;
    },
    async json() {
      return JSON.parse(responseBody);
    }
  };
}

test('supports pending bind intent creation, webhook binding, and query unlock semantics', async () => {
  const app = await startServer();

  try {
    const pendingIntentResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/pending-bind-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      },
      body: JSON.stringify({
        platformAccountId: 'alice'
      })
    });

    assert.equal(pendingIntentResponse.status, 201);

    const timestamp = '1713945600';
    const nonce = 'nonce-1';
    const signature = createSignature('wechat-token-a', timestamp, nonce);
    const webhookResponse = await fetch(
      `${app.baseUrl}/wechat/tenant-a/webhook?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/xml'
        },
        body: buildMessageXml({
          toUserName: 'official-account',
          fromUserName: 'wechat-user-a',
          content: 'alice',
          messageId: '1001'
        })
      }
    );

    assert.equal(webhookResponse.status, 200);
    const webhookBody = await webhookResponse.text();
    assert.match(webhookBody, /Binding completed successfully/);

    const statusResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      }
    });
    const statusBody = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.tenant_id, 'tenant-a');
    assert.equal(statusBody.platform_account_id, 'alice');
    assert.equal(statusBody.binding_status, 'bound');
    assert.equal(statusBody.is_bound, true);
    assert.ok(statusBody.wechat_binding_ref);
    assert.equal(statusBody.reason_code, null);

    const auditResponse = await fetch(
      `${app.baseUrl}/v1/tenants/tenant-a/audit/attempts?platformAccountId=alice`,
      {
        headers: {
          'x-client-id': tenantMetadata('tenant-a').clientId,
          'x-client-secret': tenantMetadata('tenant-a').clientSecret
        }
      }
    );
    const auditBody = await auditResponse.json();

    assert.equal(auditResponse.status, 200);
    assert.equal(auditBody.attempts.length, 1);
    assert.equal(auditBody.attempts[0].tenantId, 'tenant-a');
  } finally {
    await app.close();
  }
});

test('serves embedded console assets with admin workflow entrypoint', async () => {
  const app = await startServer();

  try {
    const consoleResponse = await fetch(`${app.baseUrl}/console`);
    const consoleBody = await consoleResponse.text();
    const scriptResponse = await fetch(`${app.baseUrl}/console/app.js`);
    const guideResponse = await fetch(`${app.baseUrl}/console/wechat-setup.html`);
    const guideBody = await guideResponse.text();
    const flowImageResponse = await fetch(`${app.baseUrl}/console/wechat-onboarding-flow.png`);
    const callbackGuideResponse = await fetch(`${app.baseUrl}/console/saas-callback-setup.html`);
    const callbackGuideBody = await callbackGuideResponse.text();
    const callbackGuideAliasResponse = await fetch(`${app.baseUrl}/console/saas-callback-setup`);

    assert.equal(consoleResponse.status, 200);
    assert.match(consoleBody, /SaaS Verify WeChat Console/);
    assert.match(consoleBody, /wechat-setup\.html/);
    assert.match(consoleBody, /wechat-onboarding-flow\.png/);
    assert.match(consoleBody, /saas-callback-setup\.html/);
    assert.equal(scriptResponse.status, 200);
    assert.match(await scriptResponse.text(), /v1\/admin\/tenants/);
    assert.equal(guideResponse.status, 200);
    assert.match(guideBody, /新版微信开发者平台流程/);
    assert.match(guideBody, /消息推送/);
    assert.match(guideBody, /saas-callback-setup\.html/);
    assert.doesNotMatch(guideBody, /u-sync-hero\.svg/);
    assert.equal(flowImageResponse.status, 200);
    assert.equal(flowImageResponse.headers['content-type'], 'image/png');
    assert.equal(callbackGuideResponse.status, 200);
    assert.match(callbackGuideBody, /SaaS 回调端接入指南/);
    assert.match(callbackGuideBody, /回调签名校验/);
    assert.match(callbackGuideBody, /pane-node/);
    assert.match(callbackGuideBody, /pane-py/);
    assert.match(callbackGuideBody, /pane-go/);
    assert.match(callbackGuideBody, /pane-php/);
    assert.equal(callbackGuideAliasResponse.status, 200);
  } finally {
    await app.close();
  }
});

test('admin console API persists tenant configuration to config file', async () => {
  const app = await startServer({ adminToken: 'admin-secret' });

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/v1/admin/tenants`);
    assert.equal(unauthorizedResponse.status, 401);

    const saveResponse = await fetch(`${app.baseUrl}/v1/admin/tenants/tenant-console`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': 'admin-secret'
      },
      body: JSON.stringify({
        clientId: 'client-console',
        clientSecret: 'secret-console',
        wechatToken: 'wechat-console-token',
        wechatAppId: 'wx-console',
        wechatAppSecret: 'wechat-console-secret',
        accountVerifyUrl: 'https://saas.example.test/wechat/verify-account',
        verificationWebhookUrl: 'https://saas.example.test/wechat/result',
        webhookSecret: 'callback-secret'
      })
    });
    const saveBody = await saveResponse.json();
    const persistedConfig = JSON.parse(await readFile(app.configPath, 'utf8'));

    assert.equal(saveResponse.status, 200);
    assert.equal(saveBody.tenant.tenant_id, 'tenant-console');
    assert.equal(persistedConfig.tenants['tenant-console'].wechatAppId, 'wx-console');
    assert.equal(
      persistedConfig.tenants['tenant-console'].accountVerifyUrl,
      'https://saas.example.test/wechat/verify-account'
    );
    assert.equal(
      persistedConfig.tenants['tenant-console'].verificationWebhookUrl,
      'https://saas.example.test/wechat/result'
    );
    assert.equal(persistedConfig.tenants['tenant-console'].webhookSecret, 'callback-secret');

    const listResponse = await fetch(`${app.baseUrl}/v1/admin/tenants`, {
      headers: {
        'x-admin-token': 'admin-secret'
      }
    });
    const listBody = await listResponse.json();

    assert.equal(listResponse.status, 200);
    const consoleTenant = listBody.tenants.find((tenant) => tenant.tenant_id === 'tenant-console');
    assert.equal(consoleTenant.account_verify_url, 'https://saas.example.test/wechat/verify-account');
    assert.equal(consoleTenant.verification_webhook_url, 'https://saas.example.test/wechat/result');
    assert.equal(consoleTenant.has_webhook_secret, true);
  } finally {
    await app.close();
  }
});

test('admin console API lists binding status and recent attempts', async () => {
  const app = await startServer({ adminToken: 'admin-secret' });

  try {
    await createPendingIntent(app, 'alice');
    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: 'console-1001',
      nonce: 'nonce-console-1001'
    });

    const bindingsResponse = await fetch(
      `${app.baseUrl}/v1/admin/bindings?tenantId=tenant-a&platformAccountId=alice`,
      {
        headers: {
          'x-admin-token': 'admin-secret'
        }
      }
    );
    const bindingsBody = await bindingsResponse.json();

    assert.equal(bindingsResponse.status, 200);
    assert.equal(bindingsBody.bindings.length, 1);
    assert.equal(bindingsBody.bindings[0].platform_account_id, 'alice');
    assert.equal(bindingsBody.bindings[0].binding_status, 'bound');

    const attemptsResponse = await fetch(`${app.baseUrl}/v1/admin/attempts?tenantId=tenant-a`, {
      headers: {
        'x-admin-token': 'admin-secret'
      }
    });
    const attemptsBody = await attemptsResponse.json();

    assert.equal(attemptsResponse.status, 200);
    assert.equal(attemptsBody.attempts[0].outcome, 'bound');
  } finally {
    await app.close();
  }
});

test('rejects unauthenticated and wrong-tenant queries', async () => {
  const app = await startServer();

  try {
    const unauthenticatedResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`);
    assert.equal(unauthenticatedResponse.status, 401);

    await fetch(`${app.baseUrl}/v1/tenants/tenant-a/pending-bind-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      },
      body: JSON.stringify({ platformAccountId: 'alice' })
    });

    const timestamp = '1713945600';
    const nonce = 'nonce-2';
    const signature = createSignature('wechat-token-a', timestamp, nonce);
    await fetch(`${app.baseUrl}/wechat/tenant-a/webhook?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/xml'
      },
      body: buildMessageXml({
        toUserName: 'official-account',
        fromUserName: 'wechat-user-a',
        content: 'alice',
        messageId: '1002'
      })
    });

    const wrongTenantResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': 'client-b',
        'x-client-secret': 'secret-b'
      }
    });

    assert.equal(wrongTenantResponse.status, 401);
  } finally {
    await app.close();
  }
});

test('rejects invalid WeChat signatures on webhook verification and delivery', async () => {
  const app = await startServer();

  try {
    const invalidGetResponse = await fetch(
      `${app.baseUrl}/wechat/tenant-a/webhook?signature=bad&timestamp=1713945600&nonce=nonce-verify&echostr=ok`
    );
    assert.equal(invalidGetResponse.status, 401);

    const invalidPostResponse = await fetch(
      `${app.baseUrl}/wechat/tenant-a/webhook?signature=bad&timestamp=1713945600&nonce=nonce-post`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/xml'
        },
        body: buildMessageXml({
          toUserName: 'official-account',
          fromUserName: 'wechat-user-a',
          content: 'alice',
          messageId: '1003'
        })
      }
    );

    assert.equal(invalidPostResponse.status, 401);
  } finally {
    await app.close();
  }
});

test('records audit attempt when same WeChat identity tries to bind a second platform account', async () => {
  const app = await startServer();

  try {
    await createPendingIntent(app, 'alice');
    await createPendingIntent(app, 'bob');

    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: '2001',
      nonce: 'nonce-2001'
    });
    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'bob',
      messageId: '2002',
      nonce: 'nonce-2002'
    });

    const { response, body } = await listAttempts(app, 'bob');

    assert.equal(response.status, 200);
    assert.equal(body.attempts.length, 1);
    assert.equal(body.attempts[0].outcome, 'rejected_wechat_already_bound');
    assert.equal(body.attempts[0].reasonCode, 'wechat_already_bound');
  } finally {
    await app.close();
  }
});

test('records audit attempt when a different WeChat identity targets an already bound platform account', async () => {
  const app = await startServer();

  try {
    await createPendingIntent(app, 'alice');

    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: '3001',
      nonce: 'nonce-3001'
    });
    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-b',
      content: 'alice',
      messageId: '3002',
      nonce: 'nonce-3002'
    });

    const { response, body } = await listAttempts(app, 'alice');

    assert.equal(response.status, 200);
    assert.equal(body.attempts[0].outcome, 'rejected_platform_account_already_bound');
    assert.equal(body.attempts[0].reasonCode, 'platform_account_already_bound');
  } finally {
    await app.close();
  }
});

test('records audit attempt when no active pending bind intent exists', async () => {
  const app = await startServer();

  try {
    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: '4001',
      nonce: 'nonce-4001'
    });

    const { response, body } = await listAttempts(app, 'alice');

    assert.equal(response.status, 200);
    assert.equal(body.attempts.length, 1);
    assert.equal(body.attempts[0].outcome, 'rejected_missing_or_expired_intent');
    assert.equal(body.attempts[0].reasonCode, 'missing_or_expired_pending_intent');
  } finally {
    await app.close();
  }
});

test('records audit attempt when bind message is malformed', async () => {
  const app = await startServer();

  try {
    await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: '   ',
      messageId: '5001',
      nonce: 'nonce-5001'
    });

    const { response, body } = await listAttempts(app, '   ');

    assert.equal(response.status, 200);
    assert.equal(body.attempts.length, 1);
    assert.equal(body.attempts[0].outcome, 'rejected_malformed');
    assert.equal(body.attempts[0].reasonCode, 'missing_platform_account_id');
  } finally {
    await app.close();
  }
});

test('verifies candidate account with SaaS host and notifies binding result', async () => {
  const callbackRequests = [];
  const app = await startServer({
    tenantOverrides: {
      'tenant-a': {
        accountVerifyUrl: 'https://saas.example.test/wechat/verify-account',
        verificationWebhookUrl: 'https://saas.example.test/wechat/result',
        webhookSecret: 'callback-secret'
      }
    },
    externalFetch: async (url, options) => {
      const body = JSON.parse(String(options.body));
      callbackRequests.push({
        pathname: url.pathname,
        event: options.headers['x-wvb-event'],
        signature: options.headers['x-wvb-signature'],
        body
      });

      if (url.pathname === '/wechat/verify-account') {
        return createJsonResponse({ allowed: true });
      }

      if (url.pathname === '/wechat/result') {
        return createJsonResponse({ received: true });
      }

      return null;
    }
  });

  try {
    await createPendingIntent(app, 'alice');
    const response = await sendWebhookMessage(app, {
      fromUserName: 'wechat-openid-callback',
      content: 'alice',
      messageId: 'callback-1'
    });

    assert.equal(response.status, 200);
    assert.equal(callbackRequests.length, 2);
    assert.equal(callbackRequests[0].event, 'account.verify');
    assert.equal(callbackRequests[0].body.platform_account_id, 'alice');
    assert.equal(callbackRequests[0].body.wechat_open_id, 'wechat-openid-callback');
    assert.match(callbackRequests[0].signature, /^sha256=/);
    assert.equal(callbackRequests[1].event, 'wechat.binding.result');
    assert.equal(callbackRequests[1].body.outcome, 'bound');
    assert.equal(callbackRequests[1].body.is_bound, true);
    assert.equal(callbackRequests[1].body.platform_account_id, 'alice');

    const statusResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      }
    });
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.is_bound, true);
  } finally {
    await app.close();
  }
});

test('rejects binding when SaaS host account verification denies the candidate', async () => {
  const callbackRequests = [];
  const app = await startServer({
    tenantOverrides: {
      'tenant-a': {
        accountVerifyUrl: 'https://saas.example.test/wechat/verify-account',
        verificationWebhookUrl: 'https://saas.example.test/wechat/result',
        webhookSecret: 'callback-secret'
      }
    },
    externalFetch: async (url, options) => {
      const body = JSON.parse(String(options.body));
      callbackRequests.push({ pathname: url.pathname, event: options.headers['x-wvb-event'], body });

      if (url.pathname === '/wechat/verify-account') {
        return createJsonResponse({ allowed: false, reasonCode: 'account_not_allowed' });
      }

      if (url.pathname === '/wechat/result') {
        return createJsonResponse({ received: true });
      }

      return null;
    }
  });

  try {
    await createPendingIntent(app, 'alice');
    const response = await sendWebhookMessage(app, {
      fromUserName: 'wechat-openid-denied',
      content: 'alice',
      messageId: 'callback-denied-1'
    });
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.match(responseText, /platform could not verify/i);
    assert.equal(callbackRequests.length, 2);
    assert.equal(callbackRequests[1].event, 'wechat.binding.result');
    assert.equal(callbackRequests[1].body.outcome, 'rejected_host_account_verification');
    assert.equal(callbackRequests[1].body.is_bound, false);
    assert.equal(callbackRequests[1].body.reason_code, 'account_not_allowed');

    const statusResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      }
    });
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.is_bound, false);

    const { body: attemptsBody } = await listAttempts(app, 'alice');
    assert.equal(attemptsBody.attempts[0].reasonCode, 'account_not_allowed');
  } finally {
    await app.close();
  }
});

test('verifies subscribed WeChat profile and persists official account metadata on binding', async () => {
  const officialAccountClient = {
    async getUserInfo(_tenantConfig, openId) {
      return {
        openId,
        unionId: 'union-alice',
        subscribe: true,
        subscribeTime: 1713945600
      };
    }
  };
  const app = await startServer({
    tenantOverrides: {
      'tenant-a': {
        wechatAppId: 'wx-tenant-a',
        wechatAppSecret: 'app-secret-a'
      }
    },
    officialAccountClient
  });

  try {
    await createPendingIntent(app, 'alice');
    const webhookResponse = await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: '6001',
      nonce: 'nonce-6001'
    });

    assert.equal(webhookResponse.status, 200);

    const statusResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      }
    });
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.binding_status, 'bound');
    assert.equal(statusBody.wechat_official_account_appid, 'wx-tenant-a');
    assert.equal(statusBody.wechat_subscribe_status, 'subscribed');
  } finally {
    await app.close();
  }
});

test('rejects binding when official WeChat lookup says the user is not subscribed', async () => {
  const officialAccountClient = {
    async getUserInfo(_tenantConfig, openId) {
      return {
        openId,
        unionId: null,
        subscribe: false,
        subscribeTime: null
      };
    }
  };
  const app = await startServer({
    tenantOverrides: {
      'tenant-a': {
        wechatAppId: 'wx-tenant-a',
        wechatAppSecret: 'app-secret-a'
      }
    },
    officialAccountClient
  });

  try {
    await createPendingIntent(app, 'alice');
    const webhookResponse = await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: '7001',
      nonce: 'nonce-7001'
    });
    const webhookBody = await webhookResponse.text();

    assert.equal(webhookResponse.status, 200);
    assert.match(webhookBody, /请先关注公众号/);

    const statusResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      }
    });
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.binding_status, 'unbound');
    assert.equal(statusBody.is_bound, false);
  } finally {
    await app.close();
  }
});

test('continues binding when optional WeChat user info API is unauthorized', async () => {
  const officialAccountClient = {
    async getUserInfo() {
      throw new HttpError(502, 'wechat_user_info_failed', 'Failed to get WeChat user info.', {
        errcode: 48001,
        errmsg: 'api unauthorized'
      });
    }
  };
  const app = await startServer({
    tenantOverrides: {
      'tenant-a': {
        wechatAppId: 'wx-tenant-a',
        wechatAppSecret: 'app-secret-a'
      }
    },
    officialAccountClient
  });

  try {
    await createPendingIntent(app, 'alice');
    const webhookResponse = await sendWebhookMessage(app, {
      fromUserName: 'wechat-user-a',
      content: 'alice',
      messageId: '7501',
      nonce: 'nonce-7501'
    });
    const webhookBody = await webhookResponse.text();

    assert.equal(webhookResponse.status, 200);
    assert.match(webhookBody, /Binding completed successfully/);

    const statusResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/bindings/alice`, {
      headers: {
        'x-client-id': tenantMetadata('tenant-a').clientId,
        'x-client-secret': tenantMetadata('tenant-a').clientSecret
      }
    });
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.binding_status, 'bound');
    assert.equal(statusBody.wechat_subscribe_status, 'unchecked');
  } finally {
    await app.close();
  }
});

test('exposes host-authenticated WeChat follower and user lookup endpoints', async () => {
  const officialAccountClient = {
    async getUserInfo(_tenantConfig, openId) {
      return {
        openId,
        unionId: 'union-alice',
        subscribe: true,
        subscribeTime: 1713945600
      };
    },
    async listFollowerOpenIds(_tenantConfig, nextOpenId) {
      return {
        total: 2,
        count: 2,
        openIds: nextOpenId ? ['openid-c'] : ['openid-a', 'openid-b'],
        nextOpenId: 'next-page'
      };
    }
  };
  const app = await startServer({
    tenantOverrides: {
      'tenant-a': {
        wechatAppId: 'wx-tenant-a',
        wechatAppSecret: 'app-secret-a'
      }
    },
    officialAccountClient
  });
  const headers = {
    'x-client-id': tenantMetadata('tenant-a').clientId,
    'x-client-secret': tenantMetadata('tenant-a').clientSecret
  };

  try {
    const userResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/wechat/users/openid-a`, {
      headers
    });
    const userBody = await userResponse.json();

    assert.equal(userResponse.status, 200);
    assert.equal(userBody.open_id, 'openid-a');
    assert.equal(userBody.subscribe, true);

    const followersResponse = await fetch(`${app.baseUrl}/v1/tenants/tenant-a/wechat/followers`, {
      headers
    });
    const followersBody = await followersResponse.json();

    assert.equal(followersResponse.status, 200);
    assert.deepEqual(followersBody.open_ids, ['openid-a', 'openid-b']);
    assert.equal(followersBody.next_open_id, 'next-page');
  } finally {
    await app.close();
  }
});
