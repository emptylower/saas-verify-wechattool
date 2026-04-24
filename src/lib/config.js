import { readFile } from 'node:fs/promises';

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
