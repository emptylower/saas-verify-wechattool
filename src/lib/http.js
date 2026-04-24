import { HttpError } from './errors.js';

export function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => {
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
  });
}

export async function readJsonBody(request) {
  const body = await readRequestBody(request);

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.', {
      cause: error.message
    });
  }
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

export function sendXml(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/xml; charset=utf-8' });
  response.end(payload);
}

export function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(payload);
}

export function sendHtml(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  response.end(payload);
}

export function sendCss(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/css; charset=utf-8' });
  response.end(payload);
}

export function sendJavaScript(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/javascript; charset=utf-8' });
  response.end(payload);
}

export function handleError(response, error) {
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, {
      error: error.code,
      message: error.message,
      details: error.details
    });
    return;
  }

  sendJson(response, 500, {
    error: 'internal_error',
    message: 'An unexpected error occurred.'
  });
}
