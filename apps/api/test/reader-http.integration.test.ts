import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { Parser } from 'htmlparser2';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHeaders, INGEST_PATH, sha256Hex, type DeliveryMetadataV1 } from '@dreampost/protocol';
import { buildApp } from '../src/app.js';
import { FileBlobStore } from '../src/blob-store.js';
import type { ApiConfig } from '../src/config.js';
import { migrate, seedMailbox } from '../src/database.js';
import { runOneParseJob } from '../src/parser.js';
import { hashSecret } from '../src/auth/cookies.js';
import { SECURE_SESSION_COOKIE } from '../src/auth/types.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const origin = 'https://mail.example.com';
const issuer = 'https://identity.example.test';
const clientId = 'dreampost-reader-http-test';
const viewToken = 'reader-integration-development-token-32-bytes';
const key = { id: 'reader-test', secret: 'reader-ingest-test-secret-at-least-32-bytes' };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=';
const remoteImage = 'https://images.example.com/newsletter.png?receipt=synthetic';

// The forged transport/authentication headers must stay untrusted throughout this path.
const richMime = Buffer.from([
  'From: Sender <sender@example.test>', 'Reply-To: Support <reply@example.test>',
  'To: Shared reader <reader@example.test>', 'Cc: Observer <observer@example.test>',
  'Subject: Reader integration receipt', 'Date: Fri, 25 Sep 2026 16:30:00 +0000',
  'Message-ID: <reader-http-synthetic@example.test>',
  'Authentication-Results: claimed.cloudflare.example; spf=pass; dkim=pass; dmarc=pass',
  'Received: from untrusted.example by claimed.cloudflare.example with ESMTPS; Fri, 25 Sep 2026 16:30:00 +0000',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="outer-reader"', '',
  '--outer-reader', 'Content-Type: multipart/related; boundary="related-reader"', '',
  '--related-reader', 'Content-Type: multipart/alternative; boundary="alternative-reader"', '',
  '--alternative-reader', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
  'Plain text receipt \u4f60\u597d. Code 123456.',
  '--alternative-reader', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
  '<!doctype html><html><head><style>.receipt{color:#123456}</style></head><body>',
  '<!-- RAW_HTML_SENTINEL -->',
  '<table class="receipt"><tr><td>HTML receipt 123456</td></tr></table>',
  '<img src="cid:logo@example.test" alt="Inline logo">',
  `<img src="${remoteImage}" alt="External image">`,
  `<img src="${origin}/api/preferences" alt="Application endpoint">`,
  '<img src="http://images.example.com/insecure.png" alt="Insecure image">',
  '<script>window.READER_ATTACK_SENTINEL = true</script>',
  '<a href="https://links.example.com/receipt" target="_top" ping="https://links.example.com/ping">Receipt link</a>',
  '</body></html>', '--alternative-reader--',
  '--related-reader', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64',
  'Content-ID: <logo@example.test>', 'Content-Disposition: inline; filename="logo.png"', '', pixel,
  '--related-reader--', '--outer-reader', 'Content-Type: text/html; charset=utf-8',
  'Content-Disposition: attachment; filename="untrusted.html"', '',
  '<script>ATTACHMENT_HTML_SENTINEL</script>', '--outer-reader--', '',
].join('\r\n'), 'utf8');
const plainMime = Buffer.from('From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Plain message\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA plain message.\r\n');

interface User { id: string; cookie: string; csrf: string }
function resources(html: string) {
  const images: string[] = [];
  const links: Array<Record<string, string>> = [];
  const forbidden: string[] = [];
  const parser = new Parser({ onopentag(name, attrs) {
    if (name === 'img' && attrs.src) images.push(attrs.src);
    if (name === 'a' && attrs.href) links.push(attrs);
    if (['script', 'iframe', 'form', 'object', 'svg', 'math'].includes(name)) forbidden.push(name);
    for (const attr of Object.keys(attrs)) if (/^on/i.test(attr) || ['srcdoc', 'ping', 'srcset'].includes(attr)) forbidden.push(attr);
  } }, { decodeEntities: true });
  parser.end(html);
  return { images, links, forbidden };
}

