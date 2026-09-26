import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/database.js';
import { AuthService } from '../src/auth/service.js';
import type { AuthConfig } from '../src/auth/types.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const issuer = 'https://publication-issuer.example.test';
const clientId = 'dreampost-publication-test';
interface Publication { iat: number; observedAt: number; payload: { site_name: string; default_role: number; roles: Array<{ role_id: number; name: string }> }; }

describe.skipIf(!databaseUrl)('serialized DreamSSO role publication with PostgreSQL', () => {
  const schema = `dreampost_publication_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let firstPool: pg.Pool;
  let secondPool: pg.Pool;
  let config: AuthConfig;
  let rpPublic: JWK;
  let issuerPrivate: JWK;
  let issuerPublic: JWK;
  let first: AuthService;
  let second: AuthService;
  let publications: Publication[];
  let latestApplied: Publication | undefined;
  let respond: (publication: Publication) => Promise<Response>;

  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === `${issuer}/jwks`) return Response.json({ keys: [issuerPublic] });
    if (String(input) !== `${issuer}/backchannel/events`) throw new Error('Unexpected mock issuer request');
    const parameters = new URLSearchParams(init?.body as URLSearchParams);
    const { payload } = await jwtVerify(parameters.get('event_token')!, await importJWK(rpPublic, 'EdDSA'), {
      issuer: clientId, subject: clientId, audience: issuer, typ: 'events+jwt', maxTokenAge: '5 minutes',
    });
    const events = payload.events as Array<{ type: string; payload: Publication['payload'] }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('roles.sync');
    const publication = { iat: payload.iat!, observedAt: Math.floor(Date.now() / 1000), payload: events[0]!.payload };
    publications.push(publication);
    // Reproduce DreamSSO's ordering rule: stale/equal timestamps receive 204 but are not applied.
    if (!latestApplied || publication.iat > latestApplied.iat) latestApplied = publication;
    return respond(publication);
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    firstPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 2000 });
    secondPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 2000 });
    await migrate(firstPool);
    const rpKeys = await generateKeyPair('EdDSA', { extractable: true });
    const idpKeys = await generateKeyPair('EdDSA', { extractable: true });
    rpPublic = { ...await exportJWK(rpKeys.publicKey), kid: 'rp-publication-key' };
    issuerPrivate = { ...await exportJWK(idpKeys.privateKey), kid: 'issuer-publication-key' };
    issuerPublic = { ...await exportJWK(idpKeys.publicKey), kid: 'issuer-publication-key' };
    config = { issuer, clientId, publicBaseUrl: 'https://publication-mail.example.test',
      clientPrivateJwk: { ...await exportJWK(rpKeys.privateKey), kid: 'rp-publication-key' } };
  });

  beforeEach(async () => {
    await firstPool.query('TRUNCATE auth_catalog_publications, auth_events');
    await firstPool.query('UPDATE auth_settings SET last_catalog_sync = NULL, catalog_issuer = NULL, catalog_client_id = NULL, default_role_id = 1');
    await firstPool.query("UPDATE auth_roles SET name = 'member' WHERE role_id = 1");
    publications = [];
    latestApplied = undefined;
    respond = async () => new Response(null, { status: 204 });
    first = new AuthService(firstPool, { ...config, clientName: 'First catalog' }, { fetch: fetcher });
    second = new AuthService(secondPool, { ...config, clientName: 'Second catalog' }, { fetch: fetcher });
  });

  afterAll(async () => {
    if (firstPool) await firstPool.end();
    if (secondPool) await secondPool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });

  it('serializes two independent publishers and applies the later different catalog with a strictly newer timestamp', async () => {
    let started!: () => void;
    let releaseFirst!: () => void;
    const submitting = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    respond = async (publication) => {
      if (publication.payload.site_name === 'First catalog') { started(); await release; }
      return new Response(null, { status: 204 });
    };
    const firstAttempt = first.publishRoleCatalog();
    await submitting;
    // The clock reservation must be visible to a separate connection before HTTP completes.
    const reserved = (await secondPool.query('SELECT last_issued_at FROM auth_catalog_publications')).rows[0].last_issued_at;
    expect(Number(reserved)).toBe(publications[0]!.iat);
    await secondPool.query('UPDATE auth_settings SET default_role_id = 2');
    await secondPool.query("UPDATE auth_roles SET name = 'changed-member' WHERE role_id = 1");
    const secondAttempt = second.publishRoleCatalog();
    try {
      await sleep(20);
      expect(publications).toHaveLength(1);
    } finally { releaseFirst(); }
    await Promise.all([firstAttempt, secondAttempt]);
    expect(publications).toHaveLength(2);
    expect(publications[1]!.iat).toBeGreaterThan(publications[0]!.iat);
    expect(publications.every((entry) => entry.iat <= entry.observedAt)).toBe(true);
    expect(latestApplied!.payload).toMatchObject({ site_name: 'Second catalog', default_role: 2 });
    expect(latestApplied!.payload.roles.find((role) => role.role_id === 1)?.name).toBe('changed-member');
    expect((await second.catalogStatus()).syncedAt).not.toBeNull();
  });

  it('retains the reserved timestamp after a lost response and uses a new one on retry', async () => {
    respond = async () => { throw new Error('Simulated lost acknowledgment after remote acceptance'); };
    await expect(first.publishRoleCatalog()).rejects.toThrow('lost acknowledgment');
    expect((await first.catalogStatus()).syncedAt).toBeNull();
    expect(Number((await firstPool.query('SELECT last_issued_at FROM auth_catalog_publications')).rows[0].last_issued_at)).toBe(publications[0]!.iat);
    respond = async () => new Response(null, { status: 204 });
    await second.publishRoleCatalog();
    expect(publications[1]!.iat).toBeGreaterThan(publications[0]!.iat);
    expect(latestApplied!.payload.site_name).toBe('Second catalog');
    expect((await second.catalogStatus()).syncedAt).not.toBeNull();
  });

  it('processes and deduplicates roles.sync_request with a one-connection pool', async () => {
    const eventId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ events: [{ id: eventId, type: 'roles.sync_request', payload: {} }] })
      .setProtectedHeader({ alg: 'EdDSA', kid: issuerPublic.kid, typ: 'events+jwt' })
      .setIssuer(issuer).setAudience(clientId).setIssuedAt(now).setExpirationTime(now + 120)
      .sign(await importJWK(issuerPrivate, 'EdDSA'));
    await first.acceptEvents(token);
    await second.acceptEvents(token);
    expect(publications).toHaveLength(1);
    expect((await firstPool.query('SELECT count(*) AS count FROM auth_events WHERE event_id = $1', [eventId])).rows[0].count).toBe('1');
  });

  it('does not forward-date JWTs when the persisted clock is materially ahead', async () => {
    await firstPool.query('INSERT INTO auth_catalog_publications (issuer, client_id, last_issued_at) VALUES ($1,$2,$3)',
      [issuer, clientId, Math.floor(Date.now() / 1000) + 60]);
    await expect(first.publishRoleCatalog()).rejects.toMatchObject({ code: 'role_publication_clock_not_ready' });
    expect(publications).toHaveLength(0);
    expect((await first.catalogStatus()).syncedAt).toBeNull();
  });
});
