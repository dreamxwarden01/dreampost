import http from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { DOWNLOAD_CONTROL_PATH, MAX_DOWNLOAD_CONTROL_BYTES } from '../packages/protocol/src/index.js';
// @ts-expect-error The standalone development proxy intentionally has no declaration file.
import { createAttachmentControlProxy } from '../scripts/attachment-control-proxy.mjs';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function listen(server: http.Server) {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
it('forwards only bounded signed control traffic and preserves signed reply headers', async () => {
  let calls = 0;
  const upstreamPort = await listen(http.createServer(async (request, response) => {
    calls++;
    expect(request.url).toBe(DOWNLOAD_CONTROL_PATH);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-dreampost-download-signature']).toBe('synthetic-signature');
    const parts = []; for await (const part of request) parts.push(part);
    expect(Buffer.concat(parts).toString()).toBe('{"version":1}');
    response.writeHead(200, { 'content-type': 'application/json', 'x-dreampost-download-signature': 'synthetic-response', 'set-cookie': 'must-not-forward=1' });
    response.end('{"ok":true}');
  }));
  const port = await listen(createAttachmentControlProxy({ apiPort: upstreamPort }));
  const base = `http://127.0.0.1:${port}`;
  for (const [method, path] of [['GET', DOWNLOAD_CONTROL_PATH], ['POST', '/api/mailboxes'], ['POST', `${DOWNLOAD_CONTROL_PATH}?unexpected=1`]]) {
    expect((await fetch(base + path, { method })).status).toBe(404);
  }
  expect((await fetch(base + DOWNLOAD_CONTROL_PATH, { method: 'POST', body: 'x'.repeat(MAX_DOWNLOAD_CONTROL_BYTES + 1) })).status).toBe(413);
  expect(calls).toBe(0);
  const result = await fetch(base + DOWNLOAD_CONTROL_PATH, { method: 'POST', headers: {
    'content-type': 'application/json', cookie: 'private=1', authorization: 'Bearer private', 'x-dreampost-download-signature': 'synthetic-signature',
  }, body: '{"version":1}' });
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ ok: true });
  expect(result.headers.get('x-dreampost-download-signature')).toBe('synthetic-response');
  expect(result.headers.get('set-cookie')).toBeNull(); expect(result.headers.get('cache-control')).toBe('no-store');
  expect(calls).toBe(1);
});
