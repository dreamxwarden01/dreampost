import http from 'node:http';
import { INGEST_PATH } from '../packages/protocol/dist/index.js';

const apiPort = Number(process.env.PORT ?? 3001);
const port = Number(process.env.INGEST_PROXY_PORT ?? 3002);
for (const value of [apiPort, port]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid local port.');
}
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== INGEST_PATH) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not_found"}');
    return;
  }
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.startsWith('x-dreampost-') || name === 'content-type' || name === 'content-length') headers[name] = value;
  }
  const upstream = http.request({ host: '127.0.0.1', port: apiPort, path: INGEST_PATH, method: 'POST', headers }, incoming => {
    response.writeHead(incoming.statusCode ?? 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    incoming.pipe(response);
  });
  upstream.setTimeout(190_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":"temporarily_unavailable"}');
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
});
server.requestTimeout = 200_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => console.log(`Ingestion-only development proxy listening on loopback port ${port}.`));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
