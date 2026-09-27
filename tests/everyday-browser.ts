/** Actual local API/PostgreSQL/browser checks using only synthetic identities and generated mail. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { buildApp } from '../apps/api/src/app.js';
import { migrate, appendChange } from '../apps/api/src/database.js';
import { FileBlobStore } from '../apps/api/src/blob-store.js';
import { enqueueAttachmentExtraction, runOneAttachmentExtractionJob } from '../apps/api/src/attachments/service.js';
import { FileAttachmentStagingStore } from '../apps/api/src/attachments/storage.js';
import { parseMimeIsolated, storeReaderData } from '../apps/api/src/reader-data.js';
import { AuthService, type AuthConfig } from '../apps/api/src/auth/index.js';
import { SESSION_COOKIE } from '../apps/api/src/auth/types.js';
import { AddressService } from '../apps/api/src/addresses/index.js';
import { indexMessageThread, initializeMessageState } from '../apps/api/src/mail/index.js';
import { OutboundService, loadOutboundConfig, runOneOutboundJob } from '../apps/api/src/outbound/index.js';
import { createOutboundDependencies } from '../apps/api/src/outbound-integration.js';
import type { ApiConfig } from '../apps/api/src/config.js';
import type { MailTransport } from '../packages/protocol/dist/index.js';

const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = requireApi('pg');
const databaseUrl = process.env['TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; this runner creates and drops an isolated schema.');
const root = resolve(new URL('..', import.meta.url).pathname), output = resolve(root, process.env['EVERYDAY_QA_OUTPUT'] ?? '.local/everyday-qa');
const only = process.env['EVERYDAY_QA_ONLY'];
const readOpeningEvidence: Array<{ view: string; phase: string; mutations: Array<{ read: boolean; version: string; status?: number }> }> = [];
const schema = `everyday_browser_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
let pool: InstanceType<typeof Pool> | undefined, directory: string | undefined, api: ReturnType<typeof buildApp> | undefined;
let browser: Browser | undefined, context: BrowserContext | undefined, second: BrowserContext | undefined;
let apiOrigin = '', origin = '', schemaCreated = false;
const checks: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = [];
const unexpected: string[] = [], consoleErrors: string[] = [], requests: Array<{ path: string; background: string | undefined }> = [];
const providerCalls: Array<{ recipients: string[]; bytes: Buffer }> = [];
const transport: MailTransport = { capabilities: { maxMessageBytes: 1024 * 1024, maxRecipients: 50, supportsIdempotencyKey: false }, async send(request) { providerCalls.push({ recipients: [...request.recipients], bytes: Buffer.from(request.mime) }); return { providerMessageId: `synthetic-${providerCalls.length}`, recipients: request.recipients.map(address => ({ address, status: 'accepted' as const })) }; } };
let closeSse: (() => void) | undefined;
const web = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path.startsWith('/api/') || path.startsWith('/auth/')) {
    requests.push({ path, background: typeof request.headers['x-dreampost-background'] === 'string' ? request.headers['x-dreampost-background'] : undefined });
    const proxy = httpRequest(`${apiOrigin}${request.url}`, { method: request.method, headers: request.headers }, upstream => { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); });
    proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); response.on('close', () => proxy.destroy()); request.pipe(proxy); return;
  }
  if (path === '/favicon.ico') { response.writeHead(204).end(); return; }
  const asset = path.match(/^\/assets\/([A-Za-z0-9_.-]+\.(js|css))$/);
  const file = path === '/' ? join(root, 'apps/web/dist/index.html') : asset ? join(root, 'apps/web/dist/assets', asset[1]!) : null;
  if (!file) { response.writeHead(404).end(); return; }
  void readFile(file).then(bytes => response.writeHead(200, { 'Content-Type': path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' }).end(bytes)).catch(() => response.writeHead(404).end());
});
async function check(name: string, work: () => Promise<void>) { if (only && !name.includes(only)) return; try { await work(); checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); } catch (failure) { checks.push({ name, status: 'failed', error: failure instanceof Error ? failure.message : 'Unknown' }); throw failure; } }
async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(`Timed out: ${label}`); }
async function search(page: Page, query: string) {
  await page.getByRole('textbox', { name: 'Search mail', exact: true }).fill(query);
  const response = page.waitForResponse(r => { const url = new URL(r.url()); return r.request().method() === 'GET' && url.pathname.endsWith('/messages') && (url.searchParams.get('q') ?? '') === query.trim(); });
  await page.getByRole('button', { name: 'Search', exact: true }).click(); await response;
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await until(async () => await page.locator('.list-panel[aria-busy="false"]').count() > 0, 'search completed');
}
async function folder(page: Page, name: string) { await page.locator('.mail-folders').getByRole('button', { name, exact: true }).click(); await until(async () => await page.locator('.list-panel[aria-busy="false"]').count() > 0, 'folder loaded'); }
async function waitSaved(page: Page) { await until(async () => await page.locator('.composer-header [role=status]').textContent() === 'Saved', 'draft saved'); }
async function closeCompose(page: Page) { await page.getByRole('button', { name: 'Save and close composer' }).click(); await page.locator('.composer').waitFor({ state: 'detached' }); }
try {
  await mkdir(output, { recursive: true }); directory = await mkdtemp(join(output, 'fixture-'));
  await new Promise<void>(done => web.listen(0, '127.0.0.1', done)); const bound = web.address(); assert(bound && typeof bound === 'object'); origin = `http://127.0.0.1:${bound.port}`;
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12, connectionTimeoutMillis: 5000 }); await migrate(pool);
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const authConfig: AuthConfig = { issuer: 'https://identity.example.test', clientId: 'dreampost-everyday-qa', publicBaseUrl: origin, clientPrivateJwk: { ...privateKey, kid: 'qa' }, allowInsecureLocal: true };
  const users: Array<{ id: string; cookie: string; csrf: string }> = [];
  for (const username of ['alice', 'bob']) { const id = randomUUID(), cookie = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO principals(id,issuer,subject,username,display_name,app_role,access_enabled) VALUES($1::uuid,$2,$1::text,$3,$3,1,true)', [id, authConfig.issuer, username]);
    await pool.query(`INSERT INTO auth_sessions(token_hash,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at,client_id) VALUES($1,$2,$3,0,$4,'synthetic',now()+interval '2 hours',now()+interval '2 hours',now()+interval '1 day',$5)`, [createHash('sha256').update(cookie).digest('hex'), id, randomUUID(), csrf, authConfig.clientId]); users.push({ id, cookie, csrf }); }
  const alice = users[0]!, bob = users[1]!;
  await pool.query('UPDATE auth_settings SET last_catalog_sync=now(),catalog_issuer=$1,catalog_client_id=$2', [authConfig.issuer, authConfig.clientId]);
  const auth = new AuthService(pool, authConfig), addresses = new AddressService(pool, { defaultDomain: 'example.test', managedDomains: ['example.test'] }, (id, client) => auth.resolvePrincipal(id, client));
  const box = await addresses.provisionFirstMailbox(alice.id), other = await addresses.provisionFirstMailbox(bob.id);
  await pool.query("UPDATE address_policy_outbox SET status='applied',applied_at=now() WHERE status='pending'");
  await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])", [box.id, bob.id]);
  const fromId = (await addresses.listSendingIdentities(alice.id))[0]!.allocationId;
  const blobs = new FileBlobStore(join(directory, 'raw'));
  let order = 0;
  async function addMessage(subject: string, options: { reply?: string; hidden?: boolean; mailbox?: string; body?: string; html?: boolean; rawSubjectHeader?: string; ccHeader?: string } = {}) {
    const id = randomUUID(), mailboxId = options.mailbox ?? box.id;
    const bytes = Buffer.from([`Message-ID: <${id}@example.test>`, ...(options.reply ? [`References: <${options.reply}@example.test>`, `In-Reply-To: <${options.reply}@example.test>`] : []), 'From: Fixture Sender <sender@example.test>', 'Reply-To: Replies <reply@example.test>', `To: ${options.hidden ? 'List <list@example.test>' : 'Alice <alice@example.test>'}`, `Cc: ${options.ccHeader ?? 'Copy <copy@example.test>'}`, `Subject: ${options.rawSubjectHeader ?? subject}`, 'Date: Sun, 27 Sep 2026 10:00:00 +0000', 'MIME-Version: 1.0', `Content-Type: ${options.html ? 'text/html' : 'text/plain'}; charset=utf-8`, '', options.body ?? `Synthetic body for ${subject}.`, ''].join('\r\n'));
    const digest = createHash('sha256').update(bytes).digest('hex'); await blobs.put(digest, bytes); const parsed = await parseMimeIsolated(bytes); const client = await pool.connect();
    try { await client.query('BEGIN'); const received = new Date(Date.now() + order++ * 1000).toISOString();
      await client.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,parse_status,subject,from_header,to_header,plain_text,preview) VALUES($1,$2,$3,$4,$5,$6,'parsed',$7,$8,$9,$10,$11)`, [id, mailboxId, { version: 1, deliveryId: id, mailboxId, envelopeFrom: 'bounce@example.test', envelopeTo: mailboxId === box.id ? 'alice@example.test' : 'bob@example.test', receivedAt: received, rawSize: bytes.length }, digest, bytes.length, received, parsed.subject, parsed.from, parsed.to, parsed.text, parsed.preview]);
      await storeReaderData(client, id, parsed.reader); await initializeMessageState(client, { messageId: id, mailboxId }); await indexMessageThread(client, { mailboxId, messageId: id, messageIdHeader: parsed.reader.headers.messageId, references: parsed.reader.headers.references, inReplyTo: parsed.reader.headers.inReplyTo, parserVersion: parsed.reader.parserVersion }); await appendChange(client, mailboxId, id, 'message.received'); await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK'); throw failure; } finally { client.release(); }
    return id;
  }
  for (let i = 0; i < 52; i++) await addMessage(i === 51 ? 'Safe HTML fixture' : `Older fixture ${String(i).padStart(2, '0')}`, i === 51 ? { html: true, body: '<h2 id="everyday-safe-html">Safe synthetic HTML</h2><script>parent.__everydayLeak=true</script><img src="https://images.example.com/everyday-pixel.png"><p style="margin-top:1200px">Scroll marker</p>' } : {});
  const alpha = await addMessage('Trip planning'); const beta = await addMessage('Re: Trip planning', { reply: alpha });
  const hidden = await addMessage('List-only discussion', { hidden: true });
  const chinese = await addMessage('Invoice 中文测试', { body: 'Synthetic search body with 中文 and English invoice words.' });
  await addMessage('Private other mailbox', { mailbox: other.id });
  const outbound = { ...loadOutboundConfig({}), provider: 'cloudflare' as const, enabled: true, accountId: 'a'.repeat(32), apiToken: randomBytes(32).toString('hex'), maxMessageBytes: 1024 * 1024 };
  const config: ApiConfig = { databaseUrl, mailStorePath: join(directory, 'raw'), ingestKeys: { qa: randomBytes(32).toString('hex') }, devViewToken: randomBytes(32).toString('hex'), devMailboxId: box.id, host: '127.0.0.1', port: 0, publicBaseUrl: origin, auth: authConfig, addresses: { defaultDomain: 'example.test', managedDomains: ['example.test'] }, outbound };
  api = buildApp(config, pool, { blobs, outboundTransport: transport, authFetch: async () => { throw new Error('Identity-provider requests are forbidden in this fixture'); } }); apiOrigin = await api.listen({ host: '127.0.0.1', port: 0 });
  const jobService = new OutboundService(pool, outbound, { ...createOutboundDependencies(config, pool, auth, addresses, blobs), transport });
  browser = await chromium.launch({ headless: true, ...(process.env['PLAYWRIGHT_CHANNEL'] ? { channel: process.env['PLAYWRIGHT_CHANNEL'] } : {}), args: ['--disable-background-networking'] });
  async function browserContext(user: typeof alice) { const ctx = await browser!.newContext({ viewport: { width: 1440, height: 1000 } }); await ctx.addCookies([{ name: SESSION_COOKIE, value: user.cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]); await ctx.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); unexpected.push(new URL(route.request().url()).origin); return route.abort(); }); return ctx; }
  context = await browserContext(alice); const page = await context.newPage(); page.on('pageerror', e => consoleErrors.push(e.message)); page.on('dialog', dialog => void dialog.accept());
  await page.goto(origin); await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await check('Real SSO-cookie UI loads scoped paginated messages and CJK search', async () => { await until(async () => await page.locator('.mail-list-row').count() === 50, 'first page'); await page.getByRole('button', { name: 'Load more', exact: true }).click(); await until(async () => await page.locator('.mail-list-row').count() === 56, 'second page'); assert(!await page.getByText('Private other mailbox', { exact: true }).count()); await search(page, '中文'); await until(async () => await page.locator('.mail-list-row').count() === 1, 'CJK result'); assert((await page.locator('.mail-list-row').innerText()).includes('中文')); await search(page, ''); });
  for (const view of ['messages', 'threads'] as const) await check(`Automatic read in ${view} happens once per opening and preserves explicit unread`, async () => {
    const subject = `Read opening fixture ${view}`, id = await addMessage(subject);
    await folder(page, 'Inbox'); await page.getByLabel('Mail list layout', { exact: true }).selectOption(view); await search(page, subject);
    const mutations: Array<{ read: boolean; version: string; status?: number }> = [];
    let refreshDelay = true;
    const mutationPath = `${origin}/api/mailboxes/${box.id}/messages/mutate`;
    const threadPath = `${origin}/api/mailboxes/${box.id}/threads/*`;
    await page.route(mutationPath, async route => {
      const payload = route.request().postDataJSON();
      if (payload.items?.[0]?.id !== id || typeof payload.set?.read !== 'boolean') { await route.continue(); return; }
      const mutation: { read: boolean; version: string; status?: number } = { read: payload.set.read, version: payload.items[0].version }; mutations.push(mutation);
      const response = await route.fetch(); mutation.status = response.status();
      // Keep the first committed read acknowledgement behind an ordinary UI refresh.
      if (mutations.length === 1) await new Promise(done => setTimeout(done, 350));
      await route.fulfill({ response });
    });
    await page.route(threadPath, async route => {
      const response = await route.fetch();
      // Retain the old unread ThreadPane snapshot while the read acknowledgement causes renders.
      if (refreshDelay && mutations.length) await new Promise(done => setTimeout(done, 1000));
      await route.fulfill({ response });
    });
    const settled = async () => {
      await until(async () => await page.locator('.list-panel[aria-busy="false"]').count() > 0 && await page.locator('.thread-pane[aria-busy="false"]').count() > 0, 'read refresh settled');
      await page.waitForTimeout(1200);
    };
    const saveEvidence = (phase: string) => readOpeningEvidence.push({ view, phase, mutations: mutations.map(m => ({ ...m })) });
    try {
      await page.locator('.message-list .message-item').click();
      await until(() => mutations.length > 0, 'automatic read started');
      await page.getByRole('button', { name: 'Refresh mail', exact: true }).click();
      await settled(); saveEvidence('first opening with delayed acknowledgement and refresh');
      assert.equal(mutations.filter(m => m.read).length, 1, `${view}: opening and refresh must issue exactly one read`);
      assert.deepEqual(mutations.map(m => m.status), [200]); assert.equal(await page.locator('.list-error').count(), 0);
      refreshDelay = false;
      await page.getByRole('button', { name: 'Mark unread', exact: true }).click();
      await until(() => mutations.some(m => !m.read && m.status === 200), 'explicit unread saved');
      await page.getByRole('button', { name: 'Mark read', exact: true }).waitFor();
      await settled(); await page.getByRole('button', { name: 'Refresh mail', exact: true }).click(); await settled();
      saveEvidence('explicit unread persists while open');
      assert.deepEqual(mutations.map(m => m.read), [true, false]);
      assert.equal((await pool.query('SELECT is_read FROM principal_message_flags WHERE message_id=$1 AND principal_id=$2', [id, alice.id])).rows[0].is_read, false);
      // An explicit list selection is a new opening even when the same item remains selected.
      await page.locator('.message-list .message-item').click();
      await until(() => mutations.filter(m => m.read && m.status === 200).length === 2, 'explicit selection reads again'); await settled();
      await page.getByRole('button', { name: 'Mark unread', exact: true }).click();
      await page.getByRole('button', { name: 'Mark read', exact: true }).waitFor(); await settled();
      // Collapsing and expanding the message is another intentional opening.
      await page.locator('.thread-expand').click(); await page.locator('.thread-expand').click();
      await until(() => mutations.filter(m => m.read && m.status === 200).length === 3, 'expanded message reads again'); await settled();
      await page.getByRole('button', { name: 'Mark unread', exact: true }).click();
      await page.getByRole('button', { name: 'Mark read', exact: true }).waitFor(); await settled();
      await page.getByRole('button', { name: 'Back to list', exact: false }).click(); await page.locator('.message-list .message-item').click();
      await until(() => mutations.filter(m => m.read && m.status === 200).length === 4, 'closed and reopened reader reads again'); await settled();
      saveEvidence('explicit list selection, expansion and close/reopen each read once');
      assert.deepEqual(mutations.map(m => m.read), [true, false, true, false, true, false, true]);
      assert(mutations.every(m => m.status === 200)); assert.equal(await page.locator('.list-error').count(), 0);
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
    await search(page, ''); await page.getByLabel('Mail list layout', { exact: true }).selectOption('messages');
  });
  await check('Thread reader keeps real HTML sanitized, sandboxed and images blocked across refresh', async () => {
    await search(page, 'Safe HTML fixture'); await page.locator('.mail-list-row .message-item').click(); const isolated = page.frameLocator('.message-html-frame'); await isolated.locator('#everyday-safe-html').waitFor();
    assert.equal(await page.locator('#everyday-safe-html').count(), 0); assert.equal(await isolated.locator('script').count(), 0);
    assert.equal(await page.locator('.message-html-frame').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox'); assert(await page.getByRole('button', { name: 'Load images', exact: true }).isVisible());
    assert.equal(await page.evaluate(() => (window as unknown as Record<string, unknown>).__everydayLeak), undefined);
    assert.equal(await isolated.locator('body').evaluate(() => { try { void parent.document; return false; } catch { return true; } }), true);
    await isolated.locator('body').evaluate(() => { (window as unknown as Record<string, unknown>).__qaFrameMarker = 'preserved'; window.scrollTo(0, 200); });
    const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/messages') && r.request().method() === 'GET'); await page.getByRole('button', { name: 'Refresh mail', exact: true }).click(); await response;
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.equal(await isolated.locator('body').evaluate(() => (window as unknown as Record<string, unknown>).__qaFrameMarker), 'preserved'); assert.equal(unexpected.length, 0); await search(page, '');
  });
  await check('Personal read/star and shared archive undo call real atomic mutations', async () => { await search(page, 'Invoice'); const row = page.locator('.mail-list-row'); await row.getByRole('button', { name: 'Star Invoice 中文测试', exact: true }).click(); await until(async () => (await pool.query('SELECT is_starred FROM principal_message_flags WHERE message_id=$1 AND principal_id=$2', [chinese, alice.id])).rows[0]?.is_starred === true, 'star saved'); await row.locator('input[type=checkbox]').check(); await page.getByLabel('Move selected messages', { exact: true }).selectOption('archive'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await until(async () => (await pool.query('SELECT folder FROM mail_message_state WHERE message_id=$1', [chinese])).rows[0].folder === 'inbox', 'archive undone'); await search(page, ''); });
  await check('Labels create, apply, rename and remove without replacing message bytes', async () => { await page.getByRole('button', { name: 'Manage', exact: true }).click(); await page.getByLabel('New label', { exact: true }).fill('Trips'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await until(async () => await page.locator('.mail-labels').getByRole('button', { name: 'Trips', exact: false }).count() === 1, 'label created'); await search(page, 'Trip planning'); await page.getByLabel('Select loaded messages', { exact: true }).check(); const id = (await pool.query("SELECT id FROM mailbox_labels WHERE name='Trips'")).rows[0].id; await page.getByLabel('Label selected messages', { exact: true }).selectOption(id); await page.getByRole('button', { name: 'Add label', exact: true }).click(); await until(async () => Number((await pool.query('SELECT count(*) AS n FROM mail_message_labels WHERE label_id=$1', [id])).rows[0].n) === 2, 'label applied'); await page.locator('.label-manager').getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('Rename label', { exact: true }).fill('Travel'); await page.locator('.label-manager form').getByRole('button', { name: 'Rename', exact: true }).click(); await until(async () => (await pool.query('SELECT name FROM mailbox_labels WHERE id=$1', [id])).rows[0].name === 'Travel', 'renamed'); await page.getByRole('button', { name: 'Manage', exact: true }).click(); await search(page, ''); });
  await check('Conversation expansion uses exact message source and a blank separated reply', async () => { await search(page, 'Trip planning'); await page.getByLabel('Mail list layout', { exact: true }).selectOption('threads'); await until(async () => await page.locator('.message-list > li').count() === 1, 'thread grouping'); await page.locator('.message-list .message-item').click(); await page.getByRole('button', { name: 'Reply all', exact: true }).click(); await page.getByRole('region', { name: 'Compose message' }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), ''); assert.equal(await page.getByRole('button', { name: 'Show quoted message', exact: true }).getAttribute('aria-expanded'), 'false'); assert((await page.locator('.recipient-field').filter({ hasText: 'To' }).innerText()).includes('reply@example.test')); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('A fresh reply, separate from the original.'); await waitSaved(page); await page.getByRole('button', { name: 'Minimize composer', exact: true }).click(); await page.getByRole('button', { name: 'Restore composer', exact: true }).click(); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'A fresh reply, separate from the original.'); await page.getByRole('button', { name: 'Maximize composer', exact: true }).click(); await page.screenshot({ path: join(output, 'composer-expanded.png') }); await page.getByRole('button', { name: 'Restore composer size', exact: true }).click(); await closeCompose(page); });
  await check('Composer survives settings navigation and actual draft upload', async () => { await page.getByRole('button', { name: 'Compose', exact: true }).first().click(); await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Browser send fixture'); await page.getByRole('textbox', { name: 'To', exact: true }).fill('receiver@example.test'); await page.getByRole('textbox', { name: 'To', exact: true }).press('Enter'); await page.getByRole('textbox', { name: 'Bcc', exact: true }).fill('private@example.test'); await page.getByRole('textbox', { name: 'Bcc', exact: true }).press('Enter'); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Synthetic outgoing text.'); await page.getByRole('button', { name: 'Addresses', exact: true }).click(); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'Synthetic outgoing text.'); await page.getByRole('button', { name: 'Mail', exact: true }).click(); await page.locator('.composer input[type=file]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Generated attachment bytes only.') }); await until(async () => await page.locator('.compose-attachments').getByText('fixture.txt', { exact: true }).count() === 1, 'uploaded'); await waitSaved(page); });
  await check('Actual send freezes one draft, fake provider accepts bytes and a Sent copy appears', async () => { await page.getByLabel('From', { exact: true }).selectOption(fromId); await waitSaved(page); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.locator('.composer').waitFor({ state: 'detached' }); await until(async () => (await pool.query("SELECT count(*)::int n FROM outbound_submissions WHERE state='queued'")).rows[0].n === 1, 'durable queue'); assert.equal(providerCalls.length, 0); assert(await runOneOutboundJob(jobService)); assert(await runOneOutboundJob(jobService)); assert.equal(providerCalls.length, 1); assert.equal((await pool.query('SELECT sent_copy_state FROM outbound_submissions')).rows[0].sent_copy_state, 'done'); assert(providerCalls[0]!.bytes.toString().includes('Synthetic outgoing text.')); assert(!/^Bcc:/mi.test(providerCalls[0]!.bytes.toString())); assert(providerCalls[0]!.recipients.includes('private@example.test')); await folder(page, 'Sent'); await until(async () => await page.locator('.message-list').getByText('Browser send fixture', { exact: true }).count() === 1, 'Sent copy'); });
  await check('Outbox recovery creates a separate draft with attachments and a duplicate warning', async () => {
    await folder(page, 'Outbox'); await page.getByRole('button', { name: 'Edit as a new draft', exact: true }).click();
    await page.getByText('The earlier email may already have been sent.', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()); assert(await page.locator('.compose-attachments').getByText('fixture.txt', { exact: true }).count());
    await page.getByLabel('I understand this may send another copy.', { exact: true }).check(); await closeCompose(page); assert.equal(providerCalls.length, 1);
  });
  await check('Forward atomically includes generated ordinary attachments with an empty editor', async () => {
    const sent = (await pool.query("SELECT sent_message_id FROM outbound_submissions WHERE state='accepted' LIMIT 1")).rows[0].sent_message_id;
    await enqueueAttachmentExtraction(pool, sent); const staging = new FileAttachmentStagingStore(join(directory!, 'staging'));
    assert(await runOneAttachmentExtractionJob(pool, blobs, staging, { stageMaxBytes: 10 * 1024 * 1024, storageMaxBytes: 10 * 1024 * 1024 }));
    await folder(page, 'Sent'); await page.locator('.message-list .message-item').filter({ hasText: 'Browser send fixture' }).click(); await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await page.getByRole('region', { name: 'Compose message' }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), '');
    assert(await page.locator('.compose-attachments').getByText('fixture.txt', { exact: true }).count()); await closeCompose(page);
  });
  await check('Two tabs conflict without silently replacing local draft text', async () => { await folder(page, 'Drafts'); await page.locator('.draft-list .message-item').filter({ hasText: 'Trip planning' }).click(); const draftId = (await pool.query("SELECT id FROM outbound_drafts WHERE subject LIKE '%Trip planning%' AND state='editing' LIMIT 1")).rows[0]?.id; assert(draftId); const current = await loadDraftViaBrowser(page, box.id, draftId); await page.evaluate(async ({ box, id, version, csrf }) => { const response = await fetch(`/api/mailboxes/${box}/drafts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ expectedVersion: version, mutationKey: crypto.randomUUID(), bodyText: 'Changed by another tab' }) }); if (!response.ok) throw new Error(`Fixture external edit ${response.status}`); }, { box: box.id, id: draftId, version: current.version, csrf: alice.csrf }); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Keep my unsaved local version'); await page.getByText('This draft changed elsewhere.', { exact: true }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'Keep my unsaved local version'); await page.getByRole('button', { name: 'Save separate copy', exact: true }).click(); await waitSaved(page); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'Keep my unsaved local version'); await closeCompose(page); });
  await check('Non-visible recipient Reply all is disclosed and requires explicit acknowledgement', async () => { await folder(page, 'Inbox'); await page.getByLabel('Mail list layout', { exact: true }).selectOption('messages'); await search(page, 'List-only'); await page.locator('.mail-list-row .message-item').click(); await page.getByRole('button', { name: 'Reply all', exact: true }).click(); await page.getByText('Review Reply all recipients.', { exact: true }).waitFor(); assert(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()); await page.getByLabel('I reviewed the visible recipients and want to reply to them.', { exact: true }).check(); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Reviewed recipients.'); await waitSaved(page); await closeCompose(page); });
  await check('Reply to a specific visible person excludes other recipients', async () => {
    await folder(page, 'Inbox'); await search(page, 'Trip planning'); await page.locator('.mail-list-row .message-item').first().click();
    await page.getByRole('button', { name: 'Reply to a person', exact: true }).click(); await page.locator('.reply-people').getByRole('button', { name: 'Copy <copy@example.test>', exact: true }).click();
    await page.getByRole('region', { name: 'Compose message' }).waitFor(); const to = page.locator('.recipient-field').filter({ has: page.locator('label[for="compose-to"]') });
    assert((await to.innerText()).includes('copy@example.test')); assert(!(await to.innerText()).includes('reply@example.test')); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), ''); await closeCompose(page);
  });
  await check('Provider MIME limit failure preserves the draft without making a public link', async () => {
    await page.getByRole('button', { name: 'Compose', exact: true }).first().click(); await page.getByRole('textbox', { name: 'To', exact: true }).fill('size@example.test'); await page.getByRole('textbox', { name: 'To', exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Over-limit fixture'); await page.locator('.composer input[type=file]').setInputFiles({ name: 'oversize.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024, 65) });
    await page.locator('.compose-attachments').getByText('oversize.bin', { exact: true }).waitFor(); await waitSaved(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await until(async () => (await page.locator('.composer [role=alert]').innerText()).includes('size limit') || (await page.locator('.composer [role=alert]').innerText()).includes('exceeds'), 'size error');
    assert.equal(providerCalls.length, 1); assert(await page.locator('.composer').count()); assert.equal(await page.locator('.composer a[href^="http"]').count(), 0);
    await page.getByRole('button', { name: 'Remove attachment oversize.bin', exact: true }).click(); await page.locator('.compose-attachments').waitFor({ state: 'detached' }); await closeCompose(page);
  });
  await check('Live invalidation reaches the browser without foreground idle-renewal headers', async () => { await folder(page, 'Inbox'); await search(page, 'Live update fixture'); const before = requests.length; await addMessage('Live update fixture'); await until(async () => await page.locator('.mail-list-row').count() === 1, 'SSE invalidation', 12000); assert(requests.slice(before).some(r => r.path.endsWith('/messages') && r.background === '1')); });
  await check('Second identity sees shared history with independent read/star state', async () => { second = await browserContext(bob); const otherPage = await second.newPage(); await otherPage.goto(origin); await otherPage.getByRole('heading', { name: 'Inbox', exact: true }).waitFor(); await otherPage.getByLabel('Mailbox', { exact: true }).selectOption(box.id); await search(otherPage, 'Invoice'); assert(await otherPage.getByRole('button', { name: 'Star Invoice 中文测试', exact: true }).count()); assert.equal((await pool.query('SELECT is_starred FROM principal_message_flags WHERE message_id=$1 AND principal_id=$2', [chinese, bob.id])).rows[0]?.is_starred ?? false, false); assert.equal(await otherPage.getByRole('button', { name: 'Manage', exact: true }).count(), 0); await second.close(); second = undefined; });
  await check('Mobile layout preserves usable controls without outer horizontal overflow', async () => { await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Compose', exact: true }).click(); await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Mobile fixture'); await waitSaved(page); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await page.screenshot({ path: join(output, 'mobile-composer.png') }); await closeCompose(page); await page.setViewportSize({ width: 1440, height: 1000 }); });
  await check('An ineligible admitted From remains blank instead of switching identities', async () => {
    await pool.query('UPDATE address_allocations SET receive_only=true WHERE id=$1', [fromId]);
    await folder(page, 'Inbox'); await search(page, 'List-only'); await page.locator('.mail-list-row .message-item').click(); await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('region', { name: 'Compose message' }).waitFor(); assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), ''); assert(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled());
    await closeCompose(page); await pool.query('UPDATE address_allocations SET receive_only=false WHERE id=$1', [fromId]);
  });
  await check('An unadmitted queued send can be cancelled without another provider call', async () => {
    await page.getByRole('button', { name: 'Compose', exact: true }).first().click(); await page.getByRole('textbox', { name: 'To', exact: true }).fill('cancel@example.test'); await page.getByRole('textbox', { name: 'To', exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Cancellation fixture'); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Do not dispatch this generated message.'); await waitSaved(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.locator('.composer').waitFor({ state: 'detached' }); await page.getByRole('button', { name: 'Cancel queued send', exact: true }).click();
    await until(async () => (await pool.query("SELECT state FROM outbound_submissions WHERE snapshot->>'subject'='Cancellation fixture'")).rows[0]?.state === 'cancelled', 'cancelled queue'); assert.equal(providerCalls.length, 1);
  });
  await check('Autosave recovers a transient response with the same key and retains newer edits', async () => {
    await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
    const target = /\/api\/mailboxes\/[^/]+\/drafts\/[^/]+$/;
    const saves: Array<{ key: string; body: string; at: number }> = [];
    const routeSave = async (route: import('playwright').Route) => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const body = route.request().postDataJSON(); saves.push({ key: body.mutationKey, body: body.bodyText, at: Date.now() });
      if (saves.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Retry-After': '2' }, body: JSON.stringify({ error: 'temporarily_unavailable' }) });
      else await route.continue();
    };
    await page.route(target, routeSave);
    try {
      await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Autosave recovery fixture'); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Original edit');
      await until(() => saves.length === 1, 'first transient save'); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('New edit during recovery');
      await waitSaved(page); assert(saves.length >= 3); assert.equal(saves[0]!.key, saves[1]!.key); assert.equal(saves[0]!.body, saves[1]!.body); assert.notEqual(saves[1]!.key, saves[2]!.key);
      assert(saves[1]!.at - saves[0]!.at >= 1800); assert.equal(saves[2]!.body, 'New edit during recovery'); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'New edit during recovery');
    } finally { await page.unroute(target, routeSave); }
    await closeCompose(page);
  });
  await check('Autosave explains adjusted source fields and preserves recipient chips needing review', async () => {
    const sourceSubject = 'Seeded fields\t' + '\u00e9'.repeat(600);
    await addMessage('Seeded fields fixture', { rawSubjectHeader: `=?UTF-8?B?${Buffer.from(sourceSubject).toString('base64')}?=`, ccHeader: `${'N'.repeat(600)} <copy@example.test>, International <\u7528\u6237@example.test>` });
    await folder(page, 'Inbox'); await page.getByLabel('Mail list layout', { exact: true }).selectOption('messages'); await search(page, 'Seeded fields'); await page.locator('.mail-list-row .message-item').click();
    await page.getByRole('button', { name: 'Reply all', exact: true }).click(); await page.getByText('Some inherited subject or recipient-name characters were adjusted', { exact: false }).waitFor();
    await page.getByText('An inherited recipient address needs review.', { exact: false }).waitFor(); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('This reply saves despite inherited header issues.'); await waitSaved(page);
    assert(Buffer.byteLength(await page.getByRole('textbox', { name: 'Subject', exact: true }).inputValue()) <= 998);
    await page.getByRole('button', { name: 'Remove \u7528\u6237@example.test from Cc', exact: true }).click(); await waitSaved(page); await page.getByText('An inherited recipient address needs review.', { exact: false }).waitFor({ state: 'detached' });
    await closeCompose(page);
  });
  await check('A rejected UTF-8 subject can be corrected and a rejected unsaved draft can be discarded', async () => {
    await page.getByRole('button', { name: 'Compose', exact: true }).first().click(); await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('\u00e9'.repeat(500));
    await page.locator('.composer [role=alert]').waitFor(); await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Corrected subject'); await waitSaved(page);
    await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('\u00e9'.repeat(500)); await page.locator('.composer [role=alert]').waitFor(); await page.getByRole('button', { name: 'Discard', exact: true }).click(); await page.locator('.composer').waitFor({ state: 'detached' });
  });
  await check('Losing the final mailbox preserves a copyable draft while hiding revoked reader content', async () => {
    await page.getByRole('button', { name: 'Compose', exact: true }).first().click(); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Local text survives membership revocation');
    await pool.query('UPDATE mailbox_memberships SET revoked_at=now() WHERE principal_id=$1', [alice.id]); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('Your session or mailbox access is unavailable.', { exact: false }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'Local text survives membership revocation');
    assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).isDisabled(), false); assert.equal(await page.locator('.everyday-workspace:visible').count(), 0);
    await pool.query('UPDATE mailbox_memberships SET revoked_at=NULL WHERE principal_id=$1', [alice.id]); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => !await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'access restored'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await waitSaved(page); await closeCompose(page);
  });
  await check('A fresh authenticated session restarts a previously expired live stream', async () => {
    await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 minute',idle_expires_at=now()-interval '1 minute' WHERE principal_id=$1", [alice.id]);
    await until(async () => (await page.locator('.sidebar-footer').innerText()).includes('Access changed'), 'stream expired', 20000);
    const cookie = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO auth_sessions(token_hash,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at,client_id) VALUES($1,$2,$3,0,$4,'synthetic-renewed',now()+interval '2 hours',now()+interval '2 hours',now()+interval '1 day',$5)`, [createHash('sha256').update(cookie).digest('hex'), alice.id, randomUUID(), csrf, authConfig.clientId]);
    alice.cookie = cookie; alice.csrf = csrf; await context!.addCookies([{ name: SESSION_COOKIE, value: cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await page.locator('.sidebar-footer').innerText()).includes('Live updates'), 'fresh session stream');
  });
  await check('Missing everyday feature flag preserves the existing read-only inbox', async () => {
    const legacy = await browserContext(alice); await legacy.route(`${origin}/api/config`, async route => { const response = await route.fetch(); const config = await response.json(); delete config.everydayMail; await route.fulfill({ response, json: config }); });
    const legacyPage = await legacy.newPage(); await legacyPage.goto(origin); await legacyPage.getByText('Up to 100 most recent messages', { exact: true }).waitFor(); assert.equal(await legacyPage.getByRole('button', { name: 'Compose', exact: true }).count(), 0); await legacy.close();
  });
  await check('Expired source session retains local draft and disables new actions', async () => { await page.getByRole('button', { name: 'Compose', exact: true }).first().click(); await page.getByRole('textbox', { name: 'Message body', exact: true }).fill('Unsaved text must survive authentication expiry'); await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 minute',idle_expires_at=now()-interval '1 minute' WHERE principal_id=$1", [alice.id]); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await until(async () => await page.getByText('Your session or mailbox access is unavailable.', { exact: false }).count() > 0, 'expired composer'); assert.equal(await page.getByRole('textbox', { name: 'Message body', exact: true }).inputValue(), 'Unsaved text must survive authentication expiry'); assert(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()); });
  assert(checks.length > 0, 'EVERYDAY_QA_ONLY must match at least one check');
  assert.deepEqual(unexpected, []); assert.deepEqual(consoleErrors, []);
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, fixtureSchema: schema, selectedCheckName: only ?? null, readOpeningEvidence, browser: browser.version(), unexpectedRequests: unexpected, pageErrors: consoleErrors, providerCalls: providerCalls.length, scope: 'Synthetic SSO-cookie identities, isolated PostgreSQL, actual API and built browser UI, local file storage and fake provider. No live mail, SSO, R2 or external network.' }, null, 2));
} catch (failure) {
  console.error(failure instanceof Error ? failure.stack : failure);
  await mkdir(output, { recursive: true });
  await context?.pages()[0]?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', checks, fixtureSchema: schema, selectedCheckName: only ?? null, readOpeningEvidence, unexpectedRequests: unexpected, pageErrors: consoleErrors, error: failure instanceof Error ? failure.message : String(failure) }, null, 2)); process.exitCode = 1;
} finally {
  await second?.close().catch(() => {}); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  closeSse?.(); await new Promise<void>(done => web.close(() => done())); await api?.close(); await pool?.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
async function loadDraftViaBrowser(page: Page, box: string, id: string): Promise<{ version: number }> { return page.evaluate(async ({ box, id }) => { const response = await fetch(`/api/mailboxes/${box}/drafts/${id}`); const value = await response.json(); return value.draft; }, { box, id }); }