// Each run creates/drops an isolated schema and a temporary raw store. No shared
// database migration, live SSO request, network resource fetch, or worker stub.
describe.skipIf(!databaseUrl)('reader HTTP with real ingestion, PostgreSQL, and isolated workers', () => {
  const schema = `dreampost_reader_http_${randomUUID().replaceAll('-', '')}`;
  const sharedMailboxId = randomUUID();
  const privateMailboxId = randomUUID();
  let admin: pg.Pool;
  let pool: pg.Pool;
  let directory: string;
  let store: FileBlobStore;
  let devApp: ReturnType<typeof buildApp>;
  let ssoApp: ReturnType<typeof buildApp>;
  let alice: User;
  let bob: User;
  let operator: User;
  let sharedMessageId: string;
  let privateMessageId: string;
  let plainMessageId: string;

  const path = (message = sharedMessageId, mailbox = sharedMailboxId) => `/api/mailboxes/${mailbox}/messages/${message}`;
  const devHeaders = () => ({ authorization: `Bearer ${viewToken}` });
  const sessionHeaders = (user: User) => ({ cookie: user.cookie });

  async function user(name: string, role: number): Promise<User> {
    const id = randomUUID();
    const sessionToken = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled) VALUES($1,$2,$3,$4,$5,true)',
      [id, issuer, randomUUID(), name, role]);
    await pool.query(`INSERT INTO auth_sessions(token_hash,client_id,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at)
      VALUES($1,$2,$3,$4,0,$5,'synthetic',now()+interval '1 hour',now()+interval '1 hour',now()+interval '1 day')`,
    [hashSecret(sessionToken), clientId, id, randomUUID(), csrf]);
    return { id, csrf, cookie: `${SECURE_SESSION_COOKIE}=${sessionToken}` };
  }

  async function receive(raw: Buffer, mailboxId: string, address: string): Promise<string> {
    const metadata: DeliveryMetadataV1 = {
      version: 1, deliveryId: randomUUID(), mailboxId, envelopeFrom: 'bounce@example.test',
      envelopeTo: address, receivedAt: '2026-09-26T12:00:00.000Z', rawSize: raw.length,
    };
    const response = await devApp.inject({ method: 'POST', url: INGEST_PATH,
      headers: await createDeliveryHeaders(metadata, raw, key), payload: raw });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1, deliveryId: metadata.deliveryId, sha256: await sha256Hex(raw), status: 'stored' });
    return metadata.deliveryId;
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    directory = await mkdtemp(join(tmpdir(), 'dreampost-reader-http-'));
    store = new FileBlobStore(directory);
    await seedMailbox(pool, { id: sharedMailboxId, address: 'reader@example.test', name: 'Shared reader fixture' });
    await seedMailbox(pool, { id: privateMailboxId, address: 'private@example.test', name: 'Private fixture' });
    const config: ApiConfig = {
      databaseUrl: databaseUrl!, mailStorePath: directory, ingestKeys: { [key.id]: key.secret },
      devViewToken: viewToken, devMailboxId: sharedMailboxId, host: '127.0.0.1', port: 3001, publicBaseUrl: origin,
    };
    devApp = buildApp(config, pool, { blobs: store });
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    ssoApp = buildApp({ ...config, auth: {
      issuer, clientId, publicBaseUrl: origin, clientPrivateJwk: { ...await exportJWK(pair.privateKey), kid: 'reader-rp-test' },
    } }, pool, { blobs: store, authFetch: async () => { throw new Error('Unexpected external SSO request in reader test'); } });
    alice = await user('reader-alice', 1);
    bob = await user('reader-bob', 1);
    operator = await user('reader-operator', 0);
    for (const [mailbox, actor] of [[sharedMailboxId, alice.id], [sharedMailboxId, bob.id], [privateMailboxId, bob.id]]) {
      await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])", [mailbox, actor]);
    }
    sharedMessageId = await receive(richMime, sharedMailboxId, 'reader@example.test');
    privateMessageId = await receive(richMime, privateMailboxId, 'private@example.test');
    plainMessageId = await receive(plainMime, sharedMailboxId, 'reader@example.test');
    for (let i = 0; i < 3; i++) expect(await runOneParseJob(pool, store)).toBe(true);
    expect(await runOneParseJob(pool, store)).toBe(false);
    expect((await pool.query('SELECT DISTINCT parse_status FROM deliveries')).rows).toEqual([{ parse_status: 'parsed' }]);
    expect((await pool.query('SELECT DISTINCT status FROM durable_jobs')).rows).toEqual([{ status: 'done' }]);
  });

  beforeEach(async () => {
    await pool.query('UPDATE deliveries SET deleted_at = NULL');
    await pool.query('UPDATE mailboxes SET enabled = true');
    await pool.query("UPDATE mailbox_memberships SET revoked_at = NULL, permissions = ARRAY['read']");
    await pool.query('TRUNCATE principal_preferences');
  });

  afterAll(async () => {
    if (devApp) await devApp.close();
    if (ssoApp) await ssoApp.close();
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('rechecks a background HTML render without renewing the source idle deadline', async () => {
    await pool.query("UPDATE auth_sessions SET idle_expires_at=now()+interval '2 minutes' WHERE principal_id=$1", [alice.id]);
    const deadline = async () => (await pool.query<{ value: string }>("SELECT idle_expires_at::text AS value FROM auth_sessions WHERE principal_id=$1", [alice.id])).rows[0]!.value;
    const before = await deadline();
    const quiet = await ssoApp.inject({ url: `${path()}/render`, headers: { ...sessionHeaders(alice), 'x-dreampost-background': '1' } });
    expect(quiet.statusCode).toBe(200);
    expect(await deadline()).toBe(before);
    const foreground = await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(alice) });
    expect(foreground.statusCode).toBe(200);
    expect(Date.parse(await deadline())).toBeGreaterThan(Date.parse(before));
  });

  it('exposes useful parsed details without raw HTML, inline bytes, or forged authentication evidence', async () => {
    const response = await devApp.inject({ url: path(), headers: devHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { message } = response.json();
    expect(message.subject).toBe('Reader integration receipt');
    expect(message.text).toContain('Plain text receipt \u4f60\u597d. Code 123456.');
    expect(message.reader).toMatchObject({ hasHtml: true, replyTo: 'Support <reply@example.test>',
      cc: 'Observer <observer@example.test>', sentAt: '2026-09-25T16:30:00.000Z',
      envelopeFrom: 'bounce@example.test', envelopeTo: 'reader@example.test' });
    for (const key of ['html', 'htmlSource', 'inlineCandidates', 'authentication', 'tls', 'spf', 'dkim', 'dmarc', 'mailedBy', 'signedBy']) {
      expect(message).not.toHaveProperty(key);
      expect(message.reader).not.toHaveProperty(key);
    }
    for (const hidden of ['RAW_HTML_SENTINEL', 'READER_ATTACK_SENTINEL', 'ATTACHMENT_HTML_SENTINEL', pixel, 'claimed.cloudflare.example']) expect(response.body).not.toContain(hidden);
    const derived = await pool.query('SELECT html_source,inline_candidates FROM message_reader_data WHERE delivery_id=$1', [sharedMessageId]);
    expect(derived.rows[0].html_source).toContain('RAW_HTML_SENTINEL');
    expect(derived.rows[0].inline_candidates).toHaveLength(1);
    const raw = await devApp.inject({ url: `${path()}/raw`, headers: devHeaders() });
    expect(raw.rawPayload).toEqual(richMime);
  });

  it('defaults rendering to blocked external images while allowing the validated MIME CID image', async () => {
    const response = await devApp.inject({ url: `${path()}/render`, headers: devHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const result = response.json();
    expect(result.remoteImageCount).toBe(1);
    expect(result.html).toContain('HTML receipt 123456');
    const view = resources(result.html);
    expect(view.images).toEqual([`data:image/png;base64,${pixel}`]);
    expect(view.forbidden).toEqual([]);
    expect(view.links).toHaveLength(1);
    expect(view.links[0]).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' });
    expect(result.html).not.toContain('RAW_HTML_SENTINEL');
    expect(result.html).not.toContain('ATTACHMENT_HTML_SENTINEL');
  });

  it('permits only the intended public HTTPS image when explicitly requested and does not persist that mode', async () => {
    const allowed = await devApp.inject({ url: `${path()}/render?remoteImages=allowed`, headers: devHeaders() });
    expect(allowed.statusCode).toBe(200);
    expect(resources(allowed.json().html).images).toEqual([`data:image/png;base64,${pixel}`, remoteImage]);
    expect(resources(allowed.json().html).forbidden).toEqual([]);
    const next = await devApp.inject({ url: `${path()}/render`, headers: devHeaders() });
    expect(next.statusCode).toBe(200);
    expect(resources(next.json().html).images).toEqual([`data:image/png;base64,${pixel}`]);
  });

  it('keeps plain-text mail readable and returns a specific unavailable result for its HTML view', async () => {
    const detail = await devApp.inject({ url: path(plainMessageId), headers: devHeaders() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().message.text).toContain('A plain message.');
    expect(detail.json().message.reader.hasHtml).toBe(false);
    const rendered = await devApp.inject({ url: `${path(plainMessageId)}/render`, headers: devHeaders() });
    expect(rendered.statusCode).toBe(404);
    expect(rendered.json()).toEqual({ error: 'html_unavailable' });
  });

  it('requires the correct authentication mode and message mailbox for rendering', async () => {
    expect((await devApp.inject({ url: `${path()}/render` })).statusCode).toBe(401);
    expect((await ssoApp.inject({ url: `${path()}/render` })).statusCode).toBe(401);
    expect((await ssoApp.inject({ url: `${path()}/render`, headers: devHeaders() })).statusCode).toBe(401);
    expect((await devApp.inject({ url: `${path(privateMessageId, privateMailboxId)}/render`, headers: devHeaders() })).statusCode).toBe(404);
    expect((await devApp.inject({ url: `${path(privateMessageId)}/render`, headers: devHeaders() })).statusCode).toBe(404);
  });

  it('enforces real SSO mailbox membership without giving the operator access to message bodies', async () => {
    expect((await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(alice) })).statusCode).toBe(200);
    expect((await ssoApp.inject({ url: `${path(privateMessageId, privateMailboxId)}/render`, headers: sessionHeaders(alice) })).statusCode).toBe(404);
    expect((await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(operator) })).statusCode).toBe(404);
    expect((await ssoApp.inject({ url: `${path(privateMessageId, privateMailboxId)}/render`, headers: sessionHeaders(bob) })).statusCode).toBe(200);
  });

  it('applies a shared-mailbox membership revocation to an existing SSO session', async () => {
    const before = await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(bob) });
    expect(before.statusCode).toBe(200);
    await pool.query('UPDATE mailbox_memberships SET revoked_at=now() WHERE mailbox_id=$1 AND principal_id=$2', [sharedMailboxId, bob.id]);
    const after = await ssoApp.inject({ url: `${path()}/render?remoteImages=allowed`, headers: sessionHeaders(bob) });
    expect(after.statusCode).toBe(404);
    expect(after.body).not.toContain('HTML receipt');
    expect((await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(alice) })).statusCode).toBe(200);
  });

  it('does not substitute manage permission or a disabled mailbox for readable membership', async () => {
    await pool.query("UPDATE mailbox_memberships SET permissions=ARRAY['manage'] WHERE mailbox_id=$1 AND principal_id=$2", [sharedMailboxId, alice.id]);
    expect((await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(alice) })).statusCode).toBe(404);
    await pool.query('UPDATE mailboxes SET enabled=false WHERE id=$1', [sharedMailboxId]);
    expect((await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(bob) })).statusCode).toBe(404);
    expect((await devApp.inject({ url: `${path()}/render`, headers: devHeaders() })).statusCode).toBe(404);
  });

  it('keeps shared-mailbox image preferences personal and the render default blocked', async () => {
    const initial = await ssoApp.inject({ url: '/api/preferences', headers: sessionHeaders(alice) });
    expect(initial.json()).toEqual({ autoLoadExternalImages: false });
    const saved = await ssoApp.inject({ method: 'PATCH', url: '/api/preferences',
      headers: { ...sessionHeaders(alice), origin, 'x-csrf-token': alice.csrf }, payload: { autoLoadExternalImages: true } });
    expect(saved.statusCode).toBe(200);
    expect((await ssoApp.inject({ url: '/api/preferences', headers: sessionHeaders(alice) })).json()).toEqual({ autoLoadExternalImages: true });
    expect((await ssoApp.inject({ url: '/api/preferences', headers: sessionHeaders(bob) })).json()).toEqual({ autoLoadExternalImages: false });
    const aliceDefault = await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(alice) });
    const bobDefault = await ssoApp.inject({ url: `${path()}/render`, headers: sessionHeaders(bob) });
    expect(resources(aliceDefault.json().html).images).toEqual([`data:image/png;base64,${pixel}`]);
    expect(resources(bobDefault.json().html).images).toEqual([`data:image/png;base64,${pixel}`]);
    const explicit = await ssoApp.inject({ url: `${path()}/render?remoteImages=allowed`, headers: sessionHeaders(alice) });
    expect(resources(explicit.json().html).images).toContain(remoteImage);
    expect((await pool.query('SELECT principal_id FROM principal_preferences')).rows).toEqual([{ principal_id: alice.id }]);
  });

  it('hides a deleted message from details, rendering, and raw access while retaining its durable bytes', async () => {
    await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1', [sharedMessageId]);
    for (const suffix of ['', '/render', '/raw']) {
      expect((await devApp.inject({ url: `${path()}${suffix}`, headers: devHeaders() })).statusCode).toBe(404);
      expect((await ssoApp.inject({ url: `${path()}${suffix}`, headers: sessionHeaders(alice) })).statusCode).toBe(404);
    }
    expect(await store.get(await sha256Hex(richMime))).toEqual(richMime);
  });

  it.each([
    '?remoteImages=allowed&remoteImages=blocked', '?remoteImages[]=allowed', '?remoteImages=true',
    '?remoteImages=ALLOWED', '?remoteImages=', '?unexpected=allowed', '?remoteImages=allowed&extra=1',
  ])('rejects ambiguous or unexpected render query parameters: %s', async (query) => {
    const response = await devApp.inject({ url: `${path()}/render${query}`, headers: devHeaders() });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_image_mode' });
  });
});
