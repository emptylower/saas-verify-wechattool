import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createApp } from '../src/server.js';

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

async function startServer({ tenantOverrides = {}, officialAccountClient } = {}) {
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

  const { server } = await createApp({ configPath, dataPath, officialAccountClient });

  await new Promise((resolve) => {
    server.listen(0, resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
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
