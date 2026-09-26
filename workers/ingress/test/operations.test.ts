import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayOperationHeaders, createPolicyHeaders, GATEWAY_OPERATION_PATH, hashRoutePolicy,
  matchesPolicyAck, MAX_GATEWAY_OPERATION_BYTES, POLICY_PATH, verifyGatewayResponse,
  type DeliveryMetadata, type GatewayOperation, type GatewayInspection, type RoutePolicy,
} from '@dreampost/protocol';
import { readConfig, type GatewayConfig } from '../src/config.js';
import { Gateway, LEASE_MS } from '../src/core.js';
import { handleOperationRequest } from '../src/operations.js';
import { handlePolicyRequest } from '../src/policies.js';
import type { DeliveryRecord, DeliveryState, InboundMessage, StoredRaw } from '../src/model.js';
import { sqliteLedger } from './helpers/sqlite-ledger.js';

const mailbox = '11111111-1111-4111-8111-111111111111';
const otherMailbox = '22222222-2222-4222-8222-222222222222';
const allocation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = Date.parse('2026-09-26T12:00:00Z');
const gatewayId = 'gateway-test-identity';
const operatorKey = { id: 'operator', secret: 'operator-test-secret-at-least-32-bytes' };
const policyKey = { id: 'policy', secret: 'policy-test-secret-at-least-32-bytes' };
const ingestKey = { id: 'ingest', secret: 'ingest-test-secret-at-least-32-bytes' };
const contexts: ReturnType<typeof sqliteLedger>[] = [];
afterEach(() => { for (const context of contexts.splice(0)) context.close(); });
function context() { const db = sqliteLedger(); contexts.push(db); return db; }
function config(): GatewayConfig {
  return { routes: { 'inbox@example.test': mailbox }, backendUrl: 'https://api.example.test/internal/v1/deliveries',
    key: ingestKey, doneRetentionDays: 7, routingMode: 'dynamic', policyKeys: { [policyKey.id]: policyKey.secret },
    allowedPolicyDomains: ['example.test'], policyAllowedAddresses: ['inbox@example.test'],
    operator: { keys: { [operatorKey.id]: operatorKey.secret }, allowedAddresses: ['inbox@example.test'], gatewayId } };
}
function policy(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
  return { version: 1, operationId: randomUUID(), address: 'inbox@example.test', allocationId: allocation,
    mailboxId: mailbox, previousRevision: 0, revision: 1, receiveEnabled: true, ...overrides };
}
const inspect = (address = 'inbox@example.test', afterDeliveryId?: string): GatewayOperation => ({
  version: 1, kind: 'inspect', requestId: randomUUID(), gatewayId, address,
  ...(afterDeliveryId ? { afterDeliveryId } : {}),
});
async function operationRequest(operation: GatewayOperation, signingKey = operatorKey, signedAt = now): Promise<Request> {
  return new Request(`https://gateway.example.test${GATEWAY_OPERATION_PATH}`, { method: 'POST', body: JSON.stringify(operation),
    headers: await createGatewayOperationHeaders(operation, signingKey, { nowMs: signedAt }) });
}
async function invoke(operation: GatewayOperation, ledger: ReturnType<typeof context>['ledger'], settings = config()) {
  const response = await handleOperationRequest(await operationRequest(operation), settings, ledger, 'version-test', () => now);
  const result = await verifyGatewayResponse(response.headers, new Uint8Array(await response.arrayBuffer()),
    settings.operator!.keys, operation.requestId, { nowMs: now });
  return { status: response.status, result };
}
async function apply(ledger: ReturnType<typeof context>['ledger'], value: RoutePolicy) {
  return ledger.applyPolicy(value, await hashRoutePolicy(value), now);
}
async function policyRequest(value: RoutePolicy) {
  return new Request(`https://gateway.example.test${POLICY_PATH}`, { method: 'POST', body: JSON.stringify(value),
    headers: await createPolicyHeaders(value, policyKey, { nowMs: now }) });
}
function record(id: string, state: DeliveryState = 'stored', target = 'inbox@example.test'): DeliveryRecord {
  const metadata: DeliveryMetadata = { version: 1, deliveryId: id, mailboxId: mailbox, envelopeTo: target,
    envelopeFrom: 'private-sender@example.test', receivedAt: new Date(now).toISOString(), rawSize: 5 };
  return { deliveryId: id, metadata, state, sha256: state === 'receiving' ? null : 'a'.repeat(64), createdAt: now,
    updatedAt: now, nextAttemptAt: now, lastEnqueuedAt: null, leaseToken: null, leaseUntil: null, attempts: 0, lastError: null };
}

