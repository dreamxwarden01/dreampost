/** Real local API + workerd/R2 + built UI/renderer. Every identity and attachment is synthetic. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright';
import { buildApp } from '../apps/api/src/app.js';
import { migrate } from '../apps/api/src/database.js';
import { FileBlobStore } from '../apps/api/src/blob-store.js';
import { parseMimeIsolated, storeReaderData } from '../apps/api/src/reader-data.js';
import { enqueueAttachmentExtraction, runOneAttachmentExtractionJob, listAttachments } from '../apps/api/src/attachments/service.js';
import { FileAttachmentStagingStore } from '../apps/api/src/attachments/storage.js';
import { runOneAttachmentUpload } from '../apps/api/src/downloads/upload.js';
import { loadDownloadConfig } from '../apps/api/src/downloads/config.js';
import { SECURE_SESSION_COOKIE } from '../apps/api/src/auth/types.js';
import { previewHeaders } from '../apps/preview/headers.js';
import { createDownloadsMiniflare } from '../workers/downloads/test/miniflare-fixture.mjs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.local', 'attachments-qa');
const databaseUrl = process.env['TEST_DATABASE_URL']; if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');
const schema = `attachments_browser_${randomUUID().replaceAll('-', '')}`;
const mainHost = 'mail.example.test', downloadHost = 'download.example.test', previewHost = 'preview.example-isolated.test';
const checks: Array<{ name: string; status: string; error?: string }> = [];
const unexpected: string[] = [], pageErrors: string[] = [], consoleErrors: string[] = [];
const previewCookies: string[] = [], downloadCookieNames = new Set<string>();
const byteRequests: Array<{ range: string | null; origin: string | null; method: string; path: string }> = [];
let mainOrigin = '', downloadOrigin = '', previewOrigin = '', apiOrigin = '';
let api: ReturnType<typeof buildApp> | undefined, browser: Browser | undefined, context: BrowserContext | undefined;
let mf: Awaited<ReturnType<typeof createDownloadsMiniflare>> | undefined;
let workDirectory = '', schemaCreated = false, browserVersion = '', failInventory = false;
let pool: InstanceType<typeof Pool> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let holdByteResponse: { arrived: boolean; release: Promise<void>; resolve: () => void } | null = null;
let activeGate: { resolve: () => void } | null = null;
const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const downloads: Download[] = [];
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf' };

async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, status: 'failed', error: error instanceof Error ? error.message : 'Unknown failure' }); throw error; }
}
async function eventually(predicate: () => Promise<boolean> | boolean, label: string, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}
function syntheticPng(): Buffer {
  const width = 96, height = 64; const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from([20, 130, 220, 255]).copy(pixels, y * (1 + width * 4) + 1 + x * 4);
  function chunk(name: string, data: Buffer) {
    const type = Buffer.from(name); const bytes = Buffer.concat([type, data]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function syntheticPdf(): Buffer {
  const content = (number: number) => `q 0.1 0.4 0.8 rg 20 300 260 70 re f Q BT /F1 18 Tf 30 260 Td (Synthetic PDF page ${number}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content(1).length} >>\nstream\n${content(1)}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${content(2).length} >>\nstream\n${content(2)}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /S /JavaScript /JS (globalThis.__pdfScriptExecuted=true;app.launchURL\\(\"https://forbidden.example.invalid/pdf-action\"\\);) >>',
  ];
  let body = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  body += `%${'synthetic padding '.repeat(36_000)}\n`;
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}

try {
  await readFile(join(root, 'apps/web/dist/index.html')); await readFile(join(root, 'apps/preview/dist/index.html'));
  await mkdir(output, { recursive: true }); workDirectory = await mkdtemp(join(output, 'run-'));
  const cert = join(workDirectory, 'cert.pem'), certKey = join(workDirectory, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${mainHost}`, '-keyout', certKey, '-out', cert]);
  server = createServer({ key: await readFile(certKey), cert: await readFile(cert) }, (request, response) => {
    void (async () => {
      const host = request.headers.host?.split(':')[0], url = new URL(request.url ?? '/', `https://${request.headers.host}`);
      if (![mainHost, downloadHost, previewHost].includes(host ?? '')) { unexpected.push(`host:${host}`); response.writeHead(403).end(); return; }
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (host === mainHost && ['/api/', '/auth/', '/backchannel/', '/.well-known/'].some(prefix => url.pathname.startsWith(prefix))) {
        if (failInventory && /\/attachments$/.test(url.pathname)) { response.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"forbidden"}'); return; }
        await new Promise<void>((done, reject) => {
          const proxy = httpRequest(`${apiOrigin}${request.url}`, { method: request.method, headers: request.headers }, upstream => {
            // Pin only the layout capability for this focused attachment harness; actual auth/transport remain unchanged.
            if (url.pathname === '/api/config' && upstream.statusCode === 200) {
              const chunks: Buffer[] = []; upstream.on('data', chunk => chunks.push(Buffer.from(chunk)));
              upstream.on('end', () => { const config = JSON.parse(Buffer.concat(chunks).toString()); const body = Buffer.from(JSON.stringify({ ...config, everydayMail: false })); response.writeHead(200, { ...upstream.headers, 'content-length': String(body.length) }); response.end(body); done(); }); upstream.on('error', reject);
            } else { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); upstream.on('end', done); upstream.on('error', reject); }
          }); proxy.on('error', reject); request.pipe(proxy);
        }); return;
      }
      if (host === downloadHost) {
        if ((request.headers.cookie ?? '').includes(SECURE_SESSION_COOKIE)) unexpected.push('mail-cookie-reached-download-origin');
        for (const value of (request.headers.cookie ?? '').split(';')) { const name = value.trim().split('=')[0]; if (name?.startsWith('__Host-dp-download-')) downloadCookieNames.add(name); }
        const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32_768) throw new Error('Unexpected browser request size'); chunks.push(bytes); }
        const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const result = await mf!.dispatchFetch(`${downloadOrigin}${request.url}`, { method: request.method, headers,
          ...(!['GET', 'HEAD'].includes(request.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) });
        if (url.pathname.startsWith('/sessions/')) {
          byteRequests.push({ range: request.headers.range ?? null, origin: request.headers.origin ?? null, method: request.method ?? 'GET', path: url.pathname });
          if (holdByteResponse && request.method === 'GET') { const gate = holdByteResponse; holdByteResponse = null; activeGate = gate; gate.arrived = true; await gate.release; activeGate = null; }
        }
        for (const [name, value] of result.headers) if (name.toLowerCase() !== 'set-cookie') response.setHeader(name, value);
        const cookies = result.headers.getSetCookie(); if (cookies.length) response.setHeader('Set-Cookie', cookies);
        response.writeHead(result.status);
        if (!result.body) response.end(); else {
          const stream = Readable.fromWeb(result.body as ReadableStream<Uint8Array>); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
        }
        return;
      }
      const directory = join(root, host === previewHost ? 'apps/preview/dist' : 'apps/web/dist');
      if (host === previewHost) {
        if (request.headers.cookie) previewCookies.push(request.headers.cookie.split(';').map(value => value.trim().split('=')[0]).join(','));
        for (const [name, value] of Object.entries(previewHeaders([mainOrigin]))) response.setHeader(name, value);
        if (url.pathname === '/preview-config.json') { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ parentOrigins: [mainOrigin] })); return; }
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^(?:index\.html|assets\/[A-Za-z0-9_.-]+|pdfjs\/(?:cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9_.-]+)$/.test(relative)) {
        unexpected.push(`${host}${url.pathname}`); response.writeHead(404).end(); return;
      }
      const bytes = await readFile(join(directory, relative)); response.writeHead(200, { 'Content-Type': mimeTypes[extname(relative)] ?? 'application/octet-stream' }).end(bytes);
    })().catch(error => { unexpected.push(`fixture-server:${error instanceof Error ? error.message : 'error'}`); if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert(address && typeof address === 'object');
  const port = address.port;
  mainOrigin = `https://${mainHost}:${port}`; downloadOrigin = `https://${downloadHost}:${port}`; previewOrigin = `https://${previewHost}:${port}`;
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 }); await migrate(pool);
  const key = { id: 'browser-qa', secret: randomBytes(32).toString('base64url') };
  const downloadConfig = loadDownloadConfig({ DOWNLOAD_ORIGIN: downloadOrigin, ATTACHMENT_PREVIEW_ORIGIN: previewOrigin,
    DOWNLOAD_KEY_ID: key.id, DOWNLOAD_SECRET: key.secret, ATTACHMENT_STAGING_PATH: join(workDirectory, 'staging') }, mainOrigin, join(workDirectory, 'raw'))!;
  const rawStore = new FileBlobStore(join(workDirectory, 'raw')), staging = new FileAttachmentStagingStore(downloadConfig.stagingPath);
  const issuer = 'https://identity.example.invalid', clientId = 'attachment-browser-qa';
  const principal = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO principals(id,issuer,subject,username,display_name,app_role,access_enabled) VALUES($1,$2,$3,$4,$4,1,true)', [principal, issuer, randomUUID(), 'Attachment QA']);
  await pool.query(`INSERT INTO auth_sessions(token_hash,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at,client_id)
    VALUES($1,$2,$3,0,$4,'synthetic',now()+interval '2 hours',now()+interval '2 hours',now()+interval '1 day',$5)`, [hash(token), principal, randomUUID(), csrf, clientId]);
  await pool.query('UPDATE auth_settings SET last_catalog_sync=now(),catalog_issuer=$1,catalog_client_id=$2', [issuer, clientId]);
  const mailbox = randomUUID(), allocation = randomUUID();
  await pool.query("INSERT INTO mailboxes(id,address,name,mailbox_type,owner_principal_id) VALUES($1,'attachment@example.test','Synthetic attachments','personal',$2)", [mailbox, principal]);
  await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])", [mailbox, principal]);
  await pool.query("INSERT INTO address_registry(address,domain,state) VALUES('attachment@example.test','example.test','allocated')");
  await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source) VALUES($1,'attachment@example.test',$2,'manual')", [allocation, mailbox]);
  await pool.query("UPDATE address_registry SET current_allocation_id=$1 WHERE address='attachment@example.test'", [allocation]);
  const pdfBytes = syntheticPdf(); const pngBytes = syntheticPng();
  const textBytes = Buffer.from('Synthetic downloadable text.\n'); const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'https://forbidden.example.invalid/svg\')"></svg>');
  const files = [ { filename: 'synthetic.pdf', type: 'application/pdf', bytes: pdfBytes }, { filename: 'synthetic.png', type: 'image/png', bytes: pngBytes },
    { filename: 'notes.txt', type: 'text/plain', bytes: textBytes }, { filename: 'active.svg', type: 'image/svg+xml', bytes: svgBytes } ];
  const messageId = randomUUID();
  const rawMessage = Buffer.from(['From: Synthetic Sender <sender@example.test>', 'To: attachment@example.test', 'Subject: Synthetic attachment preview',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="attachment-browser-fixture"', '',
    '--attachment-browser-fixture', 'Content-Type: text/plain; charset=utf-8', '', 'Synthetic message. No real mail is used.',
    ...files.flatMap(file => ['--attachment-browser-fixture', `Content-Type: ${file.type}`, `Content-Disposition: attachment; filename="${file.filename}"`, 'Content-Transfer-Encoding: base64', '', file.bytes.toString('base64')]), '--attachment-browser-fixture--', ''].join('\r\n'));
  const digest = hash(rawMessage); await rawStore.put(digest, rawMessage);
  const parsed = await parseMimeIsolated(rawMessage);
  await pool.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,parse_status,subject,from_header,to_header,plain_text,preview)
    VALUES($1,$2,$3,$4,$5,now(),'parsed',$6,$7,$8,$9,$10)`, [messageId, mailbox,
      { envelopeFrom: 'sender@example.test', envelopeTo: 'attachment@example.test' }, digest, rawMessage.length, parsed.subject, parsed.from, parsed.to, parsed.text, parsed.preview]);
  const client = await pool.connect(); try { await storeReaderData(client, messageId, parsed.reader); await enqueueAttachmentExtraction(client, messageId); } finally { client.release(); }
  await runOneAttachmentExtractionJob(pool, rawStore, staging, downloadConfig);
  const extracted = await listAttachments(pool, messageId); assert.equal(extracted.status, 'complete'); assert.equal(extracted.items.length, 4);
  api = buildApp({ databaseUrl, mailStorePath: rawStore.root, ingestKeys: { synthetic: randomBytes(32).toString('base64url') }, devViewToken: '', devMailboxId: '',
    host: '127.0.0.1', port: 0, publicBaseUrl: mainOrigin, downloads: downloadConfig,
    auth: { issuer, clientId, publicBaseUrl: mainOrigin, clientPrivateJwk: { ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }), kid: 'synthetic-rp' } } }, pool,
    { blobs: rawStore, authFetch: async () => { unexpected.push('identity-provider-request'); throw new Error('Unexpected issuer request'); } });
  apiOrigin = await api.listen({ host: '127.0.0.1', port: 0 });
  const controlUrl = `${apiOrigin}/internal/v1/attachments/control`;
  mf = await createDownloadsMiniflare({ bindings: { APP_ORIGIN: mainOrigin, DOWNLOAD_ORIGIN: downloadOrigin, BACKEND_CONTROL_URL: controlUrl,
    CONTROL_KEY_ID: key.id, CONTROL_SECRET: key.secret, ALLOW_INSECURE_LOCAL: 'true' },
    outboundService: async (request: Request) => {
      if (request.url !== controlUrl) { unexpected.push('workerd-unapproved-network'); return new Response(null, { status: 502 }); }
      return fetch(controlUrl, { method: request.method, headers: new Headers([...request.headers]), body: new Uint8Array(await request.arrayBuffer()), redirect: 'error' });
    } });
  const workerFetch: typeof fetch = async (input, init) => {
    const result = await mf!.dispatchFetch(String(input), init);
    return new Response(result.body as ReadableStream<Uint8Array> | null, { status: result.status, headers: new Headers([...result.headers]) });
  };
  for (let count = 0; count < files.length; count++) assert.equal(await runOneAttachmentUpload(pool, staging, downloadConfig, workerFetch), true);
  assert((await listAttachments(pool, messageId)).items.every(item => item.state === 'ready'));
  browser = await chromium.launch({ channel: process.env['PLAYWRIGHT_CHANNEL'] ?? 'chromium', headless: true,
    args: ['--disable-background-networking', `--host-resolver-rules=MAP ${mainHost} 127.0.0.1, MAP ${downloadHost} 127.0.0.1, MAP ${previewHost} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`] });
  browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, acceptDownloads: true });
  await context.addCookies([{ name: SECURE_SESSION_COOKIE, value: token, url: mainOrigin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  context.on('page', page => { page.on('download', download => downloads.push(download)); page.on('pageerror', error => pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); }); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if ([mainOrigin, downloadOrigin, previewOrigin].includes(url.origin)) { await route.continue(); return; }
    unexpected.push(`browser:${url.origin}${url.pathname}`); await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const card = (filename: string) => page.locator('.attachment-card').filter({ hasText: filename });
  const frame = () => page.frameLocator('iframe[title="Attachment preview content"]');
  const waitRendered = async () => { await eventually(async () => await frame().locator('canvas').isVisible() && !(await page.getByText('Preparing a private preview…', { exact: true }).count()), 'rendered preview', 30_000); };
  const close = async () => { await page.getByRole('button', { name: 'Close attachment preview' }).click(); await eventually(async () => !(await page.getByRole('dialog', { name: 'Attachment preview' }).count()), 'preview closed'); };
  await page.goto(mainOrigin); await page.locator('.message-item').click(); await card('synthetic.pdf').waitFor();
  await check('real extraction/upload exposes ordinary attachments without reading their bytes on mail open', async () => {
    assert.equal(await page.locator('.attachment-card').count(), 4); assert.equal(byteRequests.length, 0);
    assert.equal(await card('active.svg').getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    assert.equal(await card('notes.txt').getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    await page.screenshot({ path: join(output, 'attachment-list.png'), fullPage: true });
  });
  await check('actual cookie bootstrap and bounded Range render a synthetic PDF in an isolated origin', async () => {
    await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered();
    assert(await page.getByText('Page 1 of 2', { exact: true }).isVisible());
    const canvas = await frame().locator('canvas').evaluate(element => { const value = element as HTMLCanvasElement; return { width: value.width, height: value.height, colored: [...value.getContext('2d')!.getImageData(0, 0, value.width, value.height).data].some((part, index) => index % 4 !== 3 && part < 200) }; });
    assert(canvas.colored && canvas.width * canvas.height <= 16_000_000);
    assert.equal(await page.locator('canvas').count(), 0); assert.deepEqual(previewCookies, []);
    assert(byteRequests.some(item => item.method === 'HEAD') && byteRequests.some(item => item.method === 'GET'));
    assert(byteRequests.every(item => item.origin === mainOrigin && (item.method === 'HEAD' || item.range?.startsWith('bytes='))));
    assert.equal(await frame().locator('body').evaluate(() => { try { void parent.document.body; return false; } catch { return true; } }), true);
    assert.equal(await frame().locator('body').evaluate(() => (window as unknown as Record<string, unknown>).__pdfScriptExecuted ?? false), false);
    await page.screenshot({ path: join(output, 'pdf-preview.png'), fullPage: true });
    await page.getByRole('button', { name: 'Next page', exact: true }).click(); await page.getByText('Page 2 of 2', { exact: true }).waitFor();
    await close();
  });
  await check('new preview transfer reuses a scoped session and renders only the selected raster', async () => {
    const before = (await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count;
    await card('synthetic.png').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered();
    const pixel = await frame().locator('canvas').evaluate(element => [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data]);
    assert.deepEqual(pixel, [20, 130, 220, 255]);
    assert.equal((await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count, before);
    assert.equal((await pool!.query('SELECT count(*)::int AS count FROM attachment_download_transfers')).rows[0].count, 2);
    await close();
  });
  await check('adjacent attachment navigation replaces only the isolated per-file preview', async () => {
    await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered();
    await page.getByRole('button', { name: 'Next attachment', exact: true }).click(); await waitRendered();
    assert.equal(await page.getByText('Page 1 of 2', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Previous attachment', exact: true }).click(); await waitRendered();
    assert(await page.getByText('Page 1 of 2', { exact: true }).isVisible()); await close();
  });
  await check('inventory drift preserves ready attachments and an open immutable preview', async () => {
    await pool!.query("UPDATE attachment_inventories SET status='drift',error_code='attachment_inventory_drift' WHERE delivery_id=$1", [messageId]);
    await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await page.getByText('Attachment verification needs attention. The original message is still available.', { exact: true }).waitFor();
    assert.equal(await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).isEnabled(), true);
    assert.equal(await card('notes.txt').getByRole('button', { name: 'Download attachment notes.txt', exact: true }).isEnabled(), true);
    await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered(); await close();
  });
  await check('native download uses the real Worker and exact immutable R2 bytes', async () => {
    const before = downloads.length;
    await card('notes.txt').getByRole('button', { name: 'Download attachment notes.txt', exact: true }).click();
    await eventually(() => downloads.length > before, 'native browser download');
    const download = downloads.at(-1)!; const path = await download.path(); assert(path); assert.deepEqual(await readFile(path), textBytes); await download.delete();
    assert.equal(download.suggestedFilename(), 'notes.txt');
    assert(await page.getByRole('link', { name: 'Download notes.txt', exact: true }).isVisible());
    const bare = await mf!.dispatchFetch(await page.getByRole('link', { name: 'Download notes.txt', exact: true }).getAttribute('href')!); assert.equal(bare.status, 401);
    assert(downloadCookieNames.size >= 2);
  });
  await check('closing a preview invalidates its delayed byte delivery before another file opens', async () => {
    let release!: () => void; const promise = new Promise<void>(done => { release = done; });
    const gate = { arrived: false, release: promise, resolve: release }; holdByteResponse = gate;
    await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).click(); await eventually(() => gate.arrived, 'held actual Worker range');
    await close(); release(); await card('synthetic.png').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered();
    assert.equal(await page.getByText('Page 1 of 2', { exact: true }).count(), 0); await close();
  });
  await check('failed metadata refresh disables stale actions and clears the prepared download link', async () => {
    failInventory = true; await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
    await page.getByText('Attachment access expired or changed. Close this preview and try again.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Download notes.txt', exact: true }).count(), 0);
    assert.equal(await card('notes.txt').getByRole('button', { name: 'Download attachment notes.txt', exact: true }).isDisabled(), true);
    assert.equal(await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    failInventory = false; await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
    await card('synthetic.pdf').getByRole('button', { name: 'Preview', exact: true }).waitFor();
  });
  await check('twenty full page reloads reuse a noncredential locator instead of consuming new cookies', async () => {
    const before = (await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count;
    for (let index = 0; index < 20; index++) {
      await page.reload(); await page.locator('.message-item').click(); await card('synthetic.png').waitFor();
      await card('synthetic.png').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered(); await close();
    }
    assert.equal((await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count, before);
    const records = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('dreampost:attachment-session:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)));
    assert(records.length >= 1); for (const value of records) assert.deepEqual(Object.keys(value).sort(), ['expiresAt', 'purpose', 'sessionId']);
  });
  await check('evicted download cookie is detected by HEAD and recovered before preview readiness', async () => {
    const locator = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('dreampost:attachment-session:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)).find(value => value.purpose === 'preview'));
    assert(locator?.sessionId); const before = (await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count;
    await context!.clearCookies({ name: `__Host-dp-download-${locator.sessionId}` });
    await card('synthetic.png').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered(); await close();
    const replaced = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('dreampost:attachment-session:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)).find(value => value.purpose === 'preview'));
    assert.notEqual(replaced.sessionId, locator.sessionId);
    assert.equal((await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count, before + 1);
  });
  await check('concurrent tabs serialize their first bootstrap and retain separate authorized transfers', async () => {
    assert.equal(await page.evaluate(() => !!navigator.locks), true);
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('dreampost:attachment-session:v1:') && JSON.parse(localStorage.getItem(key)!).purpose === 'download') localStorage.removeItem(key); });
    const second = await context!.newPage(); await second.goto(mainOrigin); await second.locator('.message-item').click();
    await second.locator('.attachment-card').filter({ hasText: 'notes.txt' }).waitFor();
    const before = (await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count, count = downloads.length;
    await Promise.all([card('notes.txt').getByRole('button', { name: 'Download attachment notes.txt', exact: true }).click(), second.getByRole('button', { name: 'Download attachment notes.txt', exact: true }).click()]);
    await eventually(() => downloads.length >= count + 2, 'both native downloads');
    assert.equal((await pool!.query('SELECT count(*)::int AS count FROM attachment_download_sessions')).rows[0].count, before + 1);
    for (const download of downloads.slice(count)) { const path = await download.path(); assert(path); assert.deepEqual(await readFile(path), textBytes); await download.delete(); }
    await second.close();
  });
  await check('390px preview controls fit without exposing renderer credentials', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await card('synthetic.png').getByRole('button', { name: 'Preview', exact: true }).click(); await waitRendered();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(previewCookies, []);
    const cookies = await context!.cookies(previewOrigin); assert.equal(cookies.length, 0);
    await page.screenshot({ path: join(output, 'mobile-preview.png'), fullPage: true }); await close();
  });
  await check('all synthetic attachment requests stay within approved local origins', async () => {
    assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
    // The intentional authorization failure is expected to produce one browser resource-error console entry.
    assert(consoleErrors.every(value => /401|403/.test(value)), JSON.stringify(consoleErrors));
    assert.equal(await rawStore.get(digest).then(bytes => hash(bytes)), digest);
  });
} catch (error) {
  process.exitCode = 1; console.error(error instanceof Error ? error.message : 'Attachment browser verification failed.');
  const page = context?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(output, 'failure-diagnostic.json'), JSON.stringify({ text: await page.locator('body').innerText().catch(() => ''), frames: await Promise.all(page.frames().map(frame => frame.evaluate(() => ({ origin: location.origin, text: document.body.innerText.slice(0, 1000), canvas: [...document.querySelectorAll('canvas')].map(canvas => ({ width: canvas.width, height: canvas.height })) })).catch(() => null))), pageErrors, consoleErrors }, null, 2));
  }
} finally {
  holdByteResponse?.resolve(); activeGate?.resolve();
  await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await mf?.dispose().catch(() => {}); await api?.close().catch(() => {});
  if (server?.listening) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
  await pool?.end(); if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  if (workDirectory) await rm(workDirectory, { recursive: true, force: true });
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'report.json'), JSON.stringify({ completedAt: new Date().toISOString(), status: process.exitCode ? 'failed' : 'passed', browserVersion,
    scope: 'Generated MIME/PDF/raster and SSO identity; real isolated PostgreSQL API, extraction/upload pipeline, local Workerd/R2, built UI and separate-site renderer. Exact local TLS hosts only, other DNS denied. No live cloud or user mail.',
    checks, byteRequests, previewCookieRequests: previewCookies.length, downloadSessionCookieNamesObserved: downloadCookieNames.size, unexpected, pageErrors, consoleErrors, schemaRemoved: true }, null, 2) + '\n');
}
