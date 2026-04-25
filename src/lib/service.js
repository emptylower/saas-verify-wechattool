import crypto from 'node:crypto';

import { HttpError } from './errors.js';

function nowIso(now) {
  return now().toISOString();
}

function computeBindingRef(tenantId, wechatAppId, wechatOpenId) {
  return crypto
    .createHash('sha256')
    .update(`${tenantId}:${wechatAppId ?? 'unknown-app'}:${wechatOpenId}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizePlatformAccountId(platformAccountId) {
  return String(platformAccountId ?? '').trim();
}

function pruneExpiredIntents(state, currentTime) {
  for (const intent of state.pendingBindIntents) {
    if (!intent.consumedAt && new Date(intent.expiresAt).getTime() <= currentTime.getTime()) {
      intent.expiredAt = intent.expiresAt;
      intent.consumedAt = intent.expiresAt;
      intent.outcome = 'expired';
    }
  }
}

function findBindingByWeChat(state, tenantId, wechatOpenId) {
  return state.bindings.find(
    (binding) => binding.tenantId === tenantId && binding.wechatOpenId === wechatOpenId
  );
}

function findBindingByPlatform(state, tenantId, platformAccountId) {
  return state.bindings.find(
    (binding) => binding.tenantId === tenantId && binding.platformAccountId === platformAccountId
  );
}

function createAttemptRecord(input) {
  return {
    id: crypto.randomUUID(),
    attemptAt: input.attemptAt,
    tenantId: input.tenantId,
    messageId: input.messageId,
    pendingIntentId: input.pendingIntentId,
    pendingIntentFingerprint: input.pendingIntentFingerprint,
    candidatePlatformAccountId: input.candidatePlatformAccountId,
    candidateWechatOpenId: input.candidateWechatOpenId,
    outcome: input.outcome,
    reasonCode: input.reasonCode
  };
}

function serializeBindingStatus(binding, reasonCode = 'binding_not_found') {
  if (!binding) {
    return {
      binding_status: 'unbound',
      is_bound: false,
      bound_at: null,
      wechat_binding_ref: null,
      wechat_official_account_appid: null,
      wechat_subscribe_status: null,
      reason_code: reasonCode
    };
  }

  return {
    binding_status: 'bound',
    is_bound: true,
    bound_at: binding.boundAt,
    wechat_binding_ref: binding.wechatBindingRef,
    wechat_official_account_appid: binding.wechatAppId ?? null,
    wechat_subscribe_status: binding.wechatSubscribeStatus ?? null,
    reason_code: null
  };
}

export class BindingService {
  constructor({ store, now = () => new Date() }) {
    this.store = store;
    this.now = now;
  }

  async createPendingBindIntent({ tenantId, platformAccountId, ttlSeconds = 600, correlationId = null }) {
    const normalizedPlatformAccountId = normalizePlatformAccountId(platformAccountId);

    if (!normalizedPlatformAccountId) {
      throw new HttpError(400, 'invalid_platform_account_id', 'platformAccountId is required.');
    }

    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
      throw new HttpError(400, 'invalid_ttl', 'ttlSeconds must be an integer between 1 and 3600.');
    }

    return this.store.transaction((state) => {
      const currentTime = this.now();
      const attemptAt = nowIso(this.now);
      pruneExpiredIntents(state, currentTime);

      const existingBinding = findBindingByPlatform(state, tenantId, normalizedPlatformAccountId);
      if (existingBinding) {
        throw new HttpError(
          409,
          'platform_account_already_bound',
          'The platform account is already bound and cannot create a new pending intent.'
        );
      }

      const existingIntent = state.pendingBindIntents.find(
        (intent) =>
          intent.tenantId === tenantId &&
          intent.platformAccountId === normalizedPlatformAccountId &&
          !intent.consumedAt &&
          new Date(intent.expiresAt).getTime() > currentTime.getTime()
      );

      if (existingIntent) {
        return existingIntent;
      }

      const expiresAt = new Date(currentTime.getTime() + ttlSeconds * 1000).toISOString();
      const pendingIntent = {
        id: crypto.randomUUID(),
        tenantId,
        platformAccountId: normalizedPlatformAccountId,
        createdAt: attemptAt,
        expiresAt,
        consumedAt: null,
        correlationId
      };

      state.pendingBindIntents.push(pendingIntent);
      return pendingIntent;
    });
  }

  async getBindingStatus({ tenantId, platformAccountId }) {
    const normalizedPlatformAccountId = normalizePlatformAccountId(platformAccountId);

    return this.store.read((state) => {
      const binding = findBindingByPlatform(state, tenantId, normalizedPlatformAccountId);
      return {
        tenant_id: tenantId,
        platform_account_id: normalizedPlatformAccountId,
        ...serializeBindingStatus(binding)
      };
    });
  }

  async getAuditBinding({ tenantId, platformAccountId }) {
    const normalizedPlatformAccountId = normalizePlatformAccountId(platformAccountId);

    return this.store.read((state) => {
      const binding = findBindingByPlatform(state, tenantId, normalizedPlatformAccountId);
      return binding ?? null;
    });
  }

  async listAttempts({ tenantId, platformAccountId = null, limit = 50 }) {
    return this.store.read((state) => {
      const filtered = state.attempts
        .filter((attempt) => attempt.tenantId === tenantId)
        .filter((attempt) =>
          platformAccountId ? attempt.candidatePlatformAccountId === platformAccountId : true
        )
        .slice(-limit)
        .reverse();

      return filtered;
    });
  }

  async listBindings({ tenantId = null, platformAccountId = null, limit = 100 }) {
    const normalizedPlatformAccountId = platformAccountId ? normalizePlatformAccountId(platformAccountId) : null;

    return this.store.read((state) =>
      state.bindings
        .filter((binding) => (tenantId ? binding.tenantId === tenantId : true))
        .filter((binding) =>
          normalizedPlatformAccountId ? binding.platformAccountId === normalizedPlatformAccountId : true
        )
        .slice(-limit)
        .reverse()
        .map((binding) => ({
          tenant_id: binding.tenantId,
          platform_account_id: binding.platformAccountId,
          binding_status: binding.status,
          bound_at: binding.boundAt,
          wechat_binding_ref: binding.wechatBindingRef,
          wechat_official_account_appid: binding.wechatAppId ?? null,
          wechat_subscribe_status: binding.wechatSubscribeStatus ?? null
        }))
    );
  }

  async processWeChatMessage({
    tenantId,
    wechatOpenId,
    platformAccountId,
    messageId = null,
    wechatAppId = null,
    wechatProfile = null,
    hostAccountVerification = null
  }) {
    const normalizedPlatformAccountId = normalizePlatformAccountId(platformAccountId);

    if (!normalizedPlatformAccountId) {
      return this.store.transaction((state) => {
        const attempt = createAttemptRecord({
          attemptAt: nowIso(this.now),
          tenantId,
          messageId,
          pendingIntentId: null,
          pendingIntentFingerprint: null,
          candidatePlatformAccountId: null,
          candidateWechatOpenId: wechatOpenId,
          outcome: 'rejected_malformed',
          reasonCode: 'missing_platform_account_id'
        });
        state.attempts.push(attempt);
        return {
          outcome: attempt.outcome,
          reasonCode: attempt.reasonCode,
          statusText: 'Rejected malformed bind message.'
        };
      });
    }

    return this.store.transaction((state) => {
      const currentTime = this.now();
      const attemptAt = nowIso(this.now);
      pruneExpiredIntents(state, currentTime);

      const existingBindingByWechat = findBindingByWeChat(state, tenantId, wechatOpenId);
      const existingBindingByPlatform = findBindingByPlatform(
        state,
        tenantId,
        normalizedPlatformAccountId
      );

      if (
        existingBindingByWechat &&
        existingBindingByPlatform &&
        existingBindingByWechat.platformAccountId === normalizedPlatformAccountId &&
        existingBindingByPlatform.wechatOpenId === wechatOpenId
      ) {
        const attempt = createAttemptRecord({
          attemptAt,
          tenantId,
          messageId,
          pendingIntentId: null,
          pendingIntentFingerprint: null,
          candidatePlatformAccountId: normalizedPlatformAccountId,
          candidateWechatOpenId: wechatOpenId,
          outcome: 'idempotent_success',
          reasonCode: 'already_bound'
        });
        state.attempts.push(attempt);
        return {
          outcome: attempt.outcome,
          reasonCode: attempt.reasonCode,
          statusText: 'Binding already exists for this WeChat account and platform account.',
          binding: existingBindingByWechat
        };
      }

      if (existingBindingByWechat && existingBindingByWechat.platformAccountId !== normalizedPlatformAccountId) {
        const attempt = createAttemptRecord({
          attemptAt,
          tenantId,
          messageId,
          pendingIntentId: null,
          pendingIntentFingerprint: null,
          candidatePlatformAccountId: normalizedPlatformAccountId,
          candidateWechatOpenId: wechatOpenId,
          outcome: 'rejected_wechat_already_bound',
          reasonCode: 'wechat_already_bound'
        });
        state.attempts.push(attempt);
        return {
          outcome: attempt.outcome,
          reasonCode: attempt.reasonCode,
          statusText: 'This WeChat account is already bound to another platform account.'
        };
      }

      if (existingBindingByPlatform && existingBindingByPlatform.wechatOpenId !== wechatOpenId) {
        const attempt = createAttemptRecord({
          attemptAt,
          tenantId,
          messageId,
          pendingIntentId: null,
          pendingIntentFingerprint: null,
          candidatePlatformAccountId: normalizedPlatformAccountId,
          candidateWechatOpenId: wechatOpenId,
          outcome: 'rejected_platform_account_already_bound',
          reasonCode: 'platform_account_already_bound'
        });
        state.attempts.push(attempt);
        return {
          outcome: attempt.outcome,
          reasonCode: attempt.reasonCode,
          statusText: 'This platform account is already bound to another WeChat account.'
        };
      }

      const matchingIntent = state.pendingBindIntents.find(
        (intent) =>
          intent.tenantId === tenantId &&
          intent.platformAccountId === normalizedPlatformAccountId &&
          !intent.consumedAt &&
          new Date(intent.expiresAt).getTime() > currentTime.getTime()
      );

      if (!matchingIntent) {
        const attempt = createAttemptRecord({
          attemptAt,
          tenantId,
          messageId,
          pendingIntentId: null,
          pendingIntentFingerprint: null,
          candidatePlatformAccountId: normalizedPlatformAccountId,
          candidateWechatOpenId: wechatOpenId,
          outcome: 'rejected_missing_or_expired_intent',
          reasonCode: 'missing_or_expired_pending_intent'
        });
        state.attempts.push(attempt);
        return {
          outcome: attempt.outcome,
          reasonCode: attempt.reasonCode,
          statusText: 'No active pending bind intent exists for this platform account.'
        };
      }

      if (hostAccountVerification?.allowed === false) {
        const attempt = createAttemptRecord({
          attemptAt,
          tenantId,
          messageId,
          pendingIntentId: matchingIntent.id,
          pendingIntentFingerprint: matchingIntent.id.slice(0, 8),
          candidatePlatformAccountId: normalizedPlatformAccountId,
          candidateWechatOpenId: wechatOpenId,
          outcome: 'rejected_host_account_verification',
          reasonCode: hostAccountVerification.reasonCode ?? 'host_account_rejected'
        });
        state.attempts.push(attempt);
        return {
          outcome: attempt.outcome,
          reasonCode: attempt.reasonCode,
          statusText: 'The host platform rejected this account verification.'
        };
      }

      matchingIntent.consumedAt = attemptAt;
      matchingIntent.outcome = 'bound';

      const binding = {
        id: crypto.randomUUID(),
        tenantId,
        platformAccountId: normalizedPlatformAccountId,
        wechatOpenId,
        wechatAppId,
        wechatUnionId: wechatProfile?.unionId ?? null,
        wechatSubscribeStatus: wechatProfile ? (wechatProfile.subscribe ? 'subscribed' : 'unsubscribed') : 'unchecked',
        wechatSubscribeCheckedAt: wechatProfile ? attemptAt : null,
        wechatBindingRef: computeBindingRef(tenantId, wechatAppId, wechatOpenId),
        status: 'bound',
        boundAt: attemptAt
      };

      state.bindings.push(binding);

      const attempt = createAttemptRecord({
        attemptAt,
        tenantId,
        messageId,
        pendingIntentId: matchingIntent.id,
        pendingIntentFingerprint: matchingIntent.id.slice(0, 8),
        candidatePlatformAccountId: normalizedPlatformAccountId,
        candidateWechatOpenId: wechatOpenId,
        outcome: 'bound',
        reasonCode: null
      });
      state.attempts.push(attempt);

      return {
        outcome: attempt.outcome,
        reasonCode: attempt.reasonCode,
        statusText: 'Binding completed successfully.',
        binding
      };
    });
  }
}
