import { describe, expect, it } from 'vitest';
import { createGatewayOperationHeaders, verifyGatewayOperation, signGatewayResponse, verifyGatewayResponse,
  hashRoutePolicy, type GatewayOperationStatus, type GatewayOperationStatusRequest, type RoutePolicy, type GatewayInspectRequest, type GatewayInspection, type GatewayOperationError } from './index.js';
const key = { id: 'operator-test', secret: 'operator-only-key-with-at-least-32-bytes' };
const nowMs = Date.parse('2026-09-26T12:00:00Z');
const request: GatewayInspectRequest = { version: 1, kind: 'inspect', requestId: '11111111-1111-4111-8111-111111111111', gatewayId: 'test-gateway', address: 'inbox@example.test' };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const inspection: GatewayInspection = { version: 1, kind: 'inspection', requestId: request.requestId, address: request.address,
  gatewayId: request.gatewayId, workerVersion: 'version-1', routingMode: 'static', inspectedAt: nowMs,
  staticMailboxId: '22222222-2222-4222-8222-222222222222', policyAllowedAddresses: ['inbox@example.test'], policy: null,
  states: { receiving: 0, stored: 0, blocked: 0, delivered_pending_delete: 0, done: 2 },
  legacyPending: 0, activeLeases: 0, receipts: [], nextCursor: null };

describe('gateway operator authentication', () => {
  it('authenticates exact bounded requests and rejects altered target/address/nonces', async () => {
    const headers = await createGatewayOperationHeaders(request, key, { nowMs });
    expect((await verifyGatewayOperation(headers, bytes(request), { [key.id]: key.secret }, { nowMs })).operation).toEqual(request);
    for (const altered of [{ ...request, gatewayId: 'other-gateway' }, { ...request, address: 'another@example.test' }, { ...request, requestId: inspection.staticMailboxId }]) {
      await expect(verifyGatewayOperation(headers, bytes(altered), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
    }
  });
  it('binds inspection replies to the fresh request and a separate response signature context', async () => {
    const headers = await signGatewayResponse(inspection, request.requestId, key, { nowMs });
    expect(await verifyGatewayResponse(headers, bytes(inspection), { [key.id]: key.secret }, request.requestId, { nowMs })).toEqual(inspection);
    await expect(verifyGatewayResponse(headers, bytes(inspection), { [key.id]: key.secret }, inspection.staticMailboxId!, { nowMs })).rejects.toThrow();
    await expect(verifyGatewayOperation(headers, bytes(inspection), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
  });
  it('rejects stale, wrong-key, oversized, or malformed responses', async () => {
    const headers = await signGatewayResponse(inspection, request.requestId, key, { nowMs });
    await expect(verifyGatewayResponse(headers, bytes(inspection), { [key.id]: key.secret }, request.requestId, { nowMs: nowMs + 301_000 })).rejects.toThrow();
    await expect(verifyGatewayResponse(headers, bytes(inspection), { [key.id]: 'b'.repeat(40) }, request.requestId, { nowMs })).rejects.toThrow();
    await expect(verifyGatewayResponse(headers, new Uint8Array(128 * 1024 + 1), { [key.id]: key.secret }, request.requestId, { nowMs })).rejects.toThrow();
    const bad = { ...inspection, states: { ...inspection.states, stored: -1 } };
    const signedBad = await signGatewayResponse(bad, request.requestId, key, { nowMs });
    await expect(verifyGatewayResponse(signedBad, bytes(bad), { [key.id]: key.secret }, request.requestId, { nowMs })).rejects.toThrow();
  });
  it('authenticates read-only historical operation lookup without granting a reconciliation write', async () => {
    const lookup: GatewayOperationStatusRequest = { ...request, kind: 'operation-status', operationId: '33333333-3333-4333-8333-333333333333' };
    const headers = await createGatewayOperationHeaders(lookup, key, { nowMs });
    expect((await verifyGatewayOperation(headers, bytes(lookup), { [key.id]: key.secret }, { nowMs })).operation).toEqual(lookup);
    const policy: RoutePolicy = { version: 1, operationId: lookup.operationId, address: lookup.address,
      allocationId: '44444444-4444-4444-8444-444444444444', mailboxId: inspection.staticMailboxId!,
      previousRevision: 2, revision: 3, receiveEnabled: true };
    const value: GatewayOperationStatus = { version: 1, kind: 'operation-status', requestId: lookup.requestId,
      address: lookup.address, gatewayId: lookup.gatewayId, workerVersion: 'version-2', inspectedAt: nowMs,
      operationId: lookup.operationId, record: { policy, sha256: await hashRoutePolicy(policy), appliedAt: nowMs - 1000 } };
    const replyHeaders = await signGatewayResponse(value, lookup.requestId, key, { nowMs });
    expect(await verifyGatewayResponse(replyHeaders, bytes(value), { [key.id]: key.secret }, lookup.requestId, { nowMs })).toEqual(value);
    const wrong = { ...value, operationId: inspection.staticMailboxId! };
    const wrongHeaders = await signGatewayResponse(wrong, lookup.requestId, key, { nowMs });
    await expect(verifyGatewayResponse(wrongHeaders, bytes(wrong), { [key.id]: key.secret }, lookup.requestId, { nowMs })).rejects.toThrow();
    await expect(verifyGatewayOperation(headers, bytes({ ...lookup, kind: 'reconcile' }), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
  });

  it('authenticates bounded error codes without accepting arbitrary extra response fields', async () => {
    const failure: GatewayOperationError = { version: 1, kind: 'error', requestId: request.requestId, error: 'policy_precondition_failed' };
    const headers = await signGatewayResponse(failure, request.requestId, key, { nowMs });
    expect(await verifyGatewayResponse(headers, bytes(failure), { [key.id]: key.secret }, request.requestId, { nowMs })).toEqual(failure);
    const bad = { ...failure, body: 'not-operator-data' }; const badHeaders = await signGatewayResponse(bad, request.requestId, key, { nowMs });
    await expect(verifyGatewayResponse(badHeaders, bytes(bad), { [key.id]: key.secret }, request.requestId, { nowMs })).rejects.toThrow();
  });
});
