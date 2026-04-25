import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 3000;

function normalizeUrl(value) {
  return String(value ?? '').trim();
}

function createSignature(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function postJsonCallback({ url, webhookSecret, eventType, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const callbackUrl = normalizeUrl(url);

  if (!callbackUrl) {
    return { configured: false, ok: true, status: null, body: null };
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'saas-verify-wechat/0.1',
    'x-wvb-event': eventType,
    'x-wvb-timestamp': timestamp
  };
  const normalizedSecret = String(webhookSecret ?? '').trim();

  if (normalizedSecret) {
    headers['x-wvb-signature'] = `sha256=${createSignature(normalizedSecret, timestamp, body)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
    const responseText = await response.text();
    let responseBody = null;

    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = { raw: responseText };
      }
    }

    return {
      configured: true,
      ok: response.ok,
      status: response.status,
      body: responseBody
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      status: null,
      body: {
        error: error.name === 'AbortError' ? 'callback_timeout' : 'callback_failed',
        message: error.message
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyHostAccount(tenantConfig, payload) {
  const result = await postJsonCallback({
    url: tenantConfig.accountVerifyUrl,
    webhookSecret: tenantConfig.webhookSecret,
    eventType: 'account.verify',
    payload
  });

  if (!result.configured) {
    return { configured: false, allowed: true, reasonCode: null, details: null };
  }

  if (!result.ok) {
    return {
      configured: true,
      allowed: false,
      reasonCode: 'host_account_verification_unavailable',
      details: result
    };
  }

  const allowed = result.body?.allowed === true;

  return {
    configured: true,
    allowed,
    reasonCode: allowed ? null : result.body?.reasonCode ?? 'host_account_rejected',
    details: result.body ?? null
  };
}

export async function notifyVerificationResult(tenantConfig, payload) {
  return postJsonCallback({
    url: tenantConfig.verificationWebhookUrl,
    webhookSecret: tenantConfig.webhookSecret,
    eventType: 'wechat.binding.result',
    payload
  });
}

