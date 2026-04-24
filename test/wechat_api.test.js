import test from 'node:test';
import assert from 'node:assert/strict';

import { WeChatOfficialAccountClient } from '../src/lib/wechat_api.js';

test('uses official account credentials to fetch and cache access tokens', async () => {
  const calls = [];
  const client = new WeChatOfficialAccountClient({
    now: () => 1000,
    async fetchImpl(url) {
      calls.push(String(url));

      if (url.pathname === '/cgi-bin/token') {
        return Response.json({
          access_token: 'token-a',
          expires_in: 7200
        });
      }

      return Response.json({
        openid: url.searchParams.get('openid'),
        unionid: 'union-a',
        subscribe: 1,
        subscribe_time: 1713945600
      });
    }
  });
  const tenantConfig = {
    wechatAppId: 'wx-app-a',
    wechatAppSecret: 'secret-a'
  };

  const first = await client.getUserInfo(tenantConfig, 'openid-a');
  const second = await client.getUserInfo(tenantConfig, 'openid-b');

  assert.equal(first.openId, 'openid-a');
  assert.equal(first.subscribe, true);
  assert.equal(second.openId, 'openid-b');
  assert.equal(calls.filter((url) => url.includes('/cgi-bin/token')).length, 1);
  assert.equal(calls.filter((url) => url.includes('/cgi-bin/user/info')).length, 2);
});

test('returns null when official account credentials are not configured', async () => {
  const client = new WeChatOfficialAccountClient({
    async fetchImpl() {
      throw new Error('fetch should not be called');
    }
  });

  const user = await client.getUserInfo({}, 'openid-a');
  const followers = await client.listFollowerOpenIds({}, '');

  assert.equal(user, null);
  assert.equal(followers, null);
});
