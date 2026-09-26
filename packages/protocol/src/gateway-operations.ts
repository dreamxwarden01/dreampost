import { ProtocolError, sha256Hex, normalizeRecipientAddress, type SigningKey } from './index.js';
import { validateRoutePolicy, type RoutePolicy, type PolicyAck } from './policy.js';

export const GATEWAY_OPERATION_PATH = '/internal/v1/gateway-operations';
export const MAX_GATEWAY_OPERATION_BYTES = 16 * 1024;
export const MAX_GATEWAY_RESPONSE_BYTES = 128 * 1024;
export interface RemotePolicyExpectation { revision: number | null; sha256: string | null; }
export interface GatewayInspectRequest { version: 1; kind: 'inspect'; requestId: string; gatewayId: string; address: string; afterDeliveryId?: string; }
export interface GatewayReconcileRequest { version: 1; kind: 'reconcile'; requestId: string; gatewayId: string; policy: RoutePolicy; expectedRemote: RemotePolicyExpectation; }
export interface GatewayOperationStatusRequest { version: 1; kind: 'operation-status'; requestId: string; gatewayId: string; address: string; operationId: string; }
export type GatewayOperation = GatewayInspectRequest | GatewayReconcileRequest | GatewayOperationStatusRequest;
export type GatewayDeliveryState = 'receiving' | 'stored' | 'blocked' | 'delivered_pending_delete' | 'done';
export interface GatewayReceiptSummary {
  deliveryId: string; version: 1 | 2; mailboxId: string; allocationId?: string;
  routeRevision?: number; policyDigest?: string; sha256: string | null; state: GatewayDeliveryState;
  activeLease: boolean; updatedAt: number; rawSize: number;
}
export interface GatewayInspection {
  version: 1; kind: 'inspection'; requestId: string; address: string; gatewayId: string;
  workerVersion: string | null; routingMode: 'static' | 'dynamic'; inspectedAt: number;
  staticMailboxId: string | null; policyAllowedAddresses: string[] | null; policy: { policy: RoutePolicy; sha256: string } | null;
  states: Record<GatewayDeliveryState, number>; legacyPending: number; activeLeases: number;
  receipts: GatewayReceiptSummary[]; nextCursor: string | null;
}
export interface PreparedPolicyAck extends Omit<PolicyAck, 'status'> { status: 'prepared'; }
export interface GatewayReconciled { version: 1; kind: 'reconciled'; requestId: string; ack: PolicyAck; }
export interface GatewayOperationError { version: 1; kind: 'error'; requestId: string; error: string; }
export interface GatewayOperationStatus { version: 1; kind: 'operation-status'; requestId: string; address: string; gatewayId: string; workerVersion: string | null; inspectedAt: number; operationId: string; record: { policy: RoutePolicy; sha256: string; appliedAt: number } | null; }
export type GatewayOperationResponse = GatewayInspection | GatewayReconciled | GatewayOperationError | GatewayOperationStatus;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const states: GatewayDeliveryState[] = ['receiving', 'stored', 'blocked', 'delivered_pending_delete', 'done'];
type HeadersInput = Headers | Record<string, string | string[] | undefined>;
function fail(): never { throw new ProtocolError('invalid_gateway_operation', 'Invalid gateway operation or authenticated response.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}
function id(value: unknown): string { if (typeof value !== 'string' || !uuid.test(value)) fail(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !digestPattern.test(value)) fail(); return value; }
function integer(value: unknown, min = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(); return value; }
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || /[\s*]/.test(value) || normalizeRecipientAddress(value) !== value) fail(); return value;
}
export function validateRemotePolicyExpectation(value: unknown): RemotePolicyExpectation {
  const v = object(value); exact(v, ['revision', 'sha256']);
  if (v.revision === null && v.sha256 === null) return { revision: null, sha256: null };
  return { revision: integer(v.revision, 1), sha256: hash(v.sha256) };
}
export function validateGatewayOperation(value: unknown): GatewayOperation {
  const v = object(value); if (v.version !== 1) fail(); const requestId = id(v.requestId);
  if (typeof v.gatewayId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(v.gatewayId)) fail();
  const gatewayId = v.gatewayId;
  if (v.kind === 'inspect') {
    exact(v, ['version', 'kind', 'requestId', 'gatewayId', 'address'], ['afterDeliveryId']);
    return { version: 1, kind: 'inspect', requestId, gatewayId, address: address(v.address), ...(v.afterDeliveryId === undefined ? {} : { afterDeliveryId: id(v.afterDeliveryId) }) };
  }
  if (v.kind === 'operation-status') {
    exact(v, ['version', 'kind', 'requestId', 'gatewayId', 'address', 'operationId']);
    return { version: 1, kind: 'operation-status', requestId, gatewayId, address: address(v.address), operationId: id(v.operationId) };
  }
  if (v.kind === 'reconcile') {
    exact(v, ['version', 'kind', 'requestId', 'gatewayId', 'policy', 'expectedRemote']);
    return { version: 1, kind: 'reconcile', requestId, gatewayId, policy: validateRoutePolicy(v.policy), expectedRemote: validateRemotePolicyExpectation(v.expectedRemote) };
  }
  return fail();
}
export function validateGatewayInspection(value: unknown): GatewayInspection {
  const v = object(value);
  exact(v, ['version', 'kind', 'requestId', 'address', 'gatewayId', 'workerVersion', 'routingMode', 'inspectedAt', 'staticMailboxId', 'policyAllowedAddresses', 'policy', 'states', 'legacyPending', 'activeLeases', 'receipts', 'nextCursor']);
  if (v.version !== 1 || v.kind !== 'inspection' || typeof v.gatewayId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(v.gatewayId)
    || !['static', 'dynamic'].includes(String(v.routingMode)) || (v.workerVersion !== null && (typeof v.workerVersion !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(v.workerVersion)))) fail();
  if (v.policyAllowedAddresses !== null && (!Array.isArray(v.policyAllowedAddresses) || v.policyAllowedAddresses.length > 1000)) fail();
  const policyAllowedAddresses = v.policyAllowedAddresses === null ? null : (v.policyAllowedAddresses as unknown[]).map(address);
  const requestedAddress = address(v.address); const counts = object(v.states); exact(counts, states);
  for (const state of states) integer(counts[state]);
  if (!Array.isArray(v.receipts) || v.receipts.length > 50) fail();
  const receipts = v.receipts.map(item => {
    const r = object(item); exact(r, ['deliveryId', 'version', 'mailboxId', 'sha256', 'state', 'activeLease', 'updatedAt', 'rawSize'], ['allocationId', 'routeRevision', 'policyDigest']);
    if ((r.version !== 1 && r.version !== 2) || !states.includes(r.state as GatewayDeliveryState) || typeof r.activeLease !== 'boolean') fail();
    const common = { deliveryId: id(r.deliveryId), mailboxId: id(r.mailboxId), sha256: r.sha256 === null ? null : hash(r.sha256),
      state: r.state as GatewayDeliveryState, activeLease: r.activeLease, updatedAt: integer(r.updatedAt), rawSize: integer(r.rawSize, 1) };
    if (r.version === 1) { if (r.allocationId !== undefined || r.routeRevision !== undefined || r.policyDigest !== undefined) fail(); return { ...common, version: 1 as const }; }
    return { ...common, version: 2 as const, allocationId: id(r.allocationId), routeRevision: integer(r.routeRevision, 1), policyDigest: hash(r.policyDigest) };
  });
  let policy: GatewayInspection['policy'] = null;
  if (v.policy !== null) { const p = object(v.policy); exact(p, ['policy', 'sha256']); policy = { policy: validateRoutePolicy(p.policy), sha256: hash(p.sha256) }; if (policy.policy.address !== requestedAddress) fail(); }
  return { version: 1, kind: 'inspection', requestId: id(v.requestId), address: requestedAddress, gatewayId: v.gatewayId,
    workerVersion: v.workerVersion as string | null, routingMode: v.routingMode as 'static' | 'dynamic', inspectedAt: integer(v.inspectedAt),
    staticMailboxId: v.staticMailboxId === null ? null : id(v.staticMailboxId), policyAllowedAddresses, policy, states: counts as Record<GatewayDeliveryState, number>,
    legacyPending: integer(v.legacyPending), activeLeases: integer(v.activeLeases), receipts, nextCursor: v.nextCursor === null ? null : id(v.nextCursor) };
}
function header(headers: HeadersInput, name: string): string {
  const values = headers instanceof Headers ? [headers.get(name)] : Object.entries(headers).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  const value = values[0]; if (values.length !== 1 || typeof value !== 'string' || !value || value.length > 1024 || /[\r\n\x00]/.test(value)) fail(); return value;
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
async function key(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (encoder.encode(secret).length < 32) fail(); return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
const canonical = (direction: 'request' | 'response', keyId: string, timestamp: string, requestId: string, digest: string) =>
  ['dreampost-gateway-operation-v1', direction, 'POST', GATEWAY_OPERATION_PATH, 'application/json', keyId, timestamp, requestId, digest].join('\n');
async function sign(value: unknown, requestId: string, signingKey: SigningKey, direction: 'request' | 'response', nowMs: number) {
  id(requestId); if (!/^[A-Za-z0-9_-]{1,64}$/.test(signingKey.id) || !Number.isFinite(nowMs) || nowMs < 0) fail();
  const timestamp = String(Math.floor(nowMs / 1000)); const bodyDigest = await sha256Hex(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign('HMAC', await key(signingKey.secret, 'sign'), encoder.encode(canonical(direction, signingKey.id, timestamp, requestId, bodyDigest)));
  return { 'content-type': 'application/json', 'x-dreampost-operator-key-id': signingKey.id,
    'x-dreampost-operator-timestamp': timestamp, 'x-dreampost-operator-request-id': requestId,
    'x-dreampost-operator-sha256': bodyDigest, 'x-dreampost-operator-signature': base64(new Uint8Array(signature)) };
}
async function verify(headers: HeadersInput, bytes: Uint8Array, keys: Record<string, string>, direction: 'request' | 'response', options: { nowMs?: number; maxClockSkewSeconds?: number }) {
  if (bytes.length > (direction === 'request' ? MAX_GATEWAY_OPERATION_BYTES : MAX_GATEWAY_RESPONSE_BYTES)
    || header(headers, 'content-type').toLowerCase() !== 'application/json') fail();
  const keyId = header(headers, 'x-dreampost-operator-key-id'), timestamp = header(headers, 'x-dreampost-operator-timestamp');
  const requestId = id(header(headers, 'x-dreampost-operator-request-id')), bodyDigest = hash(header(headers, 'x-dreampost-operator-sha256'));
  const signature = header(headers, 'x-dreampost-operator-signature');
  const nowMs = options.nowMs ?? Date.now(), skew = options.maxClockSkewSeconds ?? 300;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || !Object.hasOwn(keys, keyId) || typeof keys[keyId] !== 'string'
    || !/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !Number.isFinite(nowMs)
    || !Number.isFinite(skew) || skew < 0 || Math.abs(nowMs / 1000 - Number(timestamp)) > skew) fail();
  const signatureBytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
  if (base64(signatureBytes) !== signature || !await crypto.subtle.verify('HMAC', await key(keys[keyId]!, 'verify'), signatureBytes,
    encoder.encode(canonical(direction, keyId, timestamp, requestId, bodyDigest)))) fail();
  if (await sha256Hex(bytes) !== bodyDigest) fail();
  let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  if (object(value).requestId !== requestId) fail(); return { value, requestId, digest: bodyDigest, keyId };
}
export async function createGatewayOperationHeaders(operation: GatewayOperation, signingKey: SigningKey, options: { nowMs?: number } = {}) {
  validateGatewayOperation(operation); return sign(operation, operation.requestId, signingKey, 'request', options.nowMs ?? Date.now());
}
export async function verifyGatewayOperation(headers: HeadersInput, raw: Uint8Array, keys: Record<string, string>, options: { nowMs?: number; maxClockSkewSeconds?: number } = {}) {
  const verified = await verify(headers, raw, keys, 'request', options); return { operation: validateGatewayOperation(verified.value), digest: verified.digest, keyId: verified.keyId };
}
export async function signGatewayResponse(value: GatewayOperationResponse, requestId: string, signingKey: SigningKey, options: { nowMs?: number } = {}) {
  if (value.requestId !== requestId) fail(); return sign(value, requestId, signingKey, 'response', options.nowMs ?? Date.now());
}
export async function verifyGatewayResponse(headers: HeadersInput, raw: Uint8Array, keys: Record<string, string>, expectedRequestId: string,
  options: { nowMs?: number; maxClockSkewSeconds?: number } = {}): Promise<GatewayOperationResponse> {
  const verified = await verify(headers, raw, keys, 'response', options);
  if (verified.requestId !== expectedRequestId) fail();
  const value = object(verified.value); if (value.version !== 1) fail();
  if (value.kind === 'inspection') return validateGatewayInspection(value);
  if (value.kind === 'operation-status') {
    exact(value, ['version', 'kind', 'requestId', 'address', 'gatewayId', 'workerVersion', 'inspectedAt', 'operationId', 'record']);
    if (typeof value.gatewayId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.gatewayId)
      || (value.workerVersion !== null && (typeof value.workerVersion !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.workerVersion)))) fail();
    const target = address(value.address), operationId = id(value.operationId);
    let record: GatewayOperationStatus['record'] = null;
    if (value.record !== null) {
      const stored = object(value.record); exact(stored, ['policy', 'sha256', 'appliedAt']);
      const policy = validateRoutePolicy(stored.policy);
      if (policy.address !== target || policy.operationId !== operationId) fail();
      record = { policy, sha256: hash(stored.sha256), appliedAt: integer(stored.appliedAt) };
    }
    return { version: 1, kind: 'operation-status', requestId: verified.requestId, address: target,
      gatewayId: value.gatewayId, workerVersion: value.workerVersion as string | null,
      inspectedAt: integer(value.inspectedAt), operationId, record };
  }
  if (value.kind === 'error') { exact(value, ['version', 'kind', 'requestId', 'error']); if (typeof value.error !== 'string' || !/^[a-z0-9_]{1,100}$/.test(value.error)) fail(); return value as unknown as GatewayOperationError; }
  if (value.kind === 'reconciled') { exact(value, ['version', 'kind', 'requestId', 'ack']); const ack = object(value.ack); exact(ack, ['version', 'operationId', 'address', 'revision', 'sha256', 'status']);
    if (ack.version !== 1 || ack.status !== 'applied') fail(); id(ack.operationId); address(ack.address); integer(ack.revision, 1); hash(ack.sha256); return value as unknown as GatewayReconciled; }
  return fail();
}
