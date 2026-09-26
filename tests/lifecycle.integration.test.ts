import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPolicyHeaders, INGEST_PATH, POLICY_PATH, type PolicyAck, type RoutePolicy,
} from '../packages/protocol/dist/index.js';
import { AddressService, dispatchOnePolicy } from '../apps/api/src/addresses/index.js';
import { AuthService, type AuthConfig } from '../apps/api/src/auth/index.js';
import { hashSecret } from '../apps/api/src/auth/cookies.js';
import { SECURE_SESSION_COOKIE } from '../apps/api/src/auth/types.js';
import { buildApp } from '../apps/api/src/app.js';
import { FileBlobStore } from '../apps/api/src/blob-store.js';
import { migrate } from '../apps/api/src/database.js';
import { Gateway } from '../workers/ingress/src/core.js';
import type { GatewayConfig } from '../workers/ingress/src/config.js';
import { handlePolicyRequest } from '../workers/ingress/src/policies.js';
import type { InboundMessage, RawStore, StoredRaw } from '../workers/ingress/src/model.js';
import { sqliteLedger } from '../workers/ingress/test/helpers/sqlite-ledger.js';

// Resolve the API's declared PostgreSQL dependency without adding an unrelated root runtime dependency.
type Pool = AddressService['pool'];
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool: PostgreSQLPool } = requireApi('pg') as {
  Pool: new (options: { connectionString?: string; connectionTimeoutMillis?: number; options?: string }) => Pool;
};
const databaseUrl = process.env['TEST_DATABASE_URL'];
const issuer = 'https://sso.example.test';
const clientId = 'dreampost-lifecycle-test';
const controlKey = { id: 'policy-test', secret: 'isolated-lifecycle-control-secret-32-bytes' };
const ingestKey = { id: 'ingest-test', secret: 'isolated-lifecycle-ingest-secret-32-bytes' };
const rawBytes = Buffer.from('From: sender@example.test\r\nTo: alpha@example.test\r\nSubject: Shared bytes, separate ownership\r\n\r\nThe same content must not merge delivery ownership.\r\n');

