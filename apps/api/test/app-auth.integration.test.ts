import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@dreampost/protocol';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import type { RawBlobStore } from '../src/blob-store.js';
import { hashSecret } from '../src/auth/cookies.js';
import { SECURE_SESSION_COOKIE } from '../src/auth/types.js';
import { AuthService } from '../src/auth/service.js';
import { migrate } from '../src/database.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const issuer = 'https://identity.example.test';
const origin = 'https://mail.example.test';
const clientId = 'dreampost-app-test';
const devToken = 'development-token-must-not-work-in-sso-mode';
interface TestUser { id: string; subject: string; cookie: string; csrf: string; sid: string; }

// Most cases use persisted sessions; mock-issuer login cases also exercise the actual buildApp provisioning hook.
describe.skipIf(!databaseUrl)('application SSO and mailbox authorization with PostgreSQL', () => {
  const schema = `dreampost_app_auth_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let config: ApiConfig;
  let alice: TestUser;
  let bob: TestUser;
  let postmaster: TestUser;
  let aliceMailbox: string;
  let bobMailbox: string;
  let sharedMailbox: string;
  let aliceMessage: string;
  let bobMessage: string;
  let sharedMessage: string;
  let blobReads = 0;
  const raw = Buffer.from('From: sender@example.test\r\nSubject: Private message\r\n\r\nPrivate body.\r\n');
  const store: RawBlobStore = { put: async () => {}, get: async () => { blobReads++; return raw; } };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    const key = await generateKeyPair('EdDSA', { extractable: true });
    config = { databaseUrl: databaseUrl!, mailStorePath: '/unused-auth-test-store',
      ingestKeys: { test: 'inbound-machine-secret-at-least-32-bytes' }, devViewToken: devToken,
      devMailboxId: randomUUID(), host: '127.0.0.1', port: 3001, publicBaseUrl: origin,
      auth: { issuer, clientId, publicBaseUrl: origin, clientPrivateJwk: { ...await exportJWK(key.privateKey), kid: 'test-rp-key' } },
      addresses: { defaultDomain: 'example.test', managedDomains: ['example.test'] } };
  });

  async function user(username: string, roleId: number): Promise<TestUser> {
    const id = randomUUID();
    const subject = randomUUID();
    const sid = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO principals (id, issuer, subject, username, app_role, access_enabled) VALUES ($1,$2,$3,$4,$5,true)', [id, issuer, subject, username, roleId]);
    await pool.query(`INSERT INTO auth_sessions (token_hash, client_id, principal_id, sso_sid, auth_version, csrf_token, id_token_hint, expires_at, idle_expires_at, next_activity_at)
      VALUES ($1,$2,$3,$4,0,$5,'unused-test-hint',now() + interval '1 hour',now() + interval '1 hour',now() + interval '1 day')`,
    [hashSecret(token), clientId, id, sid, csrf]);
    return { id, subject, sid, cookie: `${SECURE_SESSION_COOKIE}=${token}`, csrf };
  }

  async function mailbox(address: string, owner?: TestUser): Promise<{ id: string; messageId: string }> {
    const id = randomUUID();
    const allocation = randomUUID();
    const messageId = randomUUID();
    await pool.query('INSERT INTO mailboxes (id,address,name,mailbox_type,owner_principal_id) VALUES ($1,$2,$3,$4,$5)', [id, address, address, owner ? 'personal' : 'shared', owner?.id ?? null]);
    if (owner) await pool.query("INSERT INTO mailbox_memberships (mailbox_id,principal_id,permissions) VALUES ($1,$2,ARRAY['read','send_as','manage'])", [id, owner.id]);
    await pool.query("INSERT INTO address_registry (address,domain,state) VALUES ($1,'example.test','allocated')", [address]);
    await pool.query("INSERT INTO address_allocations (id,address,mailbox_id,source) VALUES ($1,$2,$3,'manual')", [allocation, address, id]);
    await pool.query('UPDATE address_registry SET current_allocation_id = $2 WHERE address = $1', [address, allocation]);
    const metadata = { version: 1, deliveryId: messageId, mailboxId: id, envelopeFrom: 'sender@example.test', envelopeTo: address, receivedAt: new Date().toISOString(), rawSize: raw.length };
    await pool.query(`INSERT INTO deliveries (id,mailbox_id,metadata,sha256,raw_size,received_at,parse_status,subject,plain_text)
      VALUES ($1,$2,$3,$4,$5,now(),'parsed','Private message','Private body.')`, [messageId, id, metadata, await sha256Hex(raw), raw.length]);
    return { id, messageId };
  }

  beforeEach(async () => {
    if (app) await app.close();
    await pool.query('TRUNCATE principals, mailboxes CASCADE');
    await pool.query('TRUNCATE auth_revoked_sids, auth_catalog_publications');
    await pool.query('UPDATE auth_settings SET last_catalog_sync = NULL');
    alice = await user('alice', 1);
    bob = await user('bob', 1);
    postmaster = await user('postmaster-operator', 0);
    const first = await mailbox('alice@example.test', alice);
    const second = await mailbox('bob@example.test', bob);
    const shared = await mailbox('shared@example.test');
    aliceMailbox = first.id; aliceMessage = first.messageId;
    bobMailbox = second.id; bobMessage = second.messageId;
    sharedMailbox = shared.id; sharedMessage = shared.messageId;
    await pool.query("INSERT INTO mailbox_memberships (mailbox_id,principal_id,permissions) VALUES ($1,$2,ARRAY['read'])", [sharedMailbox, alice.id]);
    blobReads = 0;
    app = buildApp(config, pool, { blobs: store });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  const headers = (actor: TestUser) => ({ cookie: actor.cookie });

  async function browserLogin(subject: string, username: string, roleId: number) {
    const keys = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'mock-issuer-key' };
    const rpPrivate = config.auth!.clientPrivateJwk;
    const rpPublic = { kty: rpPrivate.kty, crv: rpPrivate.crv, x: rpPrivate.x, kid: rpPrivate.kid };
    let nonce = '';
    let challenge = '';
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === `${issuer}/jwks`) return Response.json({ keys: [publicJwk] });
      const body = new URLSearchParams(init?.body as URLSearchParams);
      if (url === `${issuer}/backchannel/events`) {
        await jwtVerify(body.get('event_token')!, await importJWK(rpPublic, 'EdDSA'), {
          issuer: clientId, subject: clientId, audience: issuer, typ: 'events+jwt',
        });
        return new Response(null, { status: 204 });
      }
      if (url === `${issuer}/token`) {
        await jwtVerify(body.get('client_assertion')!, await importJWK(rpPublic, 'EdDSA'), {
          issuer: clientId, subject: clientId, audience: issuer,
        });
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({ sub: subject, nonce, preferred_username: username, app_role: roleId,
          sid: randomUUID(), sess_exp: now + 3600, sess_persistent: true })
          .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' }).setIssuer(issuer)
          .setAudience(clientId).setIssuedAt(now).setExpirationTime(now + 600).sign(keys.privateKey);
        return Response.json({ id_token: token });
      }
      throw new Error('Unexpected mock issuer request');
    };
    await app.close();
    app = buildApp(config, pool, { blobs: store, authFetch: fetcher });
    await new AuthService(pool, config.auth!, { fetch: fetcher }).publishRoleCatalog();
    const started = await app.inject({ url: '/auth/login' });
    expect(started.statusCode).toBe(302);
    const location = new URL(String(started.headers.location));
    nonce = location.searchParams.get('nonce')!;
    challenge = location.searchParams.get('code_challenge')!;
    const values = started.headers['set-cookie'];
    const flow = (Array.isArray(values) ? values[0]! : String(values)).split(';')[0]!;
    const response = await app.inject({ url: `/auth/callback?state=${location.searchParams.get('state')}&code=mock-code`, headers: { cookie: flow } });
    expect(response.statusCode).toBe(302);
    const returned = response.headers['set-cookie'];
    const cookie = (Array.isArray(returned) ? returned : [String(returned)]).find((value) => value.startsWith(`${SECURE_SESSION_COOKIE}=`))!.split(';')[0]!;
    return { cookie, session: (await app.inject({ url: '/auth/session', headers: { cookie } })).json() };
  }

  it('completes actual RP login for an admin denied mailbox.use without running mailbox provisioning', async () => {
    await pool.query("INSERT INTO auth_user_permission_overrides (principal_id,permission,effect) VALUES ($1,'mailbox.use','deny')", [postmaster.id]);
    const current = await browserLogin(postmaster.subject, 'postmaster-operator', 0);
    expect(current.session.actor.principalId).toBe(postmaster.id);
    expect(current.session.actor.permissions).toContain('addresses.manage');
    expect(current.session.actor.permissions).not.toContain('mailbox.use');
    expect((await app.inject({ url: '/api/admin/addresses', headers: { cookie: current.cookie } })).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*) AS count FROM mailboxes WHERE owner_principal_id = $1', [postmaster.id])).rows[0].count).toBe('0');
  });

  it('keeps a validated login usable when its automatic mailbox transaction fails', async () => {
    await pool.query("ALTER TABLE mailboxes ADD CONSTRAINT test_block_provisioning CHECK (mailbox_type <> 'personal') NOT VALID");
    try {
      const subject = randomUUID();
      const current = await browserLogin(subject, 'new-user', 1);
      expect(current.session.actor.subject).toBe(subject);
      expect(current.session.actor.permissions).toContain('mailbox.use');
      expect((await pool.query('SELECT count(*) AS count FROM mailboxes WHERE owner_principal_id = $1', [current.session.actor.principalId])).rows[0].count).toBe('0');
      expect((await app.inject({ url: '/api/mailboxes', headers: { cookie: current.cookie } })).statusCode).toBe(200);
    } finally { await pool.query('ALTER TABLE mailboxes DROP CONSTRAINT test_block_provisioning'); }
  });

  it('exposes only authentication mode publicly and rejects the development bearer in SSO mode', async () => {
    const mode = await app.inject({ url: '/api/config' });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toEqual({ authentication: 'sso' });
    expect(mode.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/api/mailboxes', headers: { authorization: `Bearer ${devToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/addresses', headers: { authorization: `Bearer ${devToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/mailboxes' })).statusCode).toBe(401);
  });

  it('lists only readable memberships and denies cross-user message lists, details, and raw bytes', async () => {
    const first = (await app.inject({ url: '/api/mailboxes', headers: headers(alice) })).json();
    const second = (await app.inject({ url: '/api/mailboxes', headers: headers(bob) })).json();
    expect(first.mailboxes.map((box: { id: string }) => box.id).sort()).toEqual([aliceMailbox, sharedMailbox].sort());
    expect(second.mailboxes.map((box: { id: string }) => box.id)).toEqual([bobMailbox]);
    for (const [actor, deniedMailbox, deniedMessage] of [[alice, bobMailbox, bobMessage], [bob, aliceMailbox, aliceMessage]] as const) {
      for (const suffix of ['', `/${deniedMessage}`, `/${deniedMessage}/raw`]) {
        expect((await app.inject({ url: `/api/mailboxes/${deniedMailbox}/messages${suffix}`, headers: headers(actor) })).statusCode).toBe(404);
      }
    }
    expect(blobReads).toBe(0);
    expect((await app.inject({ url: `/api/mailboxes/${aliceMailbox}/messages/${bobMessage}`, headers: headers(alice) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/mailboxes/${aliceMailbox}/messages/${aliceMessage}`, headers: headers(alice) })).json().message.text).toBe('Private body.');
    const download = await app.inject({ url: `/api/mailboxes/${aliceMailbox}/messages/${aliceMessage}/raw`, headers: headers(alice) });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(raw);
    expect(blobReads).toBe(1);
  });

  it('applies shared-mailbox membership grants and revocations without re-login', async () => {
    const path = `/api/mailboxes/${sharedMailbox}/messages/${sharedMessage}/raw`;
    expect((await app.inject({ url: path, headers: headers(bob) })).statusCode).toBe(404);
    await pool.query("INSERT INTO mailbox_memberships (mailbox_id,principal_id,permissions) VALUES ($1,$2,ARRAY['read'])", [sharedMailbox, bob.id]);
    expect((await app.inject({ url: path, headers: headers(bob) })).statusCode).toBe(200);
    await pool.query('UPDATE mailbox_memberships SET revoked_at = now() WHERE mailbox_id = $1 AND principal_id = $2', [sharedMailbox, bob.id]);
    expect((await app.inject({ url: path, headers: headers(bob) })).statusCode).toBe(404);
    expect(blobReads).toBe(1);
    expect((await app.inject({ url: path, headers: headers(alice) })).statusCode).toBe(200);
  });

  it('does not turn postmaster address administration into permission to read private mail', async () => {
    expect((await app.inject({ url: '/api/admin/addresses', headers: headers(postmaster) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/mailboxes', headers: headers(postmaster) })).json()).toEqual({ mailboxes: [] });
    expect((await app.inject({ url: `/api/mailboxes/${aliceMailbox}/messages/${aliceMessage}/raw`, headers: headers(postmaster) })).statusCode).toBe(404);
    expect(blobReads).toBe(0);
  });

  it('allows admin access without granting mailbox.use or private mailbox access', async () => {
    await pool.query("INSERT INTO auth_user_permission_overrides (principal_id,permission,effect) VALUES ($1,'mailbox.use','deny')", [postmaster.id]);
    const session = (await app.inject({ url: '/auth/session', headers: headers(postmaster) })).json();
    expect(session.actor.principalId).toBe(postmaster.id);
    expect(session.actor.permissions).toContain('addresses.manage');
    expect(session.actor.permissions).not.toContain('mailbox.use');
    expect((await app.inject({ url: '/api/admin/addresses', headers: headers(postmaster) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/mailboxes', headers: headers(postmaster) })).statusCode).toBe(403);
    expect(blobReads).toBe(0);
  });

  it('requires Origin and CSRF on real address mutation routes', async () => {
    const payload = { address: 'alice-alias@example.test' };
    expect((await app.inject({ method: 'POST', url: '/api/address-requests', headers: headers(alice), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/address-requests', headers: { ...headers(alice), origin }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/address-requests', headers: { ...headers(alice), origin: 'https://untrusted.example.test', 'x-csrf-token': alice.csrf }, payload })).statusCode).toBe(403);
    expect((await pool.query('SELECT count(*) AS count FROM address_requests')).rows[0].count).toBe('0');
    const accepted = await app.inject({ method: 'POST', url: '/api/address-requests', headers: { ...headers(alice), origin, 'x-csrf-token': alice.csrf }, payload });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().request.status).toBe('pending');
  });

  it('enforces persisted SSO sid revocation and disabled admission before reading raw mail', async () => {
    await pool.query('INSERT INTO auth_revoked_sids (issuer,sid) VALUES ($1,$2)', [issuer, alice.sid]);
    expect((await app.inject({ url: `/api/mailboxes/${aliceMailbox}/messages/${aliceMessage}/raw`, headers: headers(alice) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/mailboxes', headers: headers(bob) })).statusCode).toBe(200);
    await pool.query('UPDATE principals SET access_enabled = false, auth_version = auth_version + 1 WHERE id = $1', [bob.id]);
    expect((await app.inject({ url: `/api/mailboxes/${bobMailbox}/messages/${bobMessage}/raw`, headers: headers(bob) })).statusCode).toBe(401);
    expect(blobReads).toBe(0);
  });
});