describe('static preload and scoped admission', () => {
  it('prepares only the existing enabled static target and never returns an applied ACK before dynamic mode', async () => {
    const { ledger } = context();
    const settings = { ...config(), routingMode: 'static' as const, allowStaticPreload: true };
    const value = policy();
    const response = await handlePolicyRequest(await policyRequest(value), settings, ledger, () => now);
    expect(response.status).toBe(202);
    const prepared = await response.json();
    expect(prepared).toMatchObject({ status: 'prepared', operationId: value.operationId, revision: 1 });
    expect(matchesPolicyAck(prepared, { ...value, sha256: await hashRoutePolicy(value) })).toBe(false);
    expect((await ledger.getPolicy(value.address))?.policy).toEqual(value);
    const active = await handlePolicyRequest(await policyRequest(value), { ...settings, routingMode: 'dynamic' }, ledger, () => now);
    expect(active.status).toBe(200);
    expect(matchesPolicyAck(await active.json(), { ...value, sha256: await hashRoutePolicy(value) })).toBe(true);
  });
  it('rejects static disabling, target remapping, and addresses outside the exact preload scope', async () => {
    const { ledger } = context();
    const settings = { ...config(), routingMode: 'static' as const, allowStaticPreload: true };
    for (const value of [policy({ receiveEnabled: false }), policy({ mailboxId: otherMailbox }), policy({ address: 'other@example.test' })]) {
      expect((await handlePolicyRequest(await policyRequest(value), settings, ledger, () => now)).status).toBe(403);
    }
    const scoped = await handlePolicyRequest(await policyRequest(policy({ address: 'other@example.test' })), settings, ledger, () => now);
    expect(await scoped.json()).toEqual({ error: 'policy_address_not_allowed' });
    expect(await ledger.getPolicy('inbox@example.test')).toBeNull();
  });
  it('restricts dynamic policy/admission without altering static admission for other configured legacy routes', async () => {
    const { ledger } = context();
    const settings = config();
    settings.routes['other@example.test'] = otherMailbox;
    const excluded = policy({ address: 'other@example.test', mailboxId: otherMailbox });
    const rejected = await handlePolicyRequest(await policyRequest(excluded), settings, ledger, () => now);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'policy_address_not_allowed' });
    await apply(ledger, excluded);
    const objects = new Map<string, StoredRaw>();
    const worker = new Gateway({ ledger, config: settings, now: () => now, fetch: vi.fn() as typeof fetch,
      queue: { async send() {} }, raw: { async put(id, bytes, metadata, sha256) { objects.set(id, { bytes, metadata, sha256 }); },
        async get(id) { return objects.get(id) ?? null; }, async delete(id) { objects.delete(id); } } });
    const message = (): InboundMessage => ({ from: 'sender@example.test', to: 'other@example.test', rawSize: 5,
      raw: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('hello')); controller.close(); } }), setReject: vi.fn() });
    const dynamic = message(); await worker.receive(dynamic);
    expect(dynamic.setReject).toHaveBeenCalledOnce(); expect(objects.size).toBe(0);
    settings.routingMode = 'static';
    const legacy = message(); await worker.receive(legacy);
    expect(legacy.setReject).not.toHaveBeenCalled(); expect(objects.size).toBe(1);
    expect(([...objects.values()][0]!.metadata as DeliveryMetadata).version).toBe(1);
  });
});