// Every test uses its own PostgreSQL schema, in-memory D1, and temporary raw-file store.
// No SSO, Cloudflare, SMTP, or external HTTP request is made.
describe.skipIf(!databaseUrl)('alias lifecycle across the backend and gateway', () => {
  let adminPool: Pool;
  let pool: Pool | undefined;
  let schema: string | undefined;
  let directory: string | undefined;
  let edge: ReturnType<typeof sqliteLedger> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let service: AddressService;
  let gateway: Gateway;
  let gatewayConfig: GatewayConfig;
  let objects: Map<string, StoredRaw>;
  let queued: string[];
  let principalA: string;
  let principalB: string;
  let administrator: string;
  let mailboxA: string;
  let mailboxB: string;
  let allocationA: string;
  let cookieA: string;
  let cookieB: string;
  let forbiddenNetwork: ReturnType<typeof vi.fn>;

  beforeAll(() => { adminPool = new PostgreSQLPool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }); });
  beforeEach(async () => {
    forbiddenNetwork = vi.fn(async () => { throw new Error('External network is forbidden in lifecycle integration tests'); });
    vi.stubGlobal('fetch', forbiddenNetwork);
    schema = `dreampost_lifecycle_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new PostgreSQLPool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    edge = sqliteLedger();
    directory = await mkdtemp(join(tmpdir(), 'dreampost-lifecycle-'));
    const clientPrivateJwk = { ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }), kid: 'local-rp-fixture' };
    const authConfig: AuthConfig = { issuer, clientId, publicBaseUrl: 'https://mail.example.test', clientPrivateJwk };
    const auth = new AuthService(pool, authConfig, { fetch: forbiddenNetwork as typeof fetch });
    service = new AddressService(pool, { defaultDomain: 'example.test', managedDomains: ['example.test'] },
      (id, client) => auth.resolvePrincipal(id, client));
    principalA = randomUUID(); principalB = randomUUID(); administrator = randomUUID();
    for (const [id, username, role] of [[principalA, 'alpha', 1], [principalB, 'bravo', 1], [administrator, 'operator', 0]] as const) {
      await pool.query(`INSERT INTO principals(id,issuer,subject,username,display_name,app_role,access_enabled)
        VALUES ($1,$2,$3,$4,$4,$5,true)`, [id, issuer, `subject:${id}`, username, role]);
    }
    mailboxA = (await service.provisionFirstMailbox(principalA)).id;
    mailboxB = (await service.provisionFirstMailbox(principalB)).id;
    allocationA = (await service.listForActor(principalA)).addresses.find(address => address.current)!.allocationId;
    const blobs = new FileBlobStore(directory);
    app = buildApp({ databaseUrl: databaseUrl!, mailStorePath: directory, ingestKeys: { [ingestKey.id]: ingestKey.secret },
      devMailboxId: '', devViewToken: '', host: '127.0.0.1', port: 3001, publicBaseUrl: authConfig.publicBaseUrl,
      auth: authConfig, addresses: service.config as { defaultDomain: string; managedDomains: string[] } }, pool, { blobs });
    cookieA = await createSession(principalA);
    cookieB = await createSession(principalB);
    gatewayConfig = { routingMode: 'dynamic', routes: {}, backendUrl: `https://mail.example.test${INGEST_PATH}`,
      key: ingestKey, doneRetentionDays: 7, policyKeys: { [controlKey.id]: controlKey.secret }, allowedPolicyDomains: ['example.test'] };
    objects = new Map(); queued = [];
    const raw: RawStore = {
      async put(id, bytes, metadata, sha256) { objects.set(id, { bytes: new Uint8Array(bytes), metadata: structuredClone(metadata), sha256 }); },
      async get(id) { return structuredClone(objects.get(id) ?? null); },
      async delete(id) { objects.delete(id); },
    };
    gateway = new Gateway({ ledger: edge.ledger, raw, config: gatewayConfig,
      queue: { async send(message) { queued.push(message.deliveryId); } },
      fetch: (async (_url, init) => {
        const response = await app!.inject({ method: 'POST', url: INGEST_PATH,
          headers: Object.fromEntries(new Headers(init?.headers).entries()), payload: Buffer.from(init?.body as Uint8Array) });
        return new Response(response.rawPayload, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    });
    await flushPolicies();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    edge?.close(); edge = undefined;
    if (pool) await pool.end();
    pool = undefined;
    if (schema) await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    schema = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    try { expect(forbiddenNetwork).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  afterAll(async () => { if (adminPool) await adminPool.end(); });

  async function createSession(id: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const until = new Date(Date.now() + 3600_000);
    await pool!.query(`INSERT INTO auth_sessions
      (token_hash,principal_id,client_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at)
      VALUES ($1,$2,$3,$4,0,$5,'isolated-local-fixture',$6,$6,$6)`,
    [hashSecret(token), id, clientId, randomUUID(), randomBytes(32).toString('base64url'), until]);
    return `${SECURE_SESSION_COOKIE}=${token}`;
  }
  async function flushPolicies(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const found = await dispatchOnePolicy(service, {
        gatewayUrl: `https://gateway.example.test${POLICY_PATH}`, key: controlKey,
        fetch: (async (url, init) => handlePolicyRequest(new Request(url, init), gatewayConfig, edge!.ledger)) as typeof fetch,
      });
      if (!found) {
        const remaining = await pool!.query("SELECT count(*) AS count FROM address_policy_outbox WHERE status NOT IN ('applied', 'superseded')");
        expect(remaining.rows[0].count).toBe('0');
        return;
      }
    }
    throw new Error('Policy dispatcher did not drain within the test bound');
  }
  async function latestPolicy(): Promise<RoutePolicy> {
    return (await pool!.query<{ payload: RoutePolicy }>(
      'SELECT payload FROM address_policy_history WHERE address = $1 ORDER BY revision DESC LIMIT 1', ['alpha@example.test'],
    )).rows[0]!.payload;
  }
  async function applyWithoutBackendAck(policy: RoutePolicy): Promise<PolicyAck> {
    const request = new Request(`https://gateway.example.test${POLICY_PATH}`, { method: 'POST', body: JSON.stringify(policy),
      headers: await createPolicyHeaders(policy, controlKey) });
    const response = await handlePolicyRequest(request, gatewayConfig, edge!.ledger);
    expect(response.status).toBe(200);
    return response.json() as Promise<PolicyAck>;
  }
  async function receive(): Promise<string> {
    const message: InboundMessage = { from: 'sender@example.test', to: 'Alpha@Example.test', rawSize: rawBytes.length,
      raw: new ReadableStream({ start(controller) { controller.enqueue(rawBytes); controller.close(); } }), setReject: vi.fn() };
    await gateway.receive(message);
    expect(message.setReject).not.toHaveBeenCalled();
    return queued.at(-1)!;
  }

  it('keeps accepted mail with A after pause/removal/reassignment and isolates B even when raw bytes are identical', async () => {
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(true);
    const oldDelivery = await receive();
    const oldMetadata = (await edge!.ledger.get(oldDelivery))!.metadata;
    expect(oldMetadata).toMatchObject({ version: 2, allocationId: allocationA, mailboxId: mailboxA, envelopeTo: 'Alpha@Example.test' });
    expect((await pool!.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
    await service.setPause(principalA, allocationA, 'owner', true);
    // Local sending closes before the receive-disable operation reaches the edge.
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(false);
    expect((await edge!.ledger.getPolicy('alpha@example.test'))?.policy.receiveEnabled).toBe(true);
    await flushPolicies();
    expect((await edge!.ledger.getPolicy('alpha@example.test'))?.policy.receiveEnabled).toBe(false);
    await service.removeAddress(administrator, allocationA);
    await flushPolicies();
    const allocationB = await service.addAddress(administrator, { address: 'alpha@example.test', mailboxId: mailboxB }, 'reassigned');
    expect((await service.resolveSenderEligibility(principalB, allocationB.id)).eligible).toBe(false);
    await flushPolicies();
    expect((await service.resolveSenderEligibility(principalB, allocationB.id)).eligible).toBe(true);
    const newDelivery = await receive();
    expect(objects.has(oldDelivery)).toBe(true);
    expect(await gateway.deliver(oldDelivery)).toEqual({ action: 'ack' });
    expect(await gateway.deliver(newDelivery)).toEqual({ action: 'ack' });
    expect(objects.size).toBe(0);
    expect((await edge!.ledger.get(oldDelivery))?.state).toBe('done');
    expect((await edge!.ledger.get(newDelivery))?.state).toBe('done');
    const deliveries = (await pool!.query<{ id: string; mailbox_id: string; sha256: string }>('SELECT id,mailbox_id,sha256 FROM deliveries')).rows;
    expect(deliveries.find(item => item.id === oldDelivery)?.mailbox_id).toBe(mailboxA);
    expect(deliveries.find(item => item.id === newDelivery)?.mailbox_id).toBe(mailboxB);
    expect(new Set(deliveries.map(item => item.sha256)).size).toBe(1);
    const ownOld = await app!.inject({ url: `/api/mailboxes/${mailboxA}/messages/${oldDelivery}/raw`, headers: { cookie: cookieA } });
    expect(ownOld.statusCode).toBe(200);
    expect(ownOld.rawPayload).toEqual(rawBytes);
    for (const mailbox of [mailboxA, mailboxB]) {
      expect((await app!.inject({ url: `/api/mailboxes/${mailbox}/messages/${oldDelivery}/raw`, headers: { cookie: cookieB } })).statusCode).toBe(404);
    }
    const viewB = await app!.inject({ url: `/api/mailboxes/${mailboxB}/messages`, headers: { cookie: cookieB } });
    expect(viewB.statusCode).toBe(200);
    expect(viewB.json().messages.map((item: { id: string }) => item.id)).toEqual([newDelivery]);
    const personalB = await service.listForActor(principalB);
    expect(personalB.addresses.filter(item => item.current).every(item => item.mailboxId === mailboxB)).toBe(true);
    expect(personalB.addresses.filter(item => item.current)).toHaveLength(2);
  });

  it('dispatches the latest paused snapshot across superseded intermediate revisions', async () => {
    await service.setPause(principalA, allocationA, 'owner', true);
    await service.setPause(principalA, allocationA, 'owner', false);
    await service.setPause(principalA, allocationA, 'owner', true);
    const latest = await latestPolicy();
    expect(latest.revision).toBe(4);
    expect((await edge!.ledger.getPolicy('alpha@example.test'))?.policy.revision).toBe(1);
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(false);
    await flushPolicies();
    expect((await edge!.ledger.getPolicy('alpha@example.test'))?.policy).toEqual(latest);
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(false);
    const applied = edge!.sql.prepare('SELECT revision FROM recipient_policy_operations WHERE address = ? ORDER BY revision').all('alpha@example.test');
    expect(applied.map(row => row.revision)).toEqual([1, 4]);
    const statuses = await pool!.query(`SELECT h.revision,o.status FROM address_policy_history h
      JOIN address_policy_outbox o ON o.operation_id=h.operation_id WHERE h.address=$1 ORDER BY h.revision`, ['alpha@example.test']);
    expect(statuses.rows.map(row => row.status)).toEqual(['applied', 'superseded', 'superseded', 'applied']);
  });

  it('retains accepted raw mail for retry when the backend lacks the signed admission history', async () => {
    // Simulate an edge snapshot surviving a backend restore or delayed history recovery.
    const old = await latestPolicy();
    const edgeOnly = { ...old, operationId: randomUUID(), previousRevision: old.revision, revision: old.revision + 1 };
    await applyWithoutBackendAck(edgeOnly);
    const id = await receive();
    expect((await gateway.deliver(id)).action).toBe('retry');
    expect((await edge!.ledger.get(id))?.state).toBe('stored');
    expect(objects.has(id)).toBe(true);
    expect((await pool!.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
  });

  it('does not reopen sending when a delayed enable ACK arrives after a newer pause', async () => {
    await service.setPause(principalA, allocationA, 'owner', true);
    await flushPolicies();
    await service.setPause(principalA, allocationA, 'owner', false);
    const enable = await latestPolicy();
    expect(enable.receiveEnabled).toBe(true);
    const delayedAck = await applyWithoutBackendAck(enable);
    // Even with edge receipt enabled, sending remains closed until the current ACK is recorded.
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(false);
    await service.setPause(principalA, allocationA, 'owner', true);
    const pause = await latestPolicy();
    expect(pause.revision).toBeGreaterThan(enable.revision);
    const pauseAck = await applyWithoutBackendAck(pause);
    await service.acknowledgePolicy(pauseAck);
    await service.acknowledgePolicy(delayedAck);
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(false);
    expect((await edge!.ledger.getPolicy('alpha@example.test'))?.policy).toEqual(pause);
    await service.setPause(principalA, allocationA, 'owner', false);
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(false);
    await flushPolicies();
    expect((await service.resolveSenderEligibility(principalA, allocationA)).eligible).toBe(true);
  });
});
