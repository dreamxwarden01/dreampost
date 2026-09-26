import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_OPERATION_PATH, INGEST_PATH, POLICY_PATH, hashRoutePolicy, signGatewayResponse, createGatewayOperationHeaders, verifyGatewayResponse,
  type GatewayInspection, type GatewayOperationResponse, type RoutePolicy,
} from '../packages/protocol/dist/index.js';
import { AddressService } from '../apps/api/src/addresses/service.js';
import { AddressOperatorService } from '../apps/api/src/addresses/operator.js';
import { GatewayClient } from '../apps/api/src/gateway-client.js';
import { AuthService, type AuthConfig } from '../apps/api/src/auth/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { FileBlobStore } from '../apps/api/src/blob-store.js';
import { migrate, seedMailbox } from '../apps/api/src/database.js';
import { Gateway } from '../workers/ingress/src/core.js';
import type { GatewayConfig } from '../workers/ingress/src/config.js';
import { handlePolicyRequest } from '../workers/ingress/src/policies.js';
import { handleOperationRequest } from '../workers/ingress/src/operations.js';
import type { InboundMessage, RawStore, StoredRaw } from '../workers/ingress/src/model.js';
import { sqliteLedger } from '../workers/ingress/test/helpers/sqlite-ledger.js';

type Pool = AddressService['pool'];
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool: PostgreSQLPool } = requireApi('pg') as {
  Pool: new (options: { connectionString?: string; connectionTimeoutMillis?: number; options?: string }) => Pool;
};
const databaseUrl = process.env['TEST_DATABASE_URL'];
const address = 'legacy@example.test';
const otherAddress = 'ordinary@example.test';
const gatewayId = 'dreampost-cutover-fixture';
const approvedVersion = 'approved-worker-version';
const actorLabel = 'isolated-test-operator';
const operatorKey = { id: 'operator', secret: 'isolated-operator-inspection-secret-at-least-32-bytes' };
const policyKey = { id: 'policy', secret: 'isolated-normal-policy-secret-at-least-32-bytes' };
const ingestKey = { id: 'ingest', secret: 'isolated-receipt-secret-at-least-32-bytes' };
const rawBytes = Buffer.from('From: sender@example.test\r\nTo: legacy@example.test\r\nSubject: Cutover receipt\r\n\r\nPreserve the original mailbox.\r\n');

