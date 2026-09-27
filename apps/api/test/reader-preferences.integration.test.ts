import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/database.js';
import { ApiError } from '../src/errors.js';
import { AuthService, type AuthConfig } from '../src/auth/index.js';
import { hashSecret } from '../src/auth/cookies.js';
import { SECURE_SESSION_COOKIE } from '../src/auth/types.js';
import { getReaderPreferences, registerReaderPreferenceRoutes } from '../src/reader-preferences.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const origin = 'https://mail.example.test';
interface User { id: string; cookie: string; csrf: string }

describe.skipIf(!databaseUrl)('per-principal reader preferences with real session authorization', () => {
  const schema = `reader_prefs_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let auth: AuthService;
  let alice: User;
  let bob: User;
  let parsed: number;
  let revokeBeforeWrite: boolean;
  const clientId = 'reader-preferences-test';
  const issuer = 'https://identity.example.test';
  const forbiddenFetch = vi.fn(async () => { throw new Error('External requests are not used in preference tests'); });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    const config: AuthConfig = { issuer, clientId, publicBaseUrl: origin,
      clientPrivateJwk: { ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }), kid: 'reader-preference-key' } };
    auth = new AuthService(pool, config, { fetch: forbiddenFetch });
  });
  async function user(username: string): Promise<User> {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled) VALUES ($1,$2,$3,$4,1,true)', [id, issuer, `subject:${id}`, username]);
    await pool.query(`INSERT INTO auth_sessions(token_hash,client_id,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at)
      VALUES ($1,$2,$3,$4,0,$5,'fixture',now()+interval '1 hour',now()+interval '1 hour',now()+interval '1 hour')`, [hashSecret(token), clientId, id, randomUUID(), csrf]);
    return { id, cookie: `${SECURE_SESSION_COOKIE}=${token}`, csrf };
  }
  function application() {
    const server = Fastify({ bodyLimit: 25 * 1024 * 1024 });
    server.setErrorHandler((error, _request, reply) => error instanceof ApiError
      ? reply.code(error.statusCode).send({ error: error.code }) : reply.send(error));
    server.addHook('preParsing', (_request, _reply, payload, done) => { parsed++; done(null, payload); });
    server.addHook('preHandler', async (request) => {
      if (revokeBeforeWrite && request.method === 'PATCH') await pool.query('UPDATE principals SET access_enabled = false WHERE id = $1', [alice.id]);
    });
    registerReaderPreferenceRoutes(server, pool, auth);
    return server;
  }
  beforeEach(async () => {
    if (app) await app.close();
    await pool.query('TRUNCATE principals CASCADE');
    alice = await user('alice'); bob = await user('bob');
    parsed = 0; revokeBeforeWrite = false; app = application();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
  const headers = (current: User) => ({ cookie: current.cookie, origin, 'x-csrf-token': current.csrf });

  it('defaults external images off and isolates persisted settings between viewers', async () => {
    expect((await app.inject({ url: '/api/preferences', headers: headers(alice) })).json()).toEqual({ autoLoadExternalImages: false });
    const changed = await app.inject({ method: 'PATCH', url: '/api/preferences', headers: headers(alice), payload: { autoLoadExternalImages: true } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ autoLoadExternalImages: true });
    expect(changed.headers['cache-control']).toBe('no-store');
    expect(await getReaderPreferences(pool, bob.id)).toEqual({ autoLoadExternalImages: false });
    await app.close(); app = application();
    expect((await app.inject({ url: '/api/preferences', headers: headers(alice) })).json()).toEqual({ autoLoadExternalImages: true });
    expect((await app.inject({ url: '/api/preferences', headers: headers(bob) })).json()).toEqual({ autoLoadExternalImages: false });
    await app.inject({ method: 'PATCH', url: '/api/preferences', headers: headers(alice), payload: { autoLoadExternalImages: false } });
    expect(await getReaderPreferences(pool, alice.id)).toEqual({ autoLoadExternalImages: false });
  });

  it('rejects principal selection and non-boolean preference payloads', async () => {
    for (const payload of [{ autoLoadExternalImages: true, principalId: bob.id }, { autoLoadExternalImages: 'true' }, {}]) {
      expect((await app.inject({ method: 'PATCH', url: '/api/preferences', headers: headers(alice), payload })).statusCode).toBe(400);
    }
    expect((await pool.query('SELECT count(*) FROM principal_preferences')).rows[0].count).toBe('0');
  });

  it('authenticates and checks mutation CSRF before parsing oversized request bodies', async () => {
    const payload = JSON.stringify({ autoLoadExternalImages: true, padding: 'x'.repeat(6000) });
    expect((await app.inject({ method: 'PATCH', url: '/api/preferences', headers: { 'content-type': 'application/json' }, payload })).statusCode).toBe(401);
    expect(parsed).toBe(0);
    expect((await app.inject({ method: 'PATCH', url: '/api/preferences', headers: { ...headers(alice), 'content-type': 'application/json', 'x-csrf-token': 'wrong' }, payload })).statusCode).toBe(403);
    expect(parsed).toBe(0);
    expect((await app.inject({ method: 'PATCH', url: '/api/preferences', headers: { ...headers(alice), 'content-type': 'application/json' }, payload })).statusCode).toBe(413);
  });

  it('rejects cross-origin mutations and revalidates a revocation before committing the preference', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/preferences', headers: { ...headers(alice), origin: 'https://other.example.test' }, payload: { autoLoadExternalImages: true } })).statusCode).toBe(403);
    revokeBeforeWrite = true;
    expect((await app.inject({ method: 'PATCH', url: '/api/preferences', headers: headers(alice), payload: { autoLoadExternalImages: true } })).statusCode).toBe(401);
    expect((await pool.query('SELECT count(*) FROM principal_preferences')).rows[0].count).toBe('0');
  });
});
