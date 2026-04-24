import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createId } from './store.js';

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.tenants || typeof parsed.tenants !== 'object') {
    throw new Error('Config must contain a tenants object.');
  }

  return parsed;
}

export function getTenantConfig(config, tenantId) {
  return config.tenants[tenantId] ?? null;
}

function normalizeConfigValue(value) {
  return String(value ?? '').trim();
}

export function listTenantSummaries(config) {
  return Object.entries(config.tenants).map(([tenantId, tenantConfig]) => ({
    tenant_id: tenantId,
    client_id: tenantConfig.clientId ?? '',
    has_client_secret: Boolean(tenantConfig.clientSecret),
    has_wechat_token: Boolean(tenantConfig.wechatToken),
    wechat_appid: tenantConfig.wechatAppId ?? '',
    has_wechat_appsecret: Boolean(tenantConfig.wechatAppSecret),
    webhook_path: `/wechat/${tenantId}/webhook`
  }));
}

export async function saveConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${createId()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, configPath);
}

export async function upsertTenantConfig(configPath, config, tenantId, input) {
  const normalizedTenantId = normalizeConfigValue(tenantId);

  if (!normalizedTenantId) {
    throw new Error('tenantId is required.');
  }

  const tenantConfig = {
    clientId: normalizeConfigValue(input.clientId),
    clientSecret: normalizeConfigValue(input.clientSecret),
    wechatToken: normalizeConfigValue(input.wechatToken),
    wechatAppId: normalizeConfigValue(input.wechatAppId),
    wechatAppSecret: normalizeConfigValue(input.wechatAppSecret)
  };

  config.tenants[normalizedTenantId] = tenantConfig;
  await saveConfig(configPath, config);

  return {
    tenant_id: normalizedTenantId,
    client_id: tenantConfig.clientId,
    has_client_secret: Boolean(tenantConfig.clientSecret),
    has_wechat_token: Boolean(tenantConfig.wechatToken),
    wechat_appid: tenantConfig.wechatAppId,
    has_wechat_appsecret: Boolean(tenantConfig.wechatAppSecret),
    webhook_path: `/wechat/${normalizedTenantId}/webhook`
  };
}
