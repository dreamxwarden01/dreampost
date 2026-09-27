import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { DOWNLOAD_CONTROL_PATH, MAX_DOWNLOAD_CONTROL_BYTES } from '../packages/protocol/dist/index.js';

/** Expose only the signed control endpoint through a temporary development tunnel. */
export function createAttachmentControlProxy({ apiPort = 3001 } = {}) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('Invalid API port');
  const fail = (response, status, error) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
    response.end(JSON.stringify({ error }));
  };
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== DOWNLOAD_CONTROL_PATH) {
      fail(response, 404, 'not_found');
      return;
    }
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_DOWNLOAD_CONTROL_BYTES)) {
      fail(response, 413, 'body_too_large');
      return;
    }
    request.setTimeout(10_000, () => request.destroy());
    const parts = []; let size = 0;
    try {
      for await (const part of request) {
        size += part.length;
        if (size > MAX_DOWNLOAD_CONTROL_BYTES) { fail(response, 413, 'body_too_large'); return; }
        parts.push(part);
      }
    } catch { if (!response.destroyed) fail(response, 400, 'invalid_request'); return; }
    const headers = { 'content-length': String(size) };
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.startsWith('x-dreampost-download-') || name === 'content-type') headers[name] = value;
    }
    const upstream = http.request({ host: '127.0.0.1', port: apiPort, path: DOWNLOAD_CONTROL_PATH, method: 'POST', headers }, incoming => {
      const outgoing = { 'cache-control': 'no-store' };
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (name.startsWith('x-dreampost-download-') || name === 'content-type') outgoing[name] = value;
      }
      response.writeHead(incoming.statusCode ?? 503, outgoing);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!response.headersSent && !response.destroyed) fail(response, 503, 'temporarily_unavailable');
      else response.destroy();
    });
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    upstream.end(Buffer.concat(parts, size));
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ATTACHMENT_CONTROL_PROXY_PORT ?? 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy port');
  const server = createAttachmentControlProxy({ apiPort: Number(process.env.PORT ?? 3001) });
  server.listen(port, '127.0.0.1', () => console.log(`Attachment-control-only proxy listening on loopback port ${port}.`));
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
