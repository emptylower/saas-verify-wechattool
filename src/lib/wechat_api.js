import { HttpError } from './errors.js';

const WECHAT_API_BASE_URL = 'https://api.weixin.qq.com';

function hasOfficialAccountCredentials(tenantConfig) {
  return Boolean(tenantConfig.wechatAppId && tenantConfig.wechatAppSecret);
}

function buildUrl(pathname, searchParams) {
  const url = new URL(pathname, WECHAT_API_BASE_URL);

  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

export class WeChatOfficialAccountClient {
  constructor({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required.');
    }

    this.fetch = fetchImpl;
    this.now = now;
    this.accessTokens = new Map();
  }

  async getAccessToken(tenantConfig) {
    if (!hasOfficialAccountCredentials(tenantConfig)) {
      return null;
    }

    const cacheKey = tenantConfig.wechatAppId;
    const cached = this.accessTokens.get(cacheKey);

    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const url = buildUrl('/cgi-bin/token', {
      grant_type: 'client_credential',
      appid: tenantConfig.wechatAppId,
      secret: tenantConfig.wechatAppSecret
    });
    const response = await this.fetch(url);
    const payload = await response.json();

    if (!response.ok || payload.errcode) {
      throw new HttpError(502, 'wechat_access_token_failed', 'Failed to get WeChat access_token.', {
        errcode: payload.errcode ?? null,
        errmsg: payload.errmsg ?? null
      });
    }

    const expiresIn = Number(payload.expires_in ?? 7200);
    this.accessTokens.set(cacheKey, {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(expiresIn - 300, 60) * 1000
    });

    return payload.access_token;
  }

  async getUserInfo(tenantConfig, openId) {
    const accessToken = await this.getAccessToken(tenantConfig);

    if (!accessToken) {
      return null;
    }

    const url = buildUrl('/cgi-bin/user/info', {
      access_token: accessToken,
      openid: openId,
      lang: 'zh_CN'
    });
    const response = await this.fetch(url);
    const payload = await response.json();

    if (!response.ok || payload.errcode) {
      throw new HttpError(502, 'wechat_user_info_failed', 'Failed to get WeChat user info.', {
        errcode: payload.errcode ?? null,
        errmsg: payload.errmsg ?? null
      });
    }

    return {
      openId: payload.openid,
      unionId: payload.unionid ?? null,
      subscribe: payload.subscribe === 1,
      subscribeTime: payload.subscribe_time ?? null,
      raw: payload
    };
  }

  async listFollowerOpenIds(tenantConfig, nextOpenId = '') {
    const accessToken = await this.getAccessToken(tenantConfig);

    if (!accessToken) {
      return null;
    }

    const url = buildUrl('/cgi-bin/user/get', {
      access_token: accessToken,
      next_openid: nextOpenId
    });
    const response = await this.fetch(url);
    const payload = await response.json();

    if (!response.ok || payload.errcode) {
      throw new HttpError(502, 'wechat_user_list_failed', 'Failed to list WeChat followers.', {
        errcode: payload.errcode ?? null,
        errmsg: payload.errmsg ?? null
      });
    }

    return {
      total: payload.total,
      count: payload.count,
      openIds: payload.data?.openid ?? [],
      nextOpenId: payload.next_openid ?? ''
    };
  }
}
