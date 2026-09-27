/** Isolated browser verification. No real mail, identity-provider requests, or external resources are used. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { buildApp } from '../apps/api/src/app.js';
import { migrate } from '../apps/api/src/database.js';
import { parseMimeIsolated, storeReaderData } from '../apps/api/src/reader-data.js';
import { SESSION_COOKIE } from '../apps/api/src/auth/types.js';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.local', 'reader-qa');
const databaseUrl = process.env['TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required. The runner creates and removes its own isolated schema.');
const schema = `reader_browser_${randomUUID().replaceAll('-', '')}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64');
const checks: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = [];
const unexpectedRequests: string[] = [];
const serverRequests: string[] = [];
const imageRequests: Array<{ path: string; referrer: string | null }> = [];
const popupRequests: Array<{ referrer: string | null }> = [];
const browserErrors: string[] = [];
const consoleErrors: string[] = [];
let browserVersion = '';
const raw = new Map<string, Buffer>();
let schemaCreated = false;
let api: ReturnType<typeof buildApp> | undefined;
let apiOrigin = '';
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = '';
let externalImagesAllowed = false;
let popupAllowed = false;
let negativeControl = false;
let negativeProbeCount = 0;
let negativeTlsProbeCount = 0;
let tlsServer: ReturnType<typeof createHttpsServer> | undefined;
let certificateDirectory: string | undefined;
const knownImagePaths = new Set(['/hero.png?fixture=alpha', '/background.png?fixture=alpha', '/beta.png']);
let releaseDelayedRender: (() => void) | undefined;
let delayedRender: { path: string; arrived: () => void; released: Promise<void> } | null = null;
const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
let pool: InstanceType<typeof Pool> | undefined;
const web = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (['/api/', '/auth/', '/backchannel/', '/.well-known/'].some(prefix => path.startsWith(prefix))) {
    if (!apiOrigin) { response.writeHead(503).end(); return; }
    const proxy = httpRequest(`${apiOrigin}${request.url}`, { method: request.method, headers: request.headers }, upstream => {
      // Keep this reader-specific harness on the established read-only layout; all reader/auth APIs remain real.
      if (path === '/api/config' && upstream.statusCode === 200) {
        const chunks: Buffer[] = []; upstream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        upstream.on('end', () => { const config = JSON.parse(Buffer.concat(chunks).toString()); const body = Buffer.from(JSON.stringify({ ...config, everydayMail: false })); response.writeHead(200, { ...upstream.headers, 'content-length': String(body.length) }); response.end(body); });
      } else { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); }
    });
    proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(proxy); return;
  }
  if (path === '/favicon.ico') { response.writeHead(204).end(); return; }
  const asset = path.match(/^\/assets\/([A-Za-z0-9_.-]+\.(?:js|css))$/);
  const file = path === '/' ? join(root, 'apps/web/dist/index.html') : asset ? join(root, 'apps/web/dist/assets', asset[1]!) : null;
  if (!file) { response.writeHead(404).end(); return; }
  void readFile(file).then(bytes => {
    response.writeHead(200, { 'Content-Type': path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(bytes);
  }).catch(() => response.writeHead(404).end());
});

async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, status: 'failed', error: error instanceof Error ? error.message : 'Unknown failure' }); throw error; }
}
async function eventually(predicate: () => Promise<boolean> | boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function safeDiagnostic(url: string) { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; }

try {
  await readFile(join(root, 'apps/web/dist/index.html'));
  await mkdir(output, { recursive: true });
  await new Promise<void>(done => web.listen(0, '127.0.0.1', done));
  const address = web.address(); assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
  await migrate(pool);
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const auth = { issuer: 'https://identity.example.test', clientId: 'dreampost-reader-qa', publicBaseUrl: origin,
    clientPrivateJwk: { ...key, kid: 'reader-qa' }, allowInsecureLocal: true };
  const users: Array<{ id: string; cookie: string; csrf: string }> = [];
  for (const username of ['reader-alice', 'reader-bob']) {
    const id = randomUUID(), cookie = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO principals(id,issuer,subject,username,display_name,app_role,access_enabled) VALUES($1,$2,$4,$3,$3,1,true)', [id, auth.issuer, username, id]);
    await pool.query(`INSERT INTO auth_sessions(token_hash,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at,client_id)
      VALUES($1,$2,$3,0,$4,'synthetic-qa',now()+interval '2 hours',now()+interval '2 hours',now()+interval '1 day',$5)`,
    [createHash('sha256').update(cookie).digest('hex'), id, randomUUID(), csrf, auth.clientId]);
    users.push({ id, cookie, csrf });
  }
  const alice = users[0]!, bob = users[1]!;
  const mailboxId = randomUUID(), allocationId = randomUUID();
  await pool.query("INSERT INTO mailboxes(id,address,name,mailbox_type) VALUES($1,'reader-shared@example.test','Reader QA shared mailbox','shared')", [mailboxId]);
  for (const user of users) await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])", [mailboxId, user.id]);
  await pool.query("INSERT INTO address_registry(address,domain,state) VALUES('reader-shared@example.test','example.test','allocated')");
  await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source) VALUES($1,'reader-shared@example.test',$2,'manual')", [allocationId, mailboxId]);
  await pool.query("UPDATE address_registry SET current_allocation_id=$1 WHERE address='reader-shared@example.test'", [allocationId]);
  await pool.query('UPDATE auth_settings SET last_catalog_sync=now(),catalog_issuer=$1,catalog_client_id=$2', [auth.issuer, auth.clientId]);

  const alphaHtml = `<!doctype html><html><head><style>
    @font-face{font-family:"Reader Remote Font";src:url(https://images.example.com/tracker.woff2)}
    @import url(https://images.example.com/tracker.css);
    #typography{font-family:"Reader Remote Font",Georgia,serif;font-size:22px;font-weight:700;line-height:33px}
    #background{background-image:url(https://images.example.com/background.png?fixture=alpha);width:120px;height:40px}
  </style></head><body>
    <h2 id="message-alpha">Alpha HTML body</h2><p id="typography">Typography is preserved</p>
    <img id="inline-logo" src="cid:fixture-inline" alt="Embedded logo">
    <img id="hero-image" src="https://images.example.com/hero.png?fixture=alpha" alt="Remote hero"><div id="background">Image background</div>
    <a id="safe-link" href="https://links.example.com/continue" target="_top">Open synthetic link</a><p style="margin-top:1100px">Long-message scroll marker</p>
    <script>window.__mailScriptExecuted=true;parent.__mailScriptExecuted=true</script>
    <img src="${origin}/__qa_forbidden.png" onerror="parent.__mailScriptExecuted=true">
    <form action="${origin}/api/preferences"><input name="unsafe"></form>
    </body></html>`;
  const payloads = [
    { name: 'Textarea', html: '<textarea><img src="https://sink.example.com/textarea.png" onerror="parent.__mailScriptExecuted=true"></textarea>' },
    { name: 'MathML', html: '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=parent.__mailScriptExecuted=true>"></math>' },
    { name: 'Noscript', html: '<noscript><p title="</noscript><img src=x onerror=parent.__mailScriptExecuted=true>">unsafe</p></noscript>' },
    { name: 'CSS raw text', html: String.raw`<style>.raw{font-family:"\3c /style\3e \3c img src=x onerror=parent.__mailScriptExecuted=true\3e "}</style><p class="raw">Raw text remains text</p>` },
  ];
  async function message(subject: string, html: string, marker: string, inline = false) {
    const id = randomUUID();
    const source = Buffer.from([
      'From: Fixture Sender <sender@example.test>', 'Reply-To: Replies <reply@example.test>',
      'To: Reader QA <reader-shared@example.test>', 'Cc: Copy <copy@example.test>',
      `Subject: ${subject}`, 'Date: Sat, 26 Sep 2026 10:30:00 +0000', `Message-ID: <${id}@example.test>`,
      'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="related-fixture"', '',
      '--related-fixture', 'Content-Type: multipart/alternative; boundary="alternative-fixture"', '',
      '--alternative-fixture', 'Content-Type: text/plain; charset=utf-8', '', `${subject} plain text fallback.`,
      '--alternative-fixture', 'Content-Type: text/html; charset=utf-8', '', `${html}<p id="${marker}">Fixture marker</p>`, '--alternative-fixture--',
      ...(inline ? ['--related-fixture', 'Content-Type: image/png', 'Content-ID: <fixture-inline>', 'Content-Disposition: inline', 'Content-Transfer-Encoding: base64', '', png.toString('base64')] : []),
      '--related-fixture', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="fixture.txt"', 'Content-Transfer-Encoding: base64', '', 'Rml4dHVyZSBhdHRhY2htZW50',
      '--related-fixture--', '',
    ].join('\r\n'));
    const parsed = await parseMimeIsolated(source);
    const digest = createHash('sha256').update(source).digest('hex'); raw.set(digest, source);
    const metadata = { version: 1, deliveryId: id, mailboxId, envelopeFrom: 'bounce@example.test', envelopeTo: 'reader-shared@example.test', receivedAt: new Date().toISOString(), rawSize: source.length };
    await pool!.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,parse_status,subject,from_header,to_header,plain_text,preview)
      VALUES($1,$2,$3,$4,$5,now(),'parsed',$6,$7,$8,$9,$10)`, [id, mailboxId, metadata, digest, source.length, parsed.subject, parsed.from, parsed.to, parsed.text, parsed.preview]);
    const client = await pool!.connect();
    try { await storeReaderData(client, id, parsed.reader); } finally { client.release(); }
    return { id, subject, marker, source, digest };
  }
  const alpha = await message('Fixture Alpha', alphaHtml, 'alpha-marker', true);
  const beta = await message('Fixture Beta', '<h2 id="message-beta">Beta HTML body</h2><img src="https://images.example.com/beta.png" alt="Beta remote image">', 'beta-marker');
  const adversarial = [];
  for (const [index, payload] of payloads.entries()) adversarial.push(await message(`Fixture ${payload.name}`, payload.html, `adversarial-${index}`));

  api = buildApp({ databaseUrl, mailStorePath: join(output, 'unused-mail-store'), ingestKeys: { qa: randomBytes(32).toString('hex') },
    devViewToken: '', devMailboxId: '', host: '127.0.0.1', port: 0, publicBaseUrl: origin, auth }, pool,
  { blobs: { put: async () => { throw new Error('The QA reader must never write mail blobs.'); }, get: async digest => { const bytes = raw.get(digest); assert(bytes); return bytes; } },
    authFetch: async input => { serverRequests.push(safeDiagnostic(String(input))); throw new Error('Unexpected identity-provider network request'); } });
  apiOrigin = await api.listen({ host: '127.0.0.1', port: 0 });
  certificateDirectory = await mkdtemp(join(output, 'fixture-tls-'));
  const keyFile = join(certificateDirectory, 'key.pem'), certFile = join(certificateDirectory, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=images.example.com', '-keyout', keyFile, '-out', certFile]);
  tlsServer = createHttpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (request, response) => {
    const host = request.headers.host?.split(':')[0]; const path = request.url ?? '/';
    if (host === 'images.example.com' && path === '/probe.png' && negativeControl) {
      negativeTlsProbeCount++; response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(png); return;
    }
    if (host === 'images.example.com' && externalImagesAllowed && knownImagePaths.has(path)) {
      imageRequests.push({ path, referrer: request.headers.referer ?? null });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(png); return;
    }
    if (host === 'links.example.com' && path === '/continue' && popupAllowed) {
      popupRequests.push({ referrer: request.headers.referer ?? null });
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Synthetic destination</title><p>Synthetic link destination</p>'); return;
    }
    if (path === '/favicon.ico') { response.writeHead(204).end(); return; }
    unexpectedRequests.push(`https://${host}${path.split('?')[0]}`); response.writeHead(403).end();
  });
  await new Promise<void>(done => tlsServer!.listen(0, '127.0.0.1', done));
  const tlsAddress = tlsServer.address(); assert(tlsAddress && typeof tlsAddress === 'object');
  browser = await chromium.launch({ channel: process.env['PLAYWRIGHT_CHANNEL'] ?? 'chromium', headless: true, args: ['--disable-background-networking', `--host-resolver-rules=MAP images.example.com 127.0.0.1:${tlsAddress.port}, MAP links.example.com 127.0.0.1:${tlsAddress.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`] });
  browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'UTC', acceptDownloads: true, ignoreHTTPSErrors: true });
  await context.addCookies([{ name: SESSION_COOKIE, value: alice.cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin) {
      if (url.pathname === '/__qa_probe.png' && negativeControl) { negativeProbeCount++; await route.fulfill({ contentType: 'image/png', body: png }); return; }
      const allowed = url.pathname === '/' || url.pathname === '/favicon.ico' || /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(url.pathname)
        || ['/api/config', '/auth/session', '/api/preferences', '/api/mailboxes'].includes(url.pathname)
        || url.pathname === `/api/mailboxes/${mailboxId}/messages`
        || [alpha, beta, ...adversarial].some(item => [ '', '/render', '/raw' ].some(suffix => url.pathname === `/api/mailboxes/${mailboxId}/messages/${item.id}${suffix}`));
      if (allowed) {
        if (delayedRender?.path === `${url.pathname}${url.search}`) {
          const pending = delayedRender; delayedRender = null;
          const response = await route.fetch(); pending.arrived(); await pending.released;
          await route.fulfill({ response }).catch(() => {}); return;
        }
        await route.continue(); return;
      }
    }
    if (url.origin === 'https://images.example.com' || url.origin === 'https://links.example.com') {
      // Opaque srcdoc requests can bypass Playwright routing. DNS maps these exact hosts only to our TLS fixture,
      // whose handler independently enforces the consent/path boundary and records all actual requests.
      await route.continue(); return;
    }
    unexpectedRequests.push(safeDiagnostic(url.href)); await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  async function open(item: { subject: string; marker: string }) {
    await page.locator('.message-item').filter({ hasText: item.subject }).click();
    await page.frameLocator('.message-html-frame').locator(`#${item.marker}`).waitFor();
  }
  async function frame() {
    const handle = await page.locator('.message-html-frame').elementHandle(); assert(handle);
    const result = await handle.contentFrame(); assert(result); return result;
  }
  async function quietWindow() { await page.waitForTimeout(250); }

  await check('negative control proves request trap and script sentinel are active', async () => {
    await page.goto(origin);
    negativeControl = true;
    await page.setContent(`<iframe title="Negative control" srcdoc="&lt;script&gt;parent.__negativeControlExecuted=true&lt;/script&gt;&lt;img src='${origin}/__qa_probe.png'&gt;&lt;img src='https://images.example.com/probe.png'&gt;"></iframe>`);
    await eventually(() => negativeProbeCount === 1 && negativeTlsProbeCount === 1, 'negative control local and TLS image probes');
    assert.equal(await page.evaluate(() => (window as unknown as Record<string, unknown>).__negativeControlExecuted), true);
    negativeControl = false;
  });
  await page.goto(origin);
  await page.locator('.message-item').filter({ hasText: alpha.subject }).waitFor();
  await check('HTML and CID render with zero external requests by default', async () => {
    await open(alpha); await quietWindow();
    assert.equal(imageRequests.length, 0); assert.deepEqual(unexpectedRequests, []);
    assert(await page.getByRole('button', { name: 'Load images', exact: true }).isVisible());
    assert.equal(await (await frame()).locator('#inline-logo').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0), true);
    await page.screenshot({ path: join(output, 'desktop-blocked.png'), fullPage: true });
  });
  await check('HTML stays outside the application DOM and the frame has opaque origin', async () => {
    assert.equal(await page.locator('#message-alpha').count(), 0);
    const isolated = await frame();
    assert.equal(await isolated.locator('script,form,input,iframe,object,embed,svg,math,textarea,noscript').count(), 0);
    assert.equal(await isolated.evaluate(() => Object.keys(window).includes('__mailScriptExecuted')), false);
    assert.equal(await page.evaluate(() => Object.keys(window).includes('__mailScriptExecuted')), false);
    assert.equal(await isolated.evaluate(() => { try { void parent.document.body; return false; } catch (error) { return error instanceof DOMException && error.name === 'SecurityError'; } }), true);
    assert.equal(await page.locator('.message-html-frame').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
  });
  await check('safe typography survives while remote font loading stays disabled', async () => {
    const typography = await (await frame()).locator('#typography').evaluate(element => {
      const style = getComputedStyle(element); return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight };
    });
    assert.match(typography.family, /Reader Remote Font/); assert.match(typography.family, /Georgia/);
    assert.equal(typography.size, '22px'); assert.equal(typography.weight, '700'); assert.equal(typography.lineHeight, '33px');
    assert.deepEqual(unexpectedRequests, []);
  });
  await check('message details expose available metadata without invented TLS or authentication badges', async () => {
    await page.getByRole('button', { name: 'Message details' }).click();
    const details = page.getByRole('region', { name: 'Message details' });
    assert.match(await details.innerText(), /Reply-To[\s\S]*reply@example.test/);
    assert.match(await details.innerText(), /Date[\s\S]*2026/);
    assert.match(await details.innerText(), /Envelope sender[\s\S]*bounce@example.test/);
    assert.doesNotMatch(await details.innerText(), /TLS|Signed-by|Mailed-by|Unavailable|Unknown security/i);
    await page.keyboard.press('Escape'); assert.equal(await details.count(), 0);
  });
  await check('plaintext is escaped and attachment downloads are absent', async () => {
    await page.getByRole('button', { name: 'Plain text', exact: true }).click();
    await page.locator('.message-body').waitFor(); assert.match(await page.locator('.message-body').innerText(), /Fixture Alpha plain text fallback/);
    assert.equal(await page.locator('.message-html-frame').count(), 0);
    assert.equal(await page.getByRole('button', { name: /download attachment/i }).count(), 0);
    assert.equal(await page.getByRole('link', { name: /fixture\.txt|download attachment/i }).count(), 0);
    await page.getByRole('button', { name: 'HTML', exact: true }).click(); await page.frameLocator('.message-html-frame').locator('#alpha-marker').waitFor();
  });
  await check('explicit image loading fetches only the intended image and background without a referrer', async () => {
    externalImagesAllowed = true;
    await page.getByRole('button', { name: 'Load images', exact: true }).click();
    await eventually(() => imageRequests.length === 2, 'exact image and background requests'); await quietWindow();
    assert.deepEqual(imageRequests.map(item => item.path).sort(), ['/background.png?fixture=alpha', '/hero.png?fixture=alpha']);
    assert(imageRequests.every(item => item.referrer === null)); assert.deepEqual(unexpectedRequests, []);
    await page.screenshot({ path: join(output, 'desktop-images-loaded.png'), fullPage: true });
  });
  await check('refreshing unchanged mail preserves its iframe, scroll, and image request count', async () => {
    const before = imageRequests.length;
    await page.locator('.message-html-frame').evaluate(element => { (window as unknown as Record<string, unknown>).__readerFrameBeforeRefresh = element; });
    const isolated = await frame(); await isolated.evaluate(() => scrollTo(0, 150));
    assert.equal(await isolated.evaluate(() => scrollY), 150);
    const detailResponse = page.waitForResponse(response => response.url() === `${origin}/api/mailboxes/${mailboxId}/messages/${alpha.id}` && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await detailResponse; await quietWindow();
    assert.equal(await page.locator('.message-html-frame').evaluate(element => (window as unknown as Record<string, unknown>).__readerFrameBeforeRefresh === element), true);
    assert.equal(await (await frame()).evaluate(() => scrollY), 150);
    assert.equal(imageRequests.length, before);
    await page.getByRole('button', { name: 'Block images', exact: true }).click();
    await page.getByRole('button', { name: 'Load images', exact: true }).waitFor(); externalImagesAllowed = false;
    await quietWindow(); assert.equal(imageRequests.length, 2);
  });
  await check('safe link popup requires a click and has neither opener nor referrer', async () => {
    assert.equal(popupRequests.length, 0); popupAllowed = true;
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.frameLocator('.message-html-frame').getByRole('link', { name: 'Open synthetic link' }).click()]);
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    assert.deepEqual(popupRequests, [{ referrer: null }]); await popup.close(); popupAllowed = false;
  });
  await check('manual image consent does not carry into another message', async () => {
    externalImagesAllowed = true; await page.getByRole('button', { name: 'Load images', exact: true }).click();
    await page.getByRole('button', { name: 'Block images', exact: true }).waitFor(); await quietWindow();
    const count = imageRequests.length; externalImagesAllowed = false;
    await open(beta); await quietWindow();
    assert(await page.getByRole('button', { name: 'Load images', exact: true }).isVisible()); assert.equal(imageRequests.length, count); assert.deepEqual(unexpectedRequests, []);
  });
  await check('a delayed old render response cannot replace the current message', async () => {
    const release = deferred(); let arrived = false; releaseDelayedRender = release.resolve;
    delayedRender = { path: `/api/mailboxes/${mailboxId}/messages/${alpha.id}/render?remoteImages=blocked`, arrived: () => { arrived = true; }, released: release.promise };
    await page.locator('.message-item').filter({ hasText: alpha.subject }).click();
    await eventually(() => arrived, 'delayed render request'); await open(beta); release.resolve(); releaseDelayedRender = undefined; await quietWindow();
    assert.equal(await page.frameLocator('.message-html-frame').locator('#beta-marker').count(), 1);
    assert.equal(await page.frameLocator('.message-html-frame').locator('#alpha-marker').count(), 0);
  });
  await check('browser reparsing of adversarial HTML creates no active elements, scripts, or resource requests', async () => {
    const before = imageRequests.length;
    for (const item of adversarial) {
      await open(item); await quietWindow(); const isolated = await frame();
      assert.equal(await isolated.locator('script,iframe,object,embed,svg,math,textarea,noscript').count(), 0);
      assert.equal(await isolated.locator('[onerror],[onload],[onclick]').count(), 0);
      assert.equal(await isolated.evaluate(() => Object.keys(window).includes('__mailScriptExecuted')), false);
      assert.equal(await page.evaluate(() => Object.keys(window).includes('__mailScriptExecuted')), false);
    }
    assert.equal(imageRequests.length, before); assert.deepEqual(unexpectedRequests, []);
  });
  await check('personal automatic-image preference persists and does not change another shared-mailbox reader', async () => {
    await page.getByRole('button', { name: 'Account menu' }).click(); await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
    const toggle = page.getByRole('checkbox', { name: 'Automatically load external images' });
    await toggle.waitFor(); assert.equal(await toggle.isChecked(), false);
    await toggle.click(); await page.getByText('Preference saved.', { exact: true }).waitFor(); assert.equal(await toggle.isChecked(), true);
    assert.equal((await pool!.query('SELECT auto_load_external_images FROM principal_preferences WHERE principal_id=$1', [alice.id])).rows[0].auto_load_external_images, true);
    assert.equal((await pool!.query('SELECT count(*)::int AS count FROM principal_preferences WHERE principal_id=$1', [bob.id])).rows[0].count, 0);
    await page.reload(); await page.locator('.message-item').filter({ hasText: alpha.subject }).waitFor();
    externalImagesAllowed = true; const before = imageRequests.length; await open(alpha);
    await eventually(() => imageRequests.length >= before + 2, 'automatic loading after persisted preference');
    await page.getByRole('button', { name: 'Account menu' }).click(); await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
    await toggle.waitFor(); assert.equal(await toggle.isChecked(), true);
    await toggle.click(); await page.getByText('Preference saved.', { exact: true }).waitFor(); assert.equal(await toggle.isChecked(), false); externalImagesAllowed = false;
    await page.getByRole('button', { name: 'Mail', exact: true }).click(); await open(alpha);
    assert(await page.getByRole('button', { name: 'Load images', exact: true }).isVisible());
  });
  await check('390px reading layout has no outer horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.frameLocator('.message-html-frame').locator('#alpha-marker').waitFor();
    const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert(dimensions.document <= dimensions.width + 1 && dimensions.body <= dimensions.width + 1, JSON.stringify(dimensions));
    await page.getByRole('button', { name: 'Message details' }).click();
    const detailBox = await page.getByRole('region', { name: 'Message details' }).boundingBox(); assert(detailBox && detailBox.x >= 0 && detailBox.x + detailBox.width <= 391);
    await page.screenshot({ path: join(output, 'mobile-details.png'), fullPage: true }); await page.keyboard.press('Escape');
  });
  await check('original EML remains downloadable as the exact synthetic bytes', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download original', exact: true }).click()]);
    const path = await download.path(); assert(path); assert.deepEqual(await readFile(path), alpha.source); await download.delete();
  });
  await check('all requests stayed inside the approved synthetic test boundary', async () => {
    assert.deepEqual(unexpectedRequests, []); assert.deepEqual(serverRequests, []); assert.deepEqual(browserErrors, []); assert.deepEqual(consoleErrors, []);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Reader browser verification failed.'); process.exitCode = 1;
  const failedPage = context?.pages()[0];
  if (failedPage) {
    await failedPage.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    const diagnostic = await Promise.all(failedPage.frames().map(frame => frame.evaluate(() => ({
      url: location.href, policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      images: [...document.images].map(image => ({ source: image.getAttribute('src'), complete: image.complete, width: image.naturalWidth })),
      background: document.getElementById('background') ? getComputedStyle(document.getElementById('background')!).backgroundImage : null,
    })).catch(() => null)));
    await writeFile(join(output, 'failure-diagnostic.json'), JSON.stringify({ diagnostic, consoleErrors }, null, 2) + '\n');
  }
} finally {
  delayedRender = null; releaseDelayedRender?.();
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await api?.close().catch(() => {});
  if (tlsServer?.listening) await new Promise<void>(done => { tlsServer!.close(() => done()); tlsServer!.closeAllConnections(); });
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
  if (web.listening) await new Promise<void>(done => { web.close(() => done()); web.closeAllConnections(); });
  await pool?.end().catch(() => {});
  if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify({ completedAt: new Date().toISOString(), status: process.exitCode ? 'failed' : 'passed',
    scope: 'Isolated schema and generated synthetic session only; real MIME parser, API, sanitizer, and built UI. Exact synthetic image/link hosts map to a loopback HTTPS fixture; all other external DNS is denied. Ephemeral test certificate errors are ignored only in this QA browser; application sandbox/CSP/site isolation are unchanged.',
    browserVersion, checks, imageRequests, popupRequests, negativeProbeCount, negativeTlsProbeCount, unexpectedRequests, serverRequests, browserErrors, consoleErrors, schemaRemoved: true }, null, 2) + '\n');
}
