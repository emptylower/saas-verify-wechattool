import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonStore } from '../src/lib/store.js';
import { BindingService } from '../src/lib/service.js';

async function createService() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechat-binding-service-'));
  const store = new JsonStore(path.join(directory, 'store.json'));
  await store.ensureFile();
  const time = { current: new Date('2026-04-24T10:00:00.000Z') };
  const service = new BindingService({
    store,
    now: () => new Date(time.current)
  });
  service.testClock = time;
  return { service };
}

test('creates a pending bind intent and binds successfully', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({
    tenantId: 'tenant-a',
    platformAccountId: 'alice'
  });

  const result = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-1'
  });

  assert.equal(result.outcome, 'bound');

  const status = await service.getBindingStatus({
    tenantId: 'tenant-a',
    platformAccountId: 'alice'
  });

  assert.equal(status.binding_status, 'bound');
  assert.equal(status.is_bound, true);
  assert.ok(status.wechat_binding_ref);
});

test('rejects same WeChat identity against a second platform account', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'alice' });
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'bob' });

  const first = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-1'
  });
  const second = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'bob',
    messageId: 'msg-2'
  });

  assert.equal(first.outcome, 'bound');
  assert.equal(second.outcome, 'rejected_wechat_already_bound');
});

test('rejects different WeChat identity against an already bound platform account', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'alice' });

  const first = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-1'
  });
  const second = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-b',
    platformAccountId: 'alice',
    messageId: 'msg-2'
  });

  assert.equal(first.outcome, 'bound');
  assert.equal(second.outcome, 'rejected_platform_account_already_bound');
});

test('first-write-wins when same WeChat races across two platform accounts', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'alice' });
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'bob' });

  const [first, second] = await Promise.all([
    service.processWeChatMessage({
      tenantId: 'tenant-a',
      wechatOpenId: 'wechat-user-a',
      platformAccountId: 'alice',
      messageId: 'msg-1'
    }),
    service.processWeChatMessage({
      tenantId: 'tenant-a',
      wechatOpenId: 'wechat-user-a',
      platformAccountId: 'bob',
      messageId: 'msg-2'
    })
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ['bound', 'rejected_wechat_already_bound']);
});

test('first-write-wins when two WeChat identities race for one platform account', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'alice' });

  const [first, second] = await Promise.all([
    service.processWeChatMessage({
      tenantId: 'tenant-a',
      wechatOpenId: 'wechat-user-a',
      platformAccountId: 'alice',
      messageId: 'msg-1'
    }),
    service.processWeChatMessage({
      tenantId: 'tenant-a',
      wechatOpenId: 'wechat-user-b',
      platformAccountId: 'alice',
      messageId: 'msg-2'
    })
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ['bound', 'rejected_platform_account_already_bound']);
});

test('treats duplicate same-pair delivery as idempotent success', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({ tenantId: 'tenant-a', platformAccountId: 'alice' });

  const first = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-1'
  });
  const second = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-1-duplicate'
  });

  assert.equal(first.outcome, 'bound');
  assert.equal(second.outcome, 'idempotent_success');
});

test('rejects malformed bind messages', async () => {
  const { service } = await createService();

  const result = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: '   ',
    messageId: 'msg-malformed'
  });

  assert.equal(result.outcome, 'rejected_malformed');
  assert.equal(result.reasonCode, 'missing_platform_account_id');
});

test('rejects missing pending bind intents', async () => {
  const { service } = await createService();

  const result = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-missing-intent'
  });

  assert.equal(result.outcome, 'rejected_missing_or_expired_intent');
  assert.equal(result.reasonCode, 'missing_or_expired_pending_intent');
});

test('rejects expired pending bind intents', async () => {
  const { service } = await createService();
  await service.createPendingBindIntent({
    tenantId: 'tenant-a',
    platformAccountId: 'alice',
    ttlSeconds: 1
  });

  service.testClock.current = new Date('2026-04-24T10:00:05.000Z');

  const result = await service.processWeChatMessage({
    tenantId: 'tenant-a',
    wechatOpenId: 'wechat-user-a',
    platformAccountId: 'alice',
    messageId: 'msg-expired-intent'
  });

  assert.equal(result.outcome, 'rejected_missing_or_expired_intent');
  assert.equal(result.reasonCode, 'missing_or_expired_pending_intent');
});