describe('authenticated gateway inspection', () => {
  it('requires separate operator authentication and binds the intended gateway identity', async () => {
    const { ledger } = context();
    const settings = config();
    const operation = inspect();
    for (const request of [new Request(`https://gateway.example.test${GATEWAY_OPERATION_PATH}`, { method: 'POST', body: '{}' }),
      await operationRequest(operation, policyKey), await operationRequest(operation, operatorKey, now - 600_000)]) {
      expect((await handleOperationRequest(request, settings, ledger, null, () => now)).status).toBe(401);
    }
    const result = await invoke({ ...operation, gatewayId: 'different-gateway' }, ledger);
    expect(result.status).toBe(403);
    expect(result.result).toMatchObject({ kind: 'error', error: 'gateway_identity_mismatch' });
  });
  it('signs scoped denials and rejects response replay under a different request nonce', async () => {
    const { ledger } = context();
    const request = inspect('other@example.test');
    const response = await handleOperationRequest(await operationRequest(request), config(), ledger, null, () => now);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(403);
    expect(await verifyGatewayResponse(response.headers, bytes, config().operator!.keys, request.requestId, { nowMs: now }))
      .toMatchObject({ kind: 'error', error: 'operator_address_not_allowed' });
    await expect(verifyGatewayResponse(response.headers, bytes, config().operator!.keys, randomUUID(), { nowMs: now })).rejects.toThrow();
  });
  it('bounds unauthenticated request bodies and signs database-unavailable errors after authentication', async () => {
    const { ledger } = context();
    const response = await handleOperationRequest(new Request(`https://gateway.example.test${GATEWAY_OPERATION_PATH}`,
      { method: 'POST', body: 'x'.repeat(MAX_GATEWAY_OPERATION_BYTES + 1) }), config(), ledger, null, () => now);
    expect(response.status).toBe(413);
    vi.spyOn(ledger, 'inspectRecipient').mockRejectedValueOnce(new Error('database unavailable'));
    const failed = await invoke(inspect(), ledger);
    expect(failed.status).toBe(503);
    expect(failed.result).toMatchObject({ kind: 'error', error: 'operator_temporarily_unavailable' });
  });
  it('returns coherent counts and bounded receipt metadata in either mode without exposing sender data or mutating receipts', async () => {
    const { ledger, sql } = context();
    const value = policy(); await apply(ledger, value);
    const states: DeliveryState[] = ['receiving', 'stored', 'blocked', 'delivered_pending_delete', 'done'];
    for (const state of states) {
      const row = record(randomUUID(), state);
      if (state === 'receiving') { row.leaseToken = randomUUID(); row.leaseUntil = now + LEASE_MS; }
      await ledger.insert(row);
    }
    const version2 = record(randomUUID());
    version2.metadata = { ...version2.metadata, version: 2, allocationId: allocation, routeRevision: 1, policyDigest: await hashRoutePolicy(value) };
    await ledger.insert(version2);
    await ledger.insert(record(randomUUID(), 'stored', 'other@example.test'));
    const before = sql.prepare('SELECT * FROM deliveries ORDER BY delivery_id').all();
    for (const mode of ['static', 'dynamic'] as const) {
      const { status, result } = await invoke(inspect(), ledger, { ...config(), routingMode: mode });
      expect(status).toBe(200);
      expect(result).toMatchObject({ kind: 'inspection', gatewayId, workerVersion: 'version-test', routingMode: mode,
        inspectedAt: now, policyAllowedAddresses: ['inbox@example.test'], staticMailboxId: mailbox, states: { receiving: 1, stored: 2, blocked: 1, delivered_pending_delete: 1, done: 1 },
        legacyPending: 4, activeLeases: 1 });
      const inspection = result as GatewayInspection;
      expect(inspection.receipts).toHaveLength(6);
      expect(inspection.policy?.sha256).toBe(await hashRoutePolicy(value));
      expect(JSON.stringify(inspection)).not.toContain('private-sender');
      expect(JSON.stringify(inspection)).not.toContain('metadata_json');
    }
    expect(sql.prepare('SELECT * FROM deliveries ORDER BY delivery_id').all()).toEqual(before);
  });
  it('paginates at fifty receipts while keeping counts scoped to the entire requested address', async () => {
    const { ledger } = context();
    for (let i = 1; i <= 53; i++) await ledger.insert(record(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    await ledger.insert(record(randomUUID(), 'blocked', 'other@example.test'));
    const first = (await invoke(inspect(), ledger)).result as GatewayInspection;
    expect(first.receipts).toHaveLength(50); expect(first.states.stored).toBe(53); expect(first.states.blocked).toBe(0);
    expect(first.nextCursor).toBe(first.receipts[49]!.deliveryId);
    const second = (await invoke(inspect('inbox@example.test', first.nextCursor!), ledger)).result as GatewayInspection;
    expect(second.receipts).toHaveLength(3); expect(second.nextCursor).toBeNull(); expect(second.states.stored).toBe(53);
    expect(new Set([...first.receipts, ...second.receipts].map(row => row.deliveryId)).size).toBe(53);
  });
});

describe('historical operation status', () => {
  const statusRequest = (operationId: string, address = 'inbox@example.test'): GatewayOperation => ({
    version: 1, kind: 'operation-status', requestId: randomUUID(), gatewayId, address, operationId,
  });
  it('returns authenticated retained evidence after a newer policy without writing or reverting state', async () => {
    const { ledger, sql } = context();
    const old = policy();
    await ledger.applyPolicy(old, await hashRoutePolicy(old), now - 10_000);
    const newer = policy({ previousRevision: 5, revision: 6, receiveEnabled: false });
    await apply(ledger, newer);
    const before = sql.prepare('SELECT * FROM recipient_policy_operations ORDER BY operation_id').all();
    const response = await invoke(statusRequest(old.operationId), ledger);
    expect(response.status).toBe(200);
    expect(response.result).toMatchObject({ kind: 'operation-status', address: old.address, gatewayId,
      workerVersion: 'version-test', inspectedAt: now, operationId: old.operationId,
      record: { policy: old, sha256: await hashRoutePolicy(old), appliedAt: now - 10_000 } });
    expect((await ledger.getPolicy(old.address))?.policy).toEqual(newer);
    expect(sql.prepare('SELECT * FROM recipient_policy_operations ORDER BY operation_id').all()).toEqual(before);
  });
  it('returns null for unknown operations or an operation belonging to a different authorized address', async () => {
    const { ledger } = context();
    const old = policy(); await apply(ledger, old);
    expect((await invoke(statusRequest(randomUUID()), ledger)).result).toMatchObject({ kind: 'operation-status', record: null });
    const settings = config(); settings.operator!.allowedAddresses.push('other@example.test');
    expect((await invoke(statusRequest(old.operationId, 'other@example.test'), ledger, settings)).result)
      .toMatchObject({ kind: 'operation-status', address: 'other@example.test', record: null });
  });
  it('enforces gateway identity and exact address scope before historical lookup', async () => {
    const { ledger } = context();
    const read = vi.spyOn(ledger, 'getAppliedOperation');
    const scoped = await invoke(statusRequest(randomUUID(), 'other@example.test'), ledger);
    expect(scoped.status).toBe(403);
    const wrongGateway = await invoke({ ...statusRequest(randomUUID()), gatewayId: 'not-this-gateway' }, ledger);
    expect(wrongGateway.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects tampered response bytes and refuses inconsistent stored policy digests', async () => {
    const { ledger, sql } = context();
    const old = policy(); await apply(ledger, old);
    const operation = statusRequest(old.operationId);
    const response = await handleOperationRequest(await operationRequest(operation), config(), ledger, 'version-test', () => now);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const modified = JSON.parse(new TextDecoder().decode(bytes)); modified.record.policy.receiveEnabled = false;
    await expect(verifyGatewayResponse(response.headers, new TextEncoder().encode(JSON.stringify(modified)),
      config().operator!.keys, operation.requestId, { nowMs: now })).rejects.toThrow();
    sql.prepare('UPDATE recipient_policy_operations SET policy_digest = ? WHERE operation_id = ?').run('0'.repeat(64), old.operationId);
    const inconsistent = await invoke(statusRequest(old.operationId), ledger);
    expect(inconsistent.status).toBe(503);
    expect(inconsistent.result).toMatchObject({ kind: 'error', error: 'operator_temporarily_unavailable' });
  });
});

describe('operator reconciliation CAS', () => {
  it('checks both remote revision and digest in the write transaction and refuses stale observations', async () => {
    const { ledger } = context();
    const initial = policy({ previousRevision: 2, revision: 3 }); await apply(ledger, initial);
    const observed = (await ledger.inspectRecipient(initial.address, undefined, now)).policy!;
    const concurrent = policy({ previousRevision: 3, revision: 4, receiveEnabled: false }); await apply(ledger, concurrent);
    const proposed = policy({ previousRevision: 4, revision: 5 });
    const operation: GatewayOperation = { version: 1, kind: 'reconcile', requestId: randomUUID(), gatewayId, policy: proposed,
      expectedRemote: { revision: observed.policy.revision, sha256: observed.sha256 } };
    const response = await invoke(operation, ledger);
    expect(response.status).toBe(409); expect(response.result).toMatchObject({ kind: 'error', error: 'policy_precondition_failed' });
    expect((await ledger.getPolicy(initial.address))?.policy).toEqual(concurrent);
    const wrongDigest = await invoke({ ...operation, requestId: randomUUID(), expectedRemote: { revision: 4, sha256: '0'.repeat(64) } }, ledger);
    expect(wrongDigest.status).toBe(409);
    const success = await invoke({ ...operation, requestId: randomUUID(), expectedRemote: { revision: 4, sha256: await hashRoutePolicy(concurrent) } }, ledger);
    expect(success.status).toBe(200); expect(success.result).toMatchObject({ kind: 'reconciled', ack: { operationId: proposed.operationId, revision: 5 } });
  });
  it('supports expect-absent and exact historical retry without overwriting later policies', async () => {
    const { ledger } = context();
    const proposed = policy({ previousRevision: 5, revision: 6 });
    const operation: GatewayOperation = { version: 1, kind: 'reconcile', requestId: randomUUID(), gatewayId,
      policy: proposed, expectedRemote: { revision: null, sha256: null } };
    expect((await invoke(operation, ledger)).status).toBe(200);
    const later = policy({ previousRevision: 6, revision: 7, receiveEnabled: false }); await apply(ledger, later);
    expect((await invoke({ ...operation, requestId: randomUUID() }, ledger)).status).toBe(200);
    expect((await ledger.getPolicy(later.address))?.policy).toEqual(later);
    const unexpected = policy({ previousRevision: 7, revision: 8 });
    expect((await invoke({ ...operation, requestId: randomUUID(), policy: unexpected }, ledger)).status).toBe(409);
  });
  it('does not reconcile static admission or bypass the policy exact-address scope', async () => {
    const { ledger } = context();
    const operation: GatewayOperation = { version: 1, kind: 'reconcile', requestId: randomUUID(), gatewayId,
      policy: policy(), expectedRemote: { revision: null, sha256: null } };
    expect((await invoke(operation, ledger, { ...config(), routingMode: 'static' })).result)
      .toMatchObject({ kind: 'error', error: 'gateway_not_dynamic' });
    expect((await invoke(operation, ledger, { ...config(), policyAllowedAddresses: ['different@example.test'] })).status).toBe(403);
    expect(await ledger.getPolicy('inbox@example.test')).toBeNull();
  });
});

describe('operator and preload configuration', () => {
  const vars = { RECIPIENT_ROUTES_JSON: JSON.stringify(config().routes), BACKEND_INGEST_URL: config().backendUrl,
    INGEST_KEY_ID: ingestKey.id, INGEST_SECRET: ingestKey.secret };
  it('keeps static behavior unchanged unless preload is explicitly scoped and authenticated', () => {
    expect(readConfig(vars).operator).toBeUndefined(); expect(readConfig(vars).allowStaticPreload).toBe(false);
    expect(() => readConfig({ ...vars, POLICY_ALLOW_STATIC_PRELOAD: 'true' })).toThrow();
    const valid = { ...vars, POLICY_ALLOW_STATIC_PRELOAD: 'true', POLICY_ALLOWED_ADDRESSES_JSON: '["inbox@example.test"]',
      POLICY_KEYS_JSON: JSON.stringify({ [policyKey.id]: policyKey.secret }), POLICY_ALLOWED_DOMAINS_JSON: '["example.test"]' };
    expect(readConfig(valid).allowStaticPreload).toBe(true);
    expect(() => readConfig({ ...valid, POLICY_ALLOWED_ADDRESSES_JSON: '["inbox@outside.test"]' })).toThrow();
  });
  it('requires an explicit policy address scope when dynamic routing and operator control are both enabled', async () => {
    const dynamic = { ...vars, ROUTING_MODE: 'dynamic', POLICY_KEYS_JSON: JSON.stringify({ [policyKey.id]: policyKey.secret }),
      POLICY_ALLOWED_DOMAINS_JSON: '["example.test"]', OPERATOR_KEYS_JSON: JSON.stringify({ [operatorKey.id]: operatorKey.secret }),
      OPERATOR_ALLOWED_ADDRESSES_JSON: '["inbox@example.test"]', GATEWAY_ID: gatewayId };
    expect(() => readConfig(dynamic)).toThrow('exact policy address scope');
    expect(() => readConfig({ ...dynamic, POLICY_ALLOWED_ADDRESSES_JSON: '[]' })).toThrow();
    const settings = readConfig({ ...dynamic, POLICY_ALLOWED_ADDRESSES_JSON: '["inbox@example.test"]' });
    expect(settings.policyAllowedAddresses).toEqual(['inbox@example.test']);
    const { ledger } = context();
    expect((await invoke(inspect(), ledger, settings)).result).toMatchObject({ policyAllowedAddresses: ['inbox@example.test'] });
    const broadStatic = { ...config(), routingMode: 'static' as const, policyAllowedAddresses: undefined };
    expect((await invoke(inspect(), ledger, broadStatic)).result).toMatchObject({ policyAllowedAddresses: null });
  });
  it('requires a bounded identity, exact operator scope, and credentials separate from ingestion/policy keys', () => {
    const valid = { ...vars, OPERATOR_KEYS_JSON: JSON.stringify({ [operatorKey.id]: operatorKey.secret }),
      OPERATOR_ALLOWED_ADDRESSES_JSON: '["inbox@example.test"]', GATEWAY_ID: gatewayId };
    expect(readConfig(valid).operator?.gatewayId).toBe(gatewayId);
    expect(() => readConfig({ ...valid, GATEWAY_ID: '' })).toThrow();
    expect(() => readConfig({ ...valid, OPERATOR_ALLOWED_ADDRESSES_JSON: '["*@example.test"]' })).toThrow();
    expect(() => readConfig({ ...valid, OPERATOR_KEYS_JSON: JSON.stringify({ reused: ingestKey.secret }) })).toThrow();
    expect(() => readConfig({ ...valid, POLICY_KEYS_JSON: JSON.stringify({ [policyKey.id]: policyKey.secret }),
      OPERATOR_KEYS_JSON: JSON.stringify({ reused: policyKey.secret }) })).toThrow();
    expect(() => readConfig({ ...valid, ROUTING_MODE: 'dynamic', POLICY_KEYS_JSON: JSON.stringify({ [policyKey.id]: policyKey.secret }),
      POLICY_ALLOWED_DOMAINS_JSON: '["example.test"]', OPERATOR_KEYS_JSON: JSON.stringify({ reused: policyKey.secret }) })).toThrow();
  });
});
