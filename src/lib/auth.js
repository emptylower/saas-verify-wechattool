import crypto from 'node:crypto';

import { HttpError } from './errors.js';

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function authenticateHost(request, tenantConfig) {
  const clientId = request.headers['x-client-id'];
  const clientSecret = request.headers['x-client-secret'];

  if (!clientId || !clientSecret) {
    throw new HttpError(401, 'unauthorized', 'Missing host authentication headers.');
  }

  if (
    !safeCompare(String(clientId), String(tenantConfig.clientId)) ||
    !safeCompare(String(clientSecret), String(tenantConfig.clientSecret))
  ) {
    throw new HttpError(401, 'unauthorized', 'Invalid host authentication credentials.');
  }
}

function isLocalRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

export function authenticateAdmin(request, adminToken) {
  if (!adminToken) {
    if (isLocalRequest(request)) {
      return;
    }

    throw new HttpError(
      403,
      'admin_token_required',
      'Set WVB_ADMIN_TOKEN before exposing the console outside localhost.'
    );
  }

  const providedToken = request.headers['x-admin-token'];

  if (!providedToken || !safeCompare(String(providedToken), String(adminToken))) {
    throw new HttpError(401, 'unauthorized_admin', 'Invalid admin token.');
  }
}