// Production protocol/client/SQL/handlers run against an isolated PostgreSQL schema and SQLite-backed D1.
// All HTTP calls are routed in-process; no Cloudflare, SMTP, SSO, or other external service is called.
describe.skipIf(!databaseUrl)('bounded static-to-dynamic operator workflow', () => {
  let admin: Pool;
  let pool: Pool | undefined;
  let schema: string | undefined;
  let directory: string | undefined;
  let edge: ReturnType<typeof sqliteLedger> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let addresses: AddressService;
  let operator: AddressOperatorService;
  let client: GatewayClient;
  let config: GatewayConfig;
  let workerVersion: string;
  let legacyMailbox: string;
  let legacyAllocation: string;
  let member: string;
  let administrator: string;
  let ordinaryMailbox: string;
  let unrelatedOperation: string;
  let objects: Map<string, StoredRaw>;
  let raw: RawStore;
  let queue: string[];
  let controlStatuses: number[];
  let controlKinds: string[];
  let mutateResponse: ((response: Response) => Promise<Response>) | undefined;
  let beforeReconcile: (() => Promise<void>) | undefined;
  let forbiddenNetwork: ReturnType<typeof vi.fn>;

  beforeAll(() => { admin = new PostgreSQLPool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }); });
  beforeEach(async () => {
    forbiddenNetwork = vi.fn(async () => { throw new Error('External network is forbidden in operator integration tests'); });
    vi.stubGlobal('fetch', forbiddenNetwork);
    schema = `dreampost_cutover_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new PostgreSQLPool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    edge = sqliteLedger();
    directory = await mkdtemp(join(tmpdir(), 'dreampost-cutover-'));
    const authConfig: AuthConfig = { issuer: 'https://cutover-sso.example.test', clientId: 'dreampost-cutover-test',
      publicBaseUrl: 'https://mail.example.test', clientPrivateJwk: { ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }), kid: 'cutover-fixture' } };
    const auth = new AuthService(pool, authConfig, { fetch: forbiddenNetwork as typeof fetch });
    addresses = new AddressService(pool, { defaultDomain: 'example.test', managedDomains: ['example.test'] },
      (id, connection) => auth.resolvePrincipal(id, connection));
    member = randomUUID(); administrator = randomUUID();
    for (const [id, username, role] of [[member, 'ordinary', 1], [administrator, 'operator', 0]] as const) {
      await pool.query(`INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled)
        VALUES ($1,$2,$3,$4,$5,true)`, [id, authConfig.issuer, `subject:${id}`, username, role]);
    }
    ordinaryMailbox = (await addresses.provisionFirstMailbox(member)).id;
    unrelatedOperation = (await pool.query('SELECT operation_id FROM address_policy_history WHERE address = $1', [otherAddress])).rows[0].operation_id;
    legacyMailbox = randomUUID(); legacyAllocation = randomUUID();
    await seedMailbox(pool, { id: legacyMailbox, address, name: 'Existing legacy mailbox' });
    await pool.query("INSERT INTO address_registry(address,domain,state) VALUES ($1,'example.test','allocated')", [address]);
    await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source,receive_only) VALUES ($1,$2,$3,'legacy',false)", [legacyAllocation, address, legacyMailbox]);
    await pool.query('UPDATE address_registry SET current_allocation_id=$2 WHERE address=$1', [address, legacyAllocation]);
    await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES ($1,$2,ARRAY['read','send_as'])", [legacyMailbox, member]);
    await pool.query('INSERT INTO address_send_grants(id,allocation_id,principal_id) VALUES ($1,$2,$3)', [randomUUID(), legacyAllocation, member]);
    app = buildApp({ databaseUrl: databaseUrl!, mailStorePath: directory, ingestKeys: { [ingestKey.id]: ingestKey.secret },
      devMailboxId: legacyMailbox, devViewToken: 'isolated-cutover-development-view-token-32',
      host: '127.0.0.1', port: 3001, publicBaseUrl: 'https://mail.example.test' }, pool, { blobs: new FileBlobStore(directory) });
    config = { routingMode: 'static', routes: { [address]: legacyMailbox },
      backendUrl: `https://mail.example.test${INGEST_PATH}`, key: ingestKey, doneRetentionDays: 7,
      policyKeys: { [policyKey.id]: policyKey.secret }, allowedPolicyDomains: ['example.test'],
      allowStaticPreload: true, policyAllowedAddresses: [address],
      operator: { keys: { [operatorKey.id]: operatorKey.secret }, allowedAddresses: [address], gatewayId } };
    workerVersion = approvedVersion;
    objects = new Map(); queue = []; controlStatuses = []; controlKinds = []; mutateResponse = undefined; beforeReconcile = undefined;
    raw = {
      async put(id, bytes, metadata, sha256) { objects.set(id, { bytes: new Uint8Array(bytes), metadata: structuredClone(metadata), sha256 }); },
      async get(id) { return structuredClone(objects.get(id) ?? null); },
      async delete(id) { objects.delete(id); },
    };
    client = new GatewayClient({ operatorUrl: `https://gateway.example.test${GATEWAY_OPERATION_PATH}`,
      operatorKey, policyKey, expectedGatewayId: gatewayId, allowedAddresses: [address] }, {
      now: () => Date.now(),
      fetch: (async (url, init) => {
        const request = new Request(url, init);
        const path = new URL(request.url).pathname;
        let response: Response;
        if (path === POLICY_PATH) { controlKinds.push('policy-stage'); response = await handlePolicyRequest(request, config, edge!.ledger); }
        else {
          const operationKind = (await request.clone().json() as { kind: string }).kind;
          controlKinds.push(operationKind);
          if (operationKind === 'reconcile' && beforeReconcile) await beforeReconcile();
          response = await handleOperationRequest(request, config, edge!.ledger, workerVersion);
        }
        controlStatuses.push(response.status);
        return mutateResponse ? mutateResponse(response) : response;
      }) as typeof fetch,
    });
    operator = new AddressOperatorService(pool, { allowedAddresses: [address], now: () => Date.now() }, client);
  });
  afterEach(async () => {
    vi.useRealTimers();
    if (app) await app.close(); app = undefined;
    edge?.close(); edge = undefined;
    if (pool) await pool.end(); pool = undefined;
    if (schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); schema = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined;
    try { expect(forbiddenNetwork).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); }
  });
  afterAll(async () => { if (admin) await admin.end(); });

  function gateway(snapshot = config): Gateway {
    return new Gateway({ ledger: edge!.ledger, raw, config: { ...snapshot }, now: () => Date.now(), queue: { async send(message) { queue.push(message.deliveryId); } },
      fetch: (async (_url, init) => {
        const response = await app!.inject({ method: 'POST', url: INGEST_PATH,
          headers: Object.fromEntries(new Headers(init?.headers).entries()), payload: Buffer.from(init?.body as Uint8Array) });
        return new Response(response.rawPayload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch });
  }
  function message(): InboundMessage {
    return { from: 'sender@example.test', to: address, rawSize: rawBytes.length,
      raw: new ReadableStream({ start(controller) { controller.enqueue(rawBytes); controller.close(); } }), setReject: vi.fn() };
  }
  async function receive(worker: Gateway): Promise<string> {
    const email = message(); await worker.receive(email); expect(email.setReject).not.toHaveBeenCalled();
    return queue.at(-1)!;
  }
  async function stage(verify = true) {
    const prepared = await operator.prepareLegacy(address, actorLabel);
    await operator.stageLegacy(prepared.operationId, actorLabel);
    if (verify) await operator.verifyStaged(address, gatewayId, approvedVersion, actorLabel);
    return prepared;
  }
  async function confirmDynamic() {
    config = { ...config, routingMode: 'dynamic' };
    const inspection = await client.inspect(address);
    const confirmed = await operator.markDynamicCompatibility(address, inspection, gatewayId, approvedVersion, actorLabel);
    expect(confirmed.phase).toBe('dynamic_compatibility');
    expect((await pool!.query('SELECT phase,mailbox_id,allocation_id FROM legacy_route_cutovers WHERE address=$1', [address])).rows[0])
      .toEqual({ phase: 'dynamic_compatibility', mailbox_id: legacyMailbox, allocation_id: legacyAllocation });
    return inspection;
  }
  async function latestPolicy(): Promise<RoutePolicy> {
    return (await pool!.query<{ payload: RoutePolicy }>('SELECT payload FROM address_policy_history WHERE address=$1 ORDER BY revision DESC LIMIT 1', [address])).rows[0]!.payload;
  }
  async function signedAlteration(response: Response, change: (value: GatewayOperationResponse) => void): Promise<Response> {
    const value = await response.json() as GatewayOperationResponse;
    change(value);
    return new Response(JSON.stringify(value), { status: response.status,
      headers: await signGatewayResponse(value, value.requestId, operatorKey) });
  }

  it('stages only the selected operation with 202 and does not enable sending or publish unrelated personal policy', async () => {
    const prepared = await stage();
    expect(controlStatuses).toContain(202);
    expect((await pool!.query('SELECT status FROM address_policy_outbox WHERE operation_id=$1', [prepared.operationId])).rows[0].status).toBe('prepared');
    expect((await addresses.resolveSenderEligibility(member, legacyAllocation)).eligible).toBe(false);
    expect((await edge!.ledger.getPolicy(address))?.policy.mailboxId).toBe(legacyMailbox);
    expect(await edge!.ledger.getPolicy(otherAddress)).toBeNull();
    expect((await pool!.query('SELECT status,attempts FROM address_policy_outbox WHERE operation_id=$1', [unrelatedOperation])).rows[0]).toEqual({ status: 'pending', attempts: 0 });
    const worker = gateway();
    const id = await receive(worker);
    expect((await edge!.ledger.get(id))?.metadata.version).toBe(1);
  });

  it('retains old v1 receipts and late old-worker admission after dynamic inspection without releasing lifecycle guards', async () => {
    const oldWorker = gateway();
    const acceptedBefore = await receive(oldWorker);
    const originalInsert = edge!.ledger.insert.bind(edge!.ledger);
    let entered!: () => void; let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    let held = true;
    edge!.ledger.insert = async (record) => {
      if (held && record.metadata.version === 1) { held = false; entered(); await release; }
      return originalInsert(record);
    };
    const lateMessage = message();
    const lateAdmission = oldWorker.receive(lateMessage);
    await waiting;
    try {
      await stage();
      const inspected = await confirmDynamic();
      expect(inspected.routingMode).toBe('dynamic');
      expect(inspected.legacyPending).toBe(1); // The in-flight pre-insert invocation is not visible yet.
      await expect(addresses.removeAddress(administrator, legacyAllocation)).rejects.toMatchObject({ code: 'legacy_route_cutover_required' });
      await expect(addresses.addAddress(administrator, { address, mailboxId: ordinaryMailbox }, 'reassigned')).rejects.toMatchObject({ code: 'legacy_route_cutover_required' });
    } finally { resume(); await lateAdmission; }
    expect(lateMessage.setReject).not.toHaveBeenCalled();
    const acceptedLate = queue.at(-1)!;
    const newWorker = gateway();
    const acceptedV2 = await receive(newWorker);
    expect((await edge!.ledger.get(acceptedLate))?.metadata.version).toBe(1);
    expect((await edge!.ledger.get(acceptedV2))?.metadata.version).toBe(2);
    for (const id of [acceptedBefore, acceptedLate, acceptedV2]) {
      expect(await newWorker.deliver(id)).toEqual({ action: 'ack' });
      expect((await pool!.query('SELECT mailbox_id FROM deliveries WHERE id=$1', [id])).rows[0].mailbox_id).toBe(legacyMailbox);
      expect(objects.has(id)).toBe(false);
    }
    expect((await pool!.query('SELECT mailbox_id,enabled FROM recipient_routes WHERE address=$1', [address])).rows[0]).toEqual({ mailbox_id: legacyMailbox, enabled: true });
  });

  it('requires verified static staging and dynamic confirmation before reconciliation', async () => {
    await stage(false);
    config = { ...config, routingMode: 'dynamic' };
    await expect(operator.markDynamicCompatibility(address, await client.inspect(address), gatewayId, approvedVersion, actorLabel))
      .rejects.toMatchObject({ code: 'legacy_stage_verification_required' });
    await expect(operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel))
      .rejects.toMatchObject({ code: 'legacy_cutover_not_confirmed' });
    expect((await pool!.query('SELECT count(*) AS count FROM address_operator_plans')).rows[0].count).toBe('0');
    expect(controlKinds).not.toContain('reconcile');
    expect((await pool!.query('SELECT phase FROM legacy_route_cutovers WHERE address=$1', [address])).rows[0].phase).toBe('prepared');
  });

  it('allows an explicitly approved new dynamic deployment while preserving the first confirmation evidence', async () => {
    await stage();
    config = { ...config, routingMode: 'dynamic' };
    workerVersion = 'approved-dynamic-deployment';
    const initial = await operator.markDynamicCompatibility(address, await client.inspect(address), gatewayId, workerVersion, actorLabel);
    expect(initial.phase).toBe('dynamic_compatibility');
    const evidence = (await pool!.query('SELECT verified_at,gateway_id,worker_version,inspection_request_id,inspection_sha256,inspection FROM legacy_route_cutovers WHERE address=$1', [address])).rows[0];
    await operator.markDynamicCompatibility(address, await client.inspect(address), gatewayId, workerVersion, actorLabel);
    const repeated = (await pool!.query('SELECT verified_at,gateway_id,worker_version,inspection_request_id,inspection_sha256,inspection FROM legacy_route_cutovers WHERE address=$1', [address])).rows[0];
    expect(repeated).toEqual(evidence);
    await expect(pool!.query('UPDATE legacy_route_cutovers SET inspection_sha256=$2 WHERE address=$1', [address, '0'.repeat(64)])).rejects.toThrow();
    await expect(addresses.removeAddress(administrator, legacyAllocation)).rejects.toMatchObject({ code: 'legacy_route_cutover_required' });
  });

  it.each([{ scope: null }, { scope: [address, otherAddress] }])('refuses dynamic confirmation with a broad or absent policy allowlist: $scope', async ({ scope }) => {
    await stage();
    config = { ...config, routingMode: 'dynamic', policyAllowedAddresses: scope ?? undefined };
    await expect(operator.markDynamicCompatibility(address, await client.inspect(address), gatewayId, approvedVersion, actorLabel))
      .rejects.toMatchObject({ code: 'operator_gateway_policy_scope_mismatch' });
    expect((await pool!.query('SELECT phase FROM legacy_route_cutovers WHERE address=$1', [address])).rows[0].phase).toBe('prepared');
    expect((await addresses.resolveSenderEligibility(member, legacyAllocation)).eligible).toBe(false);
  });

  it('refuses to confirm static or unapproved-version inspections', async () => {
    await stage();
    await expect(operator.markDynamicCompatibility(address, await client.inspect(address), gatewayId, approvedVersion, actorLabel)).rejects.toThrow();
    config = { ...config, routingMode: 'dynamic' };
    workerVersion = 'unapproved-worker-version';
    await expect(operator.markDynamicCompatibility(address, await client.inspect(address), gatewayId, approvedVersion, actorLabel)).rejects.toThrow();
    await expect(addresses.removeAddress(administrator, legacyAllocation)).rejects.toMatchObject({ code: 'legacy_route_cutover_required' });
  });

  it.each(['nonce', 'stale', 'address', 'digest'] as const)('rejects an authenticated but unusable %s inspection', async (kind) => {
    await stage();
    mutateResponse = (response) => signedAlteration(response, (value) => {
      if (value.kind !== 'inspection') throw new Error('Expected an inspection');
      if (kind === 'nonce') value.requestId = randomUUID();
      if (kind === 'stale') value.inspectedAt -= 120_000;
      if (kind === 'address') { value.address = otherAddress; value.policy = null; }
      if (kind === 'digest') value.policy!.sha256 = '0'.repeat(64);
    });
    const expectedCode = kind === 'nonce' ? 'gateway_response_unverified'
      : kind === 'digest' ? 'gateway_policy_digest_mismatch' : 'gateway_inspection_mismatch';
    await expect(client.inspect(address)).rejects.toMatchObject({ code: expectedCode });
    await expect(addresses.removeAddress(administrator, legacyAllocation)).rejects.toMatchObject({ code: 'legacy_route_cutover_required' });
  });

  it('rejects unsigned body alteration and refuses requests outside the exact operator scope', async () => {
    await stage();
    mutateResponse = async (response) => {
      const value = await response.json() as GatewayInspection;
      value.routingMode = value.routingMode === 'static' ? 'dynamic' : 'static';
      return new Response(JSON.stringify(value), { status: response.status, headers: response.headers });
    };
    await expect(client.inspect(address)).rejects.toMatchObject({ code: 'gateway_response_unverified' });
    await expect(client.inspect(otherAddress)).rejects.toMatchObject({ code: 'operator_recipient_not_allowed' });
    await expect(operator.prepareLegacy(otherAddress, actorLabel)).rejects.toThrow();
  });

  it('authenticates the intended gateway before a reconcile request can mutate D1', async () => {
    await stage(); await confirmDynamic();
    const old = await latestPolicy();
    const policy = { ...old, operationId: randomUUID(), previousRevision: old.revision, revision: old.revision + 1 };
    const operation = { version: 1 as const, kind: 'reconcile' as const, requestId: randomUUID(),
      gatewayId: 'another-gateway', policy, expectedRemote: { revision: old.revision, sha256: await hashRoutePolicy(old) } };
    const request = new Request(`https://gateway.example.test${GATEWAY_OPERATION_PATH}`, { method: 'POST',
      headers: await createGatewayOperationHeaders(operation, operatorKey), body: JSON.stringify(operation) });
    const response = await handleOperationRequest(request, config, edge!.ledger, workerVersion);
    expect(response.status).toBe(403);
    const result = await verifyGatewayResponse(response.headers, new Uint8Array(await response.arrayBuffer()),
      { [operatorKey.id]: operatorKey.secret }, operation.requestId);
    expect(result).toMatchObject({ kind: 'error', error: 'gateway_identity_mismatch' });
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(old);
  });

  it('recovers a lost reconciliation ACK from fresh signed inspection without blindly resubmitting', async () => {
    await stage(); await confirmDynamic();
    const old = await latestPolicy();
    const ahead = { ...old, operationId: randomUUID(), previousRevision: old.revision + 1, revision: old.revision + 2 };
    await edge!.ledger.applyPolicy(ahead, await hashRoutePolicy(ahead), Date.now());
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    let submissions = 0;
    beforeReconcile = async () => { submissions++; };
    let loseAck = true;
    mutateResponse = async (response) => {
      const body = await response.clone().json() as GatewayOperationResponse;
      if (body.kind === 'reconciled' && loseAck) { loseAck = false; throw new Error('Simulated lost acknowledgment'); }
      return response;
    };
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toThrow();
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(plan.policy);
    expect((await pool!.query('SELECT status FROM address_operator_plans WHERE id=$1', [plan.planId])).rows[0].status).toBe('failed');
    const recovered = await operator.applyReconciliation(plan.planId, plan.digest, actorLabel);
    expect(recovered.status).toBe('applied');
    expect(submissions).toBe(1);
    expect((await pool!.query('SELECT status FROM address_policy_outbox WHERE operation_id=$1', [plan.policy.operationId])).rows[0].status).toBe('applied');
  });

  it('recovers historical admission after lost ACK, remote advance, and plan expiry without reopening sending', async () => {
    await stage(); await confirmDynamic();
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    let loseAck = true;
    mutateResponse = async (response) => {
      const body = await response.clone().json() as GatewayOperationResponse;
      if (body.kind === 'reconciled' && loseAck) { loseAck = false; throw new Error('Simulated lost acknowledgment'); }
      return response;
    };
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toThrow();
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(plan.policy);
    const worker = gateway();
    const receipt = await receive(worker);
    expect((await worker.deliver(receipt)).action).toBe('retry');
    expect(objects.has(receipt)).toBe(true);
    const newer = { ...plan.policy, operationId: randomUUID(), previousRevision: plan.policy.revision,
      revision: plan.policy.revision + 1, receiveEnabled: false };
    await edge!.ledger.applyPolicy(newer, await hashRoutePolicy(newer), Date.now());
    workerVersion = 'later-dynamic-deployment';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(plan.expiresAt + 1000));
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toMatchObject({ code: 'operator_plan_expired' });
    const localBefore = (await pool!.query('SELECT policy_revision,current_allocation_id FROM address_registry WHERE address=$1', [address])).rows[0];
    const countBefore = controlKinds.length;
    const recovered = await operator.recoverReconciliation(plan.planId, plan.digest, actorLabel);
    expect(recovered.status).toBe('recovered');
    expect(controlKinds.slice(countBefore)).toEqual(['operation-status']);
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(newer);
    expect((await pool!.query('SELECT policy_revision,current_allocation_id FROM address_registry WHERE address=$1', [address])).rows[0]).toEqual(localBefore);
    expect((await pool!.query('SELECT status FROM address_policy_outbox WHERE operation_id=$1', [plan.policy.operationId])).rows[0].status).toBe('superseded');
    expect((await addresses.resolveSenderEligibility(member, legacyAllocation)).eligible).toBe(false);
    expect(await worker.deliver(receipt)).toEqual({ action: 'ack' });
    expect((await pool!.query('SELECT mailbox_id FROM deliveries WHERE id=$1', [receipt])).rows[0].mailbox_id).toBe(legacyMailbox);
    expect((await edge!.ledger.get(receipt))?.state).toBe('done');
    expect(objects.has(receipt)).toBe(false);
    await expect(addresses.removeAddress(administrator, legacyAllocation)).rejects.toMatchObject({ code: 'legacy_route_cutover_required' });
  });

  it('refuses history recovery for an unknown remote operation or a wrong plan digest', async () => {
    await stage(); await confirmDynamic();
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    beforeReconcile = async () => { throw new Error('Transport failed before gateway submission'); };
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toThrow();
    const before = controlKinds.length;
    await expect(operator.recoverReconciliation(plan.planId, '0'.repeat(64), actorLabel)).rejects.toMatchObject({ code: 'operator_plan_digest_mismatch' });
    expect(controlKinds).toHaveLength(before);
    await expect(operator.recoverReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toMatchObject({ code: 'operator_remote_operation_not_found' });
    expect(controlKinds.slice(before)).toEqual(['operation-status']);
    expect((await pool!.query('SELECT count(*) AS count FROM address_policy_history WHERE operation_id=$1', [plan.policy.operationId])).rows[0].count).toBe('0');
    expect((await addresses.resolveSenderEligibility(member, legacyAllocation)).eligible).toBe(false);
  });

  it('refuses a signed historical record whose content digest is inconsistent', async () => {
    await stage(); await confirmDynamic();
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    mutateResponse = async (response) => {
      const body = await response.clone().json() as GatewayOperationResponse;
      if (body.kind === 'reconciled') throw new Error('Simulated lost acknowledgment');
      if (body.kind === 'operation-status') {
        return signedAlteration(response, (value) => {
          if (value.kind !== 'operation-status' || !value.record) throw new Error('Expected retained operation');
          value.record.sha256 = '0'.repeat(64);
        });
      }
      return response;
    };
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toThrow();
    await expect(operator.recoverReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toMatchObject({ code: 'gateway_policy_digest_mismatch' });
    expect((await pool!.query('SELECT count(*) AS count FROM address_policy_history WHERE operation_id=$1', [plan.policy.operationId])).rows[0].count).toBe('0');
  });

  it('refuses a reconciliation plan after the local desired policy changes', async () => {
    await stage(); await confirmDynamic();
    const old = await latestPolicy();
    const ahead = { ...old, operationId: randomUUID(), previousRevision: old.revision + 1, revision: old.revision + 2 };
    await edge!.ledger.applyPolicy(ahead, await hashRoutePolicy(ahead), Date.now());
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    const changed = { ...old, operationId: randomUUID(), previousRevision: old.revision, revision: old.revision + 1 };
    await pool!.query(`INSERT INTO address_policy_history(operation_id,address,allocation_id,mailbox_id,previous_revision,revision,receive_enabled,sha256,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [changed.operationId,address,changed.allocationId,changed.mailboxId,changed.previousRevision,changed.revision,changed.receiveEnabled,await hashRoutePolicy(changed),changed]);
    await pool!.query('INSERT INTO address_policy_outbox(operation_id) VALUES ($1)', [changed.operationId]);
    await pool!.query('UPDATE address_registry SET policy_revision=$2 WHERE address=$1', [address,changed.revision]);
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toMatchObject({ code: 'operator_local_state_changed' });
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(ahead);
    expect((await pool!.query('SELECT policy_revision FROM address_registry WHERE address=$1', [address])).rows[0].policy_revision).toBe(String(changed.revision));
  });

  it('keeps mail accepted under a concurrent remote winner retryable after reconciliation loses CAS', async () => {
    await stage(); await confirmDynamic();
    const old = await latestPolicy();
    const ahead = { ...old, operationId: randomUUID(), previousRevision: old.revision + 1, revision: old.revision + 2 };
    await edge!.ledger.applyPolicy(ahead, await hashRoutePolicy(ahead), Date.now());
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    const winner = { ...ahead, operationId: randomUUID(), previousRevision: ahead.revision, revision: ahead.revision + 1 };
    beforeReconcile = async () => { beforeReconcile = undefined; await edge!.ledger.applyPolicy(winner, await hashRoutePolicy(winner), Date.now()); };
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toMatchObject({ code: 'policy_precondition_failed' });
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(winner);
    const worker = gateway();
    const id = await receive(worker);
    expect((await worker.deliver(id)).action).toBe('retry');
    expect((await edge!.ledger.get(id))?.state).toBe('stored');
    expect(objects.has(id)).toBe(true);
    expect((await pool!.query('SELECT count(*) AS count FROM deliveries WHERE id=$1', [id])).rows[0].count).toBe('0');
  });

  it('fails remote CAS if the gateway changes between planning and application without overwriting the newer snapshot', async () => {
    await stage(); await confirmDynamic();
    const old = await latestPolicy();
    const ahead = { ...old, operationId: randomUUID(), previousRevision: old.revision + 1, revision: old.revision + 2 };
    await edge!.ledger.applyPolicy(ahead, await hashRoutePolicy(ahead), Date.now());
    const plan = await operator.planReconciliation(address, gatewayId, approvedVersion, actorLabel);
    const raced = { ...ahead, operationId: randomUUID(), previousRevision: ahead.revision, revision: ahead.revision + 1, receiveEnabled: false };
    beforeReconcile = async () => { beforeReconcile = undefined; await edge!.ledger.applyPolicy(raced, await hashRoutePolicy(raced), Date.now()); };
    await expect(operator.applyReconciliation(plan.planId, plan.digest, actorLabel)).rejects.toMatchObject({ code: 'policy_precondition_failed' });
    expect((await edge!.ledger.getPolicy(address))?.policy).toEqual(raced);
    expect((await pool!.query('SELECT mailbox_id,enabled FROM recipient_routes WHERE address=$1', [address])).rows[0]).toEqual({ mailbox_id: legacyMailbox, enabled: true });
  });
});
