import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import pg from 'pg';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/database.js';
import { ApiError } from '../src/errors.js';
import { registerAuthRoutes, AuthService, type Actor, type AuthConfig } from '../src/auth/index.js';
import { SESSION_COOKIE, SECURE_SESSION_COOKIE } from '../src/auth/types.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const issuer = 'https://identity.example.test';
const origin = 'https://mail.example.test';
const clientId = 'dreampost-test';
const alice = { sub: '11111111-1111-4111-8111-111111111111', username: 'alice', role: 1 };
const bob = { sub: '22222222-2222-4222-8222-222222222222', username: 'bob', role: 2 };
type Identity = typeof alice;
type Flow = { state: string; code: string; cookie: string; sid: string };

class MockIssuer {
  codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown> }>();
  tokenExchanges = 0;
  published: unknown[] = [];
  failPublication = false;
  private clockOffset = 0;
  get now() { return Date.now() + this.clockOffset; }
  set now(value: number) { this.clockOffset = value - Date.now(); }
  constructor(readonly issuerPrivateJwk: JWK, readonly issuerPublicJwk: JWK, readonly clientPublicJwk: JWK) {}

  async signed(payload: Record<string, unknown>, options: { typ?: string; aud?: string; iss?: string; iat?: number } = {}) {
    const now = Math.floor(this.now / 1000);
    return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid: this.issuerPublicJwk.kid, typ: options.typ ?? 'JWT' })
      .setIssuer(options.iss ?? issuer).setAudience(options.aud ?? clientId).setIssuedAt(options.iat ?? now)
      .setExpirationTime(now + 600).setJti(randomUUID()).sign(await importJWK(this.issuerPrivateJwk, 'EdDSA'));
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${issuer}/jwks`) return Response.json({ keys: [this.issuerPublicJwk] });
    if (url === `${issuer}/token`) {
      this.tokenExchanges++;
      const body = new URLSearchParams(init?.body as URLSearchParams);
      const assertion = body.get('client_assertion')!;
      await jwtVerify(assertion, await importJWK(this.clientPublicJwk, 'EdDSA'), {
        issuer: clientId, subject: clientId, audience: issuer, algorithms: ['EdDSA'], currentDate: new Date(this.now),
      });
      expect(body.get('redirect_uri')).toBe(`${origin}/auth/callback`);
      expect(body.get('grant_type')).toBe('authorization_code');
      const code = body.get('code')!;
      const flow = this.codes.get(code);
      this.codes.delete(code);
      if (!flow || createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== flow.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const claims = { nonce: flow.nonce, ...flow.claims };
      const { token_aud, token_iss, token_typ, token_iat, ...payload } = claims;
      return Response.json({ id_token: await this.signed(payload, {
        aud: token_aud as string | undefined, iss: token_iss as string | undefined,
        typ: token_typ as string | undefined, iat: token_iat as number | undefined,
      }) });
    }
    if (url === `${issuer}/backchannel/events`) {
      const body = new URLSearchParams(init?.body as URLSearchParams);
      const verified = await jwtVerify(body.get('event_token')!, await importJWK(this.clientPublicJwk, 'EdDSA'), {
        issuer: clientId, subject: clientId, audience: issuer, algorithms: ['EdDSA'], typ: 'events+jwt', currentDate: new Date(this.now),
      });
      this.published.push(verified.payload.events);
      return new Response(null, { status: this.failPublication ? 503 : 204 });
    }
    if (url === `${issuer}/internal/session-activity`) return new Response(null, { status: 204 });
    throw new Error('Unexpected mock issuer endpoint');
  };
}

function cookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
}

// No real issuer calls: cryptographic OIDC/event checks use local generated keys and a mock fetch transport.
describe.skipIf(!databaseUrl)('DreamSSO authentication with real PostgreSQL', () => {
  const schema = `dreampost_auth_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let auth: AuthService;
  let mock: MockIssuer;
  let config: AuthConfig;
  let issuerPrivate: JWK;
  let issuerPublic: JWK;
  let clientPrivate: JWK;
  let clientPublic: JWK;
  let provisioned: Actor[];

  beforeAll(async () => {
    const issuerKeys = await generateKeyPair('EdDSA', { extractable: true });
    const clientKeys = await generateKeyPair('EdDSA', { extractable: true });
    issuerPrivate = { ...await exportJWK(issuerKeys.privateKey), kid: 'issuer-key' };
    issuerPublic = { ...await exportJWK(issuerKeys.publicKey), kid: 'issuer-key' };
    clientPrivate = { ...await exportJWK(clientKeys.privateKey), kid: 'rp-key' };
    clientPublic = { ...await exportJWK(clientKeys.publicKey), kid: 'rp-key' };
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
  });

  beforeEach(async () => {
    if (app) await app.close();
    await pool.query('TRUNCATE principals CASCADE');
    await pool.query('TRUNCATE auth_flows, auth_events, auth_revoked_sids, auth_subject_invalidations, auth_catalog_publications');
    await pool.query('UPDATE auth_settings SET last_catalog_sync = NULL');
    mock = new MockIssuer(issuerPrivate, issuerPublic, clientPublic);
    provisioned = [];
    config = { issuer, clientId, publicBaseUrl: origin, clientPrivateJwk: clientPrivate,
      accountPortalUrl: 'https://account.example.test', sessionIdleSeconds: 60, sessionMaxSeconds: 120 };
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const code = error instanceof ApiError ? error.statusCode : 500;
      return reply.code(code).send({ error: error instanceof ApiError ? error.code : 'internal_error' });
    });
    auth = registerAuthRoutes(app, pool, config, { fetch: mock.fetch, now: () => mock.now,
      onLogin: async (actor) => { provisioned.push(actor); } });
    app.get('/private', async (request) => {
      const actor = await auth.authorizeRequest(request);
      return { ...actor, permissions: [...actor.permissions] };
    });
    app.post('/private', async (request) => {
      const actor = await auth.authorizeRequest(request, { mutating: true });
      return { principalId: actor.principalId };
    });
    await auth.publishRoleCatalog();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function begin(identity = alice, overrides: Record<string, unknown> = {}, returnTo = '/'): Promise<Flow> {
    const response = await app.inject({ url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.origin).toBe(issuer);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const state = location.searchParams.get('state')!;
    const code = randomUUID();
    const sid = randomUUID();
    mock.codes.set(code, { nonce: location.searchParams.get('nonce')!, challenge: location.searchParams.get('code_challenge')!,
      claims: { sub: identity.sub, preferred_username: identity.username, name: identity.username,
        email: 'profile@example.test', app_role: identity.role, sid, sess_exp: Math.floor(mock.now / 1000) + 90,
        sess_persistent: true, ...overrides } });
    return { state, code, sid: (overrides.sid as string | undefined) ?? sid, cookie: cookies(response)[0]!.split(';')[0]! };
  }
  async function complete(flow: Flow) {
    return app.inject({ url: `/auth/callback?state=${encodeURIComponent(flow.state)}&code=${encodeURIComponent(flow.code)}`, headers: { cookie: flow.cookie } });
  }
  async function login(identity = alice, overrides: Record<string, unknown> = {}) {
    const flow = await begin(identity, overrides);
    const response = await complete(flow);
    expect(response.statusCode).toBe(302);
    const cookie = cookies(response).find((value) => value.startsWith(`${SECURE_SESSION_COOKIE}=`))!.split(';')[0]!;
    const session = (await app.inject({ url: '/auth/session', headers: { cookie } })).json();
    return { flow, response, cookie, session };
  }
  async function event(type: string, payload: Record<string, unknown>, id = randomUUID(), options: Parameters<MockIssuer['signed']>[1] = {}) {
    const token = await mock.signed({ events: [{ id, type, payload }] }, { typ: 'events+jwt', ...options });
    return app.inject({ method: 'POST', url: '/backchannel/events', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ event_token: token }).toString() });
  }

  it('publishes a signed RP catalog and exposes registration material without private keys', async () => {
    expect(mock.published[0]).toMatchObject([{ type: 'roles.sync', payload: { default_role: 1,
      roles: [{ role_id: 0, name: 'postmaster' }, { role_id: 1, name: 'member' }, { role_id: 2, name: 'viewer' }] } }]);
    expect(auth.registrationMaterial()).toMatchObject({ client_id: clientId, hostname: 'mail.example.test', events_path: '/backchannel/events' });
    const jwks = (await app.inject({ url: '/.well-known/jwks.json' })).json();
    expect(jwks.keys[0].d).toBeUndefined();
    expect(jwks.keys[0].x).toBe(clientPublic.x);
    await pool.query('UPDATE auth_settings SET last_catalog_sync = NULL');
    mock.failPublication = true;
    await expect(auth.publishRoleCatalog()).rejects.toThrow();
    expect((await auth.catalogStatus()).syncedAt).toBeNull();
    expect((await app.inject({ url: '/auth/login' })).statusCode).toBe(503);
  });

  it('publishes the configured display name instead of overwriting a development client name', async () => {
    const named = new AuthService(pool, { ...config, clientName: 'DreamPost Dev' }, { fetch: mock.fetch, now: () => mock.now });
    expect(named.registrationMaterial().name).toBe('DreamPost Dev');
    await named.publishRoleCatalog();
    expect(mock.published.at(-1)).toMatchObject([{ type: 'roles.sync', payload: { site_name: 'DreamPost Dev' } }]);
  });

  it('does not reuse catalog publication status for a different issuer or client', async () => {
    const another = new AuthService(pool, { ...config, clientId: 'another-rp' }, { fetch: mock.fetch });
    expect((await auth.catalogStatus()).syncedAt).not.toBeNull();
    expect((await another.catalogStatus()).syncedAt).toBeNull();
    await expect(another.beginLogin('/')).rejects.toMatchObject({ code: 'sso_registration_incomplete' });
  });

  it('rejects existing sessions and login flows after RP client reconfiguration', async () => {
    const current = await login();
    const flow = await begin();
    const another = new AuthService(pool, { ...config, clientId: 'another-rp' }, { fetch: mock.fetch });
    await expect(another.authorizeRequest({ headers: { cookie: current.cookie } } as FastifyRequest)).rejects.toMatchObject({ statusCode: 401 });
    const equals = flow.cookie.indexOf('=');
    await expect(another.completeLogin(flow.state, flow.code, { [flow.cookie.slice(0, equals)]: flow.cookie.slice(equals + 1) })).rejects.toMatchObject({ code: 'invalid_login_state' });
    expect(mock.tokenExchanges).toBe(1);
  });

  it('uses PKCE/private_key_jwt and an HttpOnly session without promoting the first user', async () => {
    const result = await login();
    expect(mock.tokenExchanges).toBe(1);
    expect(result.session.actor).toMatchObject({ issuer, subject: alice.sub, username: 'alice', roleId: 1 });
    expect(new Set(result.session.actor.permissions)).toEqual(new Set(['mailbox.use', 'mail.send', 'mail.manage']));
    expect(result.session.csrfToken).toHaveLength(43);
    expect(provisioned).toHaveLength(1);
    const cookie = cookies(result.response).find((value) => value.startsWith(`${SECURE_SESSION_COOKIE}=`))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect((await app.inject({ url: '/private', headers: { authorization: 'Bearer development-token' } })).statusCode).toBe(401);
    const sessions = (await pool.query('SELECT token_hash FROM auth_sessions')).rows;
    expect(sessions[0].token_hash).not.toBe(result.cookie.split('=')[1]);
  });

  it('ignores parent-domain ordinary cookies and rejects ambiguous host cookie names', async () => {
    const first = await login(alice);
    const second = await login(bob);
    const ordinaryAttackerCookie = `${SESSION_COOKIE}=${second.cookie.split('=')[1]}`;
    for (const cookie of [`${ordinaryAttackerCookie}; ${first.cookie}`, `${first.cookie}; ${ordinaryAttackerCookie}`]) {
      expect((await app.inject({ url: '/private', headers: { cookie } })).json().subject).toBe(alice.sub);
    }
    expect((await app.inject({ url: '/private', headers: { cookie: ordinaryAttackerCookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/private', headers: { cookie: `${first.cookie}; ${second.cookie}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/private', headers: { cookie: `${first.cookie}; ${first.cookie}` } })).statusCode).toBe(401);
  });

  it('uses host-prefixed flow cookies on HTTPS and refuses duplicate flow names', async () => {
    const response = await app.inject({ url: '/auth/login' });
    const flowCookie = cookies(response)[0]!;
    expect(flowCookie).toMatch(/^__Host-dreampost_flow_/);
    expect(flowCookie).toContain('Path=/;');
    expect(flowCookie).toContain('Secure');
    expect(flowCookie).not.toContain('Domain=');
    const flow = await begin();
    const result = await app.inject({ url: `/auth/callback?state=${flow.state}&code=${flow.code}`,
      headers: { cookie: `${flow.cookie}; ${flow.cookie}` } });
    expect(result.statusCode).toBe(400);
    expect(mock.tokenExchanges).toBe(0);
  });

  it('retains unprefixed cookies only for explicitly allowed loopback HTTP', async () => {
    const local = Fastify();
    const service = registerAuthRoutes(local, pool, { ...config, publicBaseUrl: 'http://127.0.0.1:4000', allowInsecureLocal: true }, { fetch: mock.fetch });
    try {
      expect(service.sessionCookieName).toBe(SESSION_COOKIE);
      const response = await local.inject({ url: '/auth/login' });
      expect(response.statusCode).toBe(302);
      const cookie = cookies(response)[0]!;
      expect(cookie).toMatch(/^dreampost_flow_/);
      expect(cookie).toContain('Path=/auth;');
      expect(cookie).not.toContain('Secure');
    } finally { await local.close(); }
  });

  it('authenticates an admitted administrator whose local mailbox.use permission is denied', async () => {
    const id = randomUUID();
    await pool.query('INSERT INTO principals (id,issuer,subject,username) VALUES ($1,$2,$3,$4)', [id, issuer, alice.sub, alice.username]);
    await pool.query("INSERT INTO auth_user_permission_overrides (principal_id,permission,effect) VALUES ($1,'mailbox.use','deny')", [id]);
    const current = await login({ ...alice, role: 0 });
    expect(current.session.actor.principalId).toBe(id);
    expect(current.session.actor.permissions).toContain('addresses.manage');
    expect(current.session.actor.permissions).not.toContain('mailbox.use');
  });

  it('keeps two identities separate even when profile emails match and preserves stable subject identity', async () => {
    const first = await login(alice);
    const second = await login(bob);
    expect(first.session.actor.principalId).not.toBe(second.session.actor.principalId);
    expect((await app.inject({ url: '/private', headers: { cookie: first.cookie } })).json().subject).toBe(alice.sub);
    expect((await app.inject({ url: '/private', headers: { cookie: second.cookie } })).json().subject).toBe(bob.sub);
    mock.now += 1000;
    const renamed = await login({ ...alice, username: 'alice-renamed' });
    expect(renamed.session.actor.principalId).toBe(first.session.actor.principalId);
    expect(renamed.session.actor.username).toBe('alice-renamed');
  });

  it('consumes browser state only with the matching cookie and prevents callback replay', async () => {
    const flow = await begin();
    expect((await app.inject({ url: `/auth/callback?state=${flow.state}&code=${flow.code}` })).statusCode).toBe(400);
    expect(mock.tokenExchanges).toBe(0);
    expect((await complete(flow)).statusCode).toBe(302);
    expect((await complete(flow)).statusCode).toBe(400);
    expect(mock.tokenExchanges).toBe(1);
  });

  it.each([
    ['nonce', { nonce: 'different' }, 403],
    ['audience', { token_aud: 'another-client' }, 401],
    ['issuer', { token_iss: 'https://untrusted.example.test' }, 401],
    ['token type', { token_typ: 'events+jwt' }, 401],
    ['missing role', { app_role: undefined }, 403],
    ['unknown role', { app_role: 99 }, 403],
  ])('rejects invalid %s claims without provisioning a principal', async (_name, overrides, status) => {
    const flow = await begin(alice, overrides);
    expect((await complete(flow)).statusCode).toBe(status);
    expect((await pool.query('SELECT count(*) AS count FROM principals')).rows[0].count).toBe('0');
    expect(provisioned).toHaveLength(0);
  });

  it('supports concurrent login flows without one callback consuming the other state', async () => {
    const first = await begin(alice);
    const second = await begin(bob);
    const jar = `${first.cookie}; ${second.cookie}`;
    const finish = (flow: Flow) => app.inject({ url: `/auth/callback?state=${flow.state}&code=${flow.code}`, headers: { cookie: jar } });
    expect((await finish(first)).statusCode).toBe(302);
    expect((await finish(second)).statusCode).toBe(302);
    expect(provisioned).toHaveLength(2);
  });

  it('keeps transient cookies nonpersistent and enforces the upstream absolute expiry', async () => {
    const current = await login(alice, { sess_persistent: false, sess_exp: Math.floor(mock.now / 1000) + 20 });
    const cookie = cookies(current.response).find((value) => value.startsWith(`${SECURE_SESSION_COOKIE}=`))!;
    expect(cookie).not.toContain('Max-Age=');
    mock.now += 21_000;
    expect((await app.inject({ url: '/private', headers: { cookie: current.cookie } })).statusCode).toBe(401);
  });

  it('requires both exact Origin and CSRF for mutations', async () => {
    const { cookie, session } = await login();
    expect((await app.inject({ method: 'POST', url: '/private', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/private', headers: { cookie, origin } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/private', headers: { cookie, origin: 'https://elsewhere.example.test', 'x-csrf-token': session.csrfToken } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/private', headers: { cookie, origin, 'x-csrf-token': session.csrfToken } })).statusCode).toBe(200);
  });

  it('applies signed sid logout idempotently without signing out another identity', async () => {
    const first = await login(alice);
    const second = await login(bob);
    const id = randomUUID();
    expect((await event('logout', { sid: first.flow.sid, sub: alice.sub }, id)).statusCode).toBe(204);
    expect((await event('logout', { sid: first.flow.sid, sub: alice.sub }, id)).statusCode).toBe(204);
    expect((await app.inject({ url: '/private', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/private', headers: { cookie: second.cookie } })).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*) AS count FROM auth_events')).rows[0].count).toBe('1');
  });

  it('prevalidates malformed middle events before any commit and processes a corrected retry idempotently', async () => {
    const first = await login(alice);
    const second = await login(bob);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const events = [
      { id: ids[0], type: 'logout', payload: { sid: first.flow.sid } },
      { id: ids[1], type: 'account.profile_change', payload: { sub: bob.sub, avatar: 42 as unknown } },
      { id: ids[2], type: 'logout', payload: { sid: second.flow.sid } },
    ];
    const postBatch = async () => app.inject({ method: 'POST', url: '/backchannel/events',
      payload: { event_token: await mock.signed({ events }, { typ: 'events+jwt' }) } });
    expect((await postBatch()).statusCode).toBe(400);
    expect((await pool.query('SELECT count(*) AS count FROM auth_events')).rows[0].count).toBe('0');
    expect((await app.inject({ url: '/private', headers: { cookie: first.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/private', headers: { cookie: second.cookie } })).statusCode).toBe(200);
    events[1]!.payload.avatar = 'corrected.webp';
    expect((await postBatch()).statusCode).toBe(204);
    const profileVersion = (await pool.query('SELECT profile_version FROM principals WHERE subject = $1', [bob.sub])).rows[0].profile_version;
    expect((await postBatch()).statusCode).toBe(204);
    expect((await pool.query('SELECT count(*) AS count FROM auth_events')).rows[0].count).toBe('3');
    expect((await pool.query('SELECT profile_version FROM principals WHERE subject = $1', [bob.sub])).rows[0].profile_version).toBe(profileVersion);
    expect((await app.inject({ url: '/private', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/private', headers: { cookie: second.cookie } })).statusCode).toBe(401);
  });

  it('retries a transient middle event without losing later revocations or repeating the committed prefix', async () => {
    const first = await login(alice);
    const second = await login(bob);
    const events = [
      { id: randomUUID(), type: 'logout', payload: { sid: first.flow.sid } },
      { id: randomUUID(), type: 'roles.sync_request', payload: {} },
      { id: randomUUID(), type: 'logout', payload: { sid: second.flow.sid } },
    ];
    const postBatch = async () => app.inject({ method: 'POST', url: '/backchannel/events',
      payload: { event_token: await mock.signed({ events }, { typ: 'events+jwt' }) } });
    mock.failPublication = true;
    expect((await postBatch()).statusCode).toBe(500);
    expect((await pool.query('SELECT count(*) AS count FROM auth_events')).rows[0].count).toBe('1');
    mock.failPublication = false;
    expect((await postBatch()).statusCode).toBe(204);
    expect((await pool.query('SELECT count(*) AS count FROM auth_events')).rows[0].count).toBe('3');
    expect((await app.inject({ url: '/private', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/private', headers: { cookie: second.cookie } })).statusCode).toBe(401);
  });

  it('does not accept an event token of the wrong audience or token type', async () => {
    const current = await login();
    expect((await event('logout', { sid: current.flow.sid }, randomUUID(), { aud: 'another-client' })).statusCode).toBe(401);
    expect((await event('logout', { sid: current.flow.sid }, randomUUID(), { typ: 'JWT' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/private', headers: { cookie: current.cookie } })).statusCode).toBe(200);
  });

  it('rejects events signed with an untrusted key and does not consume their event IDs', async () => {
    const current = await login();
    const token = await new SignJWT({ events: [{ id: randomUUID(), type: 'logout', payload: { sid: current.flow.sid } }] })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'issuer-key', typ: 'events+jwt' })
      .setIssuer(issuer).setAudience(clientId).setIssuedAt(Math.floor(mock.now / 1000))
      .setExpirationTime(Math.floor(mock.now / 1000) + 60).sign(await importJWK(clientPrivate, 'EdDSA'));
    expect((await app.inject({ method: 'POST', url: '/backchannel/events', payload: { event_token: token } })).statusCode).toBe(401);
    expect((await pool.query('SELECT count(*) AS count FROM auth_events')).rows[0].count).toBe('0');
    expect((await app.inject({ url: '/private', headers: { cookie: current.cookie } })).statusCode).toBe(200);
  });

  it('requires fresh OIDC admission after No access and never re-enables it from delayed grant/profile events', async () => {
    const current = await login();
    const principalId = current.session.actor.principalId;
    await pool.query("INSERT INTO auth_user_permission_overrides (principal_id, permission, effect) VALUES ($1, 'roles.manage', 'allow')", [principalId]);
    const denyId = randomUUID();
    expect((await event('account.roles_change', { sub: alice.sub, role_id: null }, denyId)).statusCode).toBe(204);
    const version = (await pool.query('SELECT auth_version FROM principals WHERE id = $1', [principalId])).rows[0].auth_version;
    await event('account.roles_change', { sub: alice.sub, role_id: null }, denyId);
    expect((await pool.query('SELECT auth_version FROM principals WHERE id = $1', [principalId])).rows[0].auth_version).toBe(version);
    await expect(auth.resolvePrincipal(principalId)).rejects.toMatchObject({ statusCode: 403 });
    await event('account.roles_change', { sub: alice.sub, role_id: 0 });
    await event('account.profile_change', { sub: alice.sub, avatar: 'avatar.webp' });
    await expect(auth.resolvePrincipal(principalId)).rejects.toMatchObject({ statusCode: 403 });
    expect((await app.inject({ url: '/private', headers: { cookie: current.cookie } })).statusCode).toBe(401);
    mock.now += 2000;
    const fresh = await login({ ...alice, role: 0 });
    expect(fresh.session.actor.roleId).toBe(0);
    expect(fresh.session.actor.principalId).toBe(principalId);
  });

  it('blocks a revoked sid callback before the provisioning hook or principal becomes active', async () => {
    const flow = await begin();
    await event('logout', { sid: flow.sid, sub: alice.sub });
    expect((await complete(flow)).statusCode).toBe(401);
    expect(provisioned).toHaveLength(0);
    expect((await pool.query('SELECT count(*) AS count FROM principals WHERE access_enabled')).rows[0].count).toBe('0');
  });

  it('retains No access evidence before first login and rejects a stale callback', async () => {
    const flow = await begin(alice, { token_iat: Math.floor(mock.now / 1000) });
    await event('account.roles_change', { sub: alice.sub, role_id: null });
    expect((await complete(flow)).statusCode).toBe(403);
    expect(provisioned).toHaveLength(0);
    expect((await pool.query('SELECT count(*) AS count FROM auth_sessions')).rows[0].count).toBe('0');
  });

  it('revalidates local permission overrides on every actor lookup', async () => {
    const current = await login({ ...alice, role: 0 });
    const id = current.session.actor.principalId;
    expect((await auth.resolvePrincipal(id)).permissions.has('roles.manage')).toBe(true);
    await pool.query("INSERT INTO auth_user_permission_overrides (principal_id, permission, effect) VALUES ($1, 'roles.manage', 'deny')", [id]);
    expect((await auth.resolvePrincipal(id)).permissions.has('roles.manage')).toBe(false);
    await pool.query('DELETE FROM auth_user_permission_overrides WHERE principal_id = $1', [id]);
    expect((await auth.resolvePrincipal(id)).permissions.has('roles.manage')).toBe(true);
  });

  it('holds the principal lock when authorization is resolved inside a business transaction', async () => {
    const current = await login();
    const client = await pool.connect();
    const contender = await pool.connect();
    try {
      await client.query('BEGIN');
      await auth.resolvePrincipal(current.session.actor.principalId, client);
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout = '100ms'");
      await expect(contender.query('UPDATE principals SET access_enabled = false WHERE id = $1', [current.session.actor.principalId])).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await contender.query('ROLLBACK');
      await client.query('ROLLBACK');
      contender.release(); client.release();
    }
  });

  it('checks mutation CSRF in a read-only preflight without locking principals or renewing idle time', async () => {
    app.post('/preflight', async request => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL lock_timeout = '100ms'");
        const actor = await auth.authorizeRequest(request, { client, mutating: true, readOnly: true });
        await client.query('COMMIT');
        return { principalId: actor.principalId };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
    const current = await login();
    const before = (await pool.query('SELECT last_seen,idle_expires_at FROM auth_sessions')).rows;
    mock.now += 10_000;
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM principals WHERE id=$1 FOR UPDATE', [current.session.actor.principalId]);
      expect((await app.inject({ method: 'POST', url: '/preflight', headers: {
        cookie: current.cookie, origin, 'x-csrf-token': current.session.csrfToken,
      } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/preflight', headers: {
        cookie: current.cookie, origin, 'x-csrf-token': 'invalid',
      } })).statusCode).toBe(403);
      expect((await pool.query('SELECT last_seen,idle_expires_at FROM auth_sessions')).rows).toEqual(before);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
    await pool.query('UPDATE principals SET access_enabled=false WHERE id=$1', [current.session.actor.principalId]);
    expect((await app.inject({ method: 'POST', url: '/preflight', headers: {
      cookie: current.cookie, origin, 'x-csrf-token': current.session.csrfToken,
    } })).statusCode).toBe(401);
  });

  it('expires an idle session and supports CSRF-protected RP initiated logout', async () => {
    const current = await login();
    const response = await app.inject({ method: 'POST', url: '/auth/logout', headers: {
      cookie: current.cookie, origin, 'x-csrf-token': current.session.csrfToken,
    } });
    expect(response.statusCode).toBe(200);
    expect(new URL(response.json().logoutUrl).origin).toBe(issuer);
    expect(cookies(response)[0]).toContain('Max-Age=0');
    expect((await app.inject({ url: '/private', headers: { cookie: current.cookie } })).statusCode).toBe(401);
    const another = await login(bob);
    mock.now += 61_000;
    expect((await app.inject({ url: '/private', headers: { cookie: another.cookie } })).statusCode).toBe(401);
  });
});
