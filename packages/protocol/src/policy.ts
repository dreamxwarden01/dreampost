import { ProtocolError, sha256Hex, type SigningKey } from './index.js';

export const POLICY_PATH = '/internal/v1/recipient-policies';
export const MAX_POLICY_BYTES = 16 * 1024;
export interface RoutePolicy {
  version: 1;
  operationId: string;
  address: string;
  allocationId: string;
  mailboxId: string;
  previousRevision: number;
  revision: number;
  receiveEnabled: boolean;
}
export interface PolicyAck {
  version: 1;
  operationId: string;
  address: string;
  revision: number;
  sha256: string;
  status: 'applied';
}
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const keyId = /^[A-Za-z0-9_-]{1,64}$/;
const fields = ['version', 'operationId', 'address', 'allocationId', 'mailboxId', 'previousRevision', 'revision', 'receiveEnabled'];
type HeadersInput = Headers | Record<string, string | string[] | undefined>;
function fail(): never { throw new ProtocolError('invalid_policy', 'Invalid recipient policy or authorization.'); }
export function validateRoutePolicy(value: unknown): RoutePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(field => !fields.includes(field))
    || v.version !== 1 || typeof v.operationId !== 'string' || !uuid.test(v.operationId)
    || typeof v.allocationId !== 'string' || !uuid.test(v.allocationId)
    || typeof v.mailboxId !== 'string' || !uuid.test(v.mailboxId)
    || typeof v.address !== 'string' || v.address !== v.address.toLowerCase()
    || v.address.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(v.address)
    || typeof v.previousRevision !== 'number' || !Number.isSafeInteger(v.previousRevision) || v.previousRevision < 0
    || typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision !== v.previousRevision + 1
    || typeof v.receiveEnabled !== 'boolean') fail();
  const [local, domain] = v.address.split('@');
  if (!local || local.includes('*') || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !domain || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail();
  return { version: 1, operationId: v.operationId, address: v.address, allocationId: v.allocationId,
    mailboxId: v.mailboxId, previousRevision: v.previousRevision, revision: v.revision, receiveEnabled: v.receiveEnabled };
}
export async function hashRoutePolicy(policy: RoutePolicy): Promise<string> {
  return sha256Hex(encoder.encode(JSON.stringify(validateRoutePolicy(policy))));
}
function header(headers: HeadersInput, name: string): string {
  const matches = headers instanceof Headers ? [headers.get(name)]
    : Object.entries(headers).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  const value = matches[0];
  if (matches.length !== 1 || typeof value !== 'string' || value.length > 1024 || !value || /[\r\n\x00]/.test(value)) fail();
  return value;
}
function canonical(id: string, timestamp: string, attempt: string, bodyDigest: string): string {
  return ['dreampost-policy-v1', 'POST', POLICY_PATH, 'application/json', id, timestamp, attempt, bodyDigest].join('\n');
}
async function hmac(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) fail();
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function createPolicyHeaders(policy: RoutePolicy, key: SigningKey,
  options: { nowMs?: number; attemptId?: string } = {}): Promise<Record<string, string>> {
  if (!keyId.test(key.id)) fail();
  const now = options.nowMs ?? Date.now();
  const attempt = options.attemptId ?? crypto.randomUUID();
  if (!Number.isFinite(now) || now < 0 || !uuid.test(attempt)) fail();
  const timestamp = String(Math.floor(now / 1000));
  const bodyDigest = await hashRoutePolicy(policy);
  const signature = await crypto.subtle.sign('HMAC', await hmac(key.secret, 'sign'), encoder.encode(canonical(key.id, timestamp, attempt, bodyDigest)));
  return { 'content-type': 'application/json', 'x-dreampost-policy-key-id': key.id,
    'x-dreampost-policy-timestamp': timestamp, 'x-dreampost-policy-attempt-id': attempt,
    'x-dreampost-policy-sha256': bodyDigest, 'x-dreampost-policy-signature': base64(new Uint8Array(signature)) };
}
export async function verifyPolicyRequest(headers: HeadersInput, raw: Uint8Array, keys: Record<string, string>,
  options: { nowMs?: number; maxClockSkewSeconds?: number } = {}): Promise<{ policy: RoutePolicy; digest: string }> {
  if (raw.byteLength > MAX_POLICY_BYTES || header(headers, 'content-type').toLowerCase() !== 'application/json') fail();
  const id = header(headers, 'x-dreampost-policy-key-id');
  const timestamp = header(headers, 'x-dreampost-policy-timestamp');
  const attempt = header(headers, 'x-dreampost-policy-attempt-id');
  const bodyDigest = header(headers, 'x-dreampost-policy-sha256');
  const signature = header(headers, 'x-dreampost-policy-signature');
  if (!keyId.test(id) || !Object.hasOwn(keys, id) || !/^\d{1,12}$/.test(timestamp)
    || !uuid.test(attempt) || !digest.test(bodyDigest) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) fail();
  const skew = options.maxClockSkewSeconds ?? 300;
  const now = options.nowMs ?? Date.now();
  if (!Number.isFinite(now) || !Number.isFinite(skew) || skew < 0 || Math.abs(now / 1000 - Number(timestamp)) > skew) fail();
  const decodedSignature = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
  if (base64(decodedSignature) !== signature || typeof keys[id] !== 'string') fail();
  if (!await crypto.subtle.verify('HMAC', await hmac(keys[id], 'verify'), decodedSignature,
    encoder.encode(canonical(id, timestamp, attempt, bodyDigest)))) fail();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail(); }
  const policy = validateRoutePolicy(value);
  if (await hashRoutePolicy(policy) !== bodyDigest) fail();
  return { policy, digest: bodyDigest };
}
export function matchesPolicyAck(value: unknown, expected: RoutePolicy & { sha256: string }): value is PolicyAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ack = value as Record<string, unknown>;
  return ack.version === 1 && ack.status === 'applied' && ack.operationId === expected.operationId
    && ack.address === expected.address && ack.revision === expected.revision && ack.sha256 === expected.sha256;
}
