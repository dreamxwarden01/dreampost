export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
export const CLOUDFLARE_OUTBOUND_MAX_BYTES = 5 * 1024 * 1024;
export const INGEST_PATH = '/internal/v1/deliveries';

export interface DeliveryMetadata {
  version: 1;
  deliveryId: string;
  mailboxId: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: string;
  rawSize: number;
}

export interface DeliveryAck {
  version: 1;
  deliveryId: string;
  sha256: string;
  status: 'stored';
}

export interface SigningKey { id: string; secret: string }
export interface VerifiedDelivery {
  metadata: DeliveryMetadata;
  sha256: string;
  attemptId: string;
  keyId: string;
}

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export interface BlobStore {
  put(sha256: string, raw: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Uint8Array>;
}

export interface TransportCapabilities {
  maxMessageBytes: number;
  maxRecipients: number;
  supportsIdempotencyKey: boolean;
}
export interface OutboundSubmission {
  submissionId: string;
  envelopeFrom: string;
  recipients: string[];
  mime: Uint8Array;
}
export interface OutboundResult {
  providerMessageId?: string;
  recipients: Array<{ address: string; status: 'accepted' | 'failed' | 'unknown'; code?: string }>;
}
/** Callers must enforce current sending-identity authorization before submission. */
export interface MailTransport {
  readonly capabilities: TransportCapabilities;
  send(submission: OutboundSubmission): Promise<OutboundResult>;
}

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const keyIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const metadataKeys = ['version', 'deliveryId', 'mailboxId', 'envelopeFrom', 'envelopeTo', 'receivedAt', 'rawSize'];
const h = {
  metadata: 'x-dreampost-metadata',
  digest: 'x-dreampost-sha256',
  keyId: 'x-dreampost-key-id',
  timestamp: 'x-dreampost-timestamp',
  attempt: 'x-dreampost-attempt-id',
  signature: 'x-dreampost-signature',
};

type HeaderInput = Headers | Record<string, string | string[] | undefined>;

function fail(code: string, message: string): never {
  throw new ProtocolError(code, message);
}

function address(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f<>]/.test(value)) return false;
  if (allowEmpty && value === '') return true;
  const at = value.lastIndexOf('@');
  return at > 0 && at < value.length - 1 && !/\s/.test(value.slice(at + 1));
}

/** Hosted recipient lookup is case-insensitive; retain the original envelope separately. */
export function normalizeRecipientAddress(value: string): string {
  if (!address(value, false)) fail('invalid_metadata', 'Invalid recipient address.');
  return value.toLowerCase();
}

export function validateMetadata(value: unknown): DeliveryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_metadata', 'Delivery metadata must be an object.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== metadataKeys.length || Object.keys(v).some(key => !metadataKeys.includes(key))) fail('invalid_metadata', 'Unexpected delivery metadata fields.');
  if (v.version !== 1 || typeof v.deliveryId !== 'string' || !uuid.test(v.deliveryId) || typeof v.mailboxId !== 'string' || !uuid.test(v.mailboxId)) fail('invalid_metadata', 'Unsupported version or invalid delivery identity.');
  if (!address(v.envelopeFrom, true) || !address(v.envelopeTo, false)) fail('invalid_metadata', 'Invalid envelope address.');
  if (typeof v.receivedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.receivedAt) || !Number.isFinite(Date.parse(v.receivedAt))) fail('invalid_metadata', 'Invalid receipt timestamp.');
  const canonicalReceipt = v.receivedAt.includes('.')
    ? v.receivedAt.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, '0')}Z`)
    : v.receivedAt.replace(/Z$/, '.000Z');
  if (new Date(v.receivedAt).toISOString() !== canonicalReceipt) fail('invalid_metadata', 'Receipt timestamp is not a valid calendar date.');
  if (typeof v.rawSize !== 'number' || !Number.isSafeInteger(v.rawSize) || v.rawSize < 1 || v.rawSize > MAX_INBOUND_BYTES) fail('invalid_metadata', 'Message size exceeds the supported range.');
  return {
    version: 1, deliveryId: v.deliveryId, mailboxId: v.mailboxId,
    envelopeFrom: v.envelopeFrom, envelopeTo: v.envelopeTo,
    receivedAt: v.receivedAt, rawSize: v.rawSize,
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('invalid_header', 'Invalid base64url header.');
  try {
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) fail('invalid_header', 'Noncanonical base64url header.');
    return bytes;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    return fail('invalid_header', 'Malformed base64url header.');
  }
}

function getHeader(headers: HeaderInput, name: string): string {
  let value: unknown;
  if (typeof (headers as Headers).get === 'function') value = (headers as Headers).get(name);
  else {
    const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
    if (matches.length !== 1) fail('invalid_header', 'Missing or repeated delivery header.');
    value = matches[0]?.[1];
  }
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\x00]/.test(value)) fail('invalid_header', 'Invalid delivery header.');
  return value;
}

function checkKey(key: SigningKey): void {
  if (!keyIdPattern.test(key.id) || encoder.encode(key.secret).byteLength < 32) fail('invalid_key', 'Signing keys require a valid ID and at least 32 secret bytes.');
}

function canonical(keyId: string, timestamp: string, attemptId: string, metadata: string, digest: string): string {
  return ['dreampost-ingest-v1', 'POST', INGEST_PATH, 'message/rfc822', keyId, timestamp, attemptId, metadata, digest].join('\n');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export async function createDeliveryHeaders(
  metadata: DeliveryMetadata,
  raw: Uint8Array,
  key: SigningKey,
  options: { nowMs?: number; attemptId?: string } = {},
): Promise<Record<string, string>> {
  const validated = validateMetadata(metadata);
  if (raw.byteLength !== validated.rawSize) fail('size_mismatch', 'Raw size does not match metadata.');
  checkKey(key);
  const attemptId = options.attemptId ?? crypto.randomUUID();
  if (!uuid.test(attemptId)) fail('invalid_header', 'Invalid attempt identity.');
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) fail('invalid_header', 'Invalid signing timestamp.');
  const timestamp = String(Math.floor(nowMs / 1000));
  const encodedMetadata = encodeBase64Url(encoder.encode(JSON.stringify(validated)));
  const digest = await sha256Hex(raw);
  const signingKey = await crypto.subtle.importKey('raw', encoder.encode(key.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(canonical(key.id, timestamp, attemptId, encodedMetadata, digest)));
  return {
    'content-type': 'message/rfc822', [h.metadata]: encodedMetadata, [h.digest]: digest,
    [h.keyId]: key.id, [h.timestamp]: timestamp, [h.attempt]: attemptId,
    [h.signature]: encodeBase64Url(new Uint8Array(signature)),
  };
}

/** Authenticate the declared digest and envelope before accepting a large request body. */
export async function verifyDeliveryHeaders(
  headers: HeaderInput,
  keys: Record<string, string>,
  options: { nowMs?: number; maxClockSkewSeconds?: number } = {},
): Promise<VerifiedDelivery> {
  if (getHeader(headers, 'content-type').toLowerCase() !== 'message/rfc822') fail('invalid_header', 'Expected a raw RFC 5322 message.');
  const keyId = getHeader(headers, h.keyId);
  const timestamp = getHeader(headers, h.timestamp);
  const attemptId = getHeader(headers, h.attempt);
  const encodedMetadata = getHeader(headers, h.metadata);
  const digest = getHeader(headers, h.digest);
  const encodedSignature = getHeader(headers, h.signature);
  if (!keyIdPattern.test(keyId) || !Object.hasOwn(keys, keyId)) fail('unauthorized', 'Unrecognized delivery key.');
  const secret = keys[keyId];
  if (typeof secret !== 'string') fail('unauthorized', 'Unrecognized delivery key.');
  checkKey({ id: keyId, secret });
  if (!/^\d{1,12}$/.test(timestamp) || !uuid.test(attemptId) || !digestPattern.test(digest)) fail('invalid_header', 'Malformed delivery authentication fields.');
  const skew = options.maxClockSkewSeconds ?? 300;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(skew) || skew < 0 || !Number.isFinite(nowMs)) fail('invalid_key', 'Invalid verifier clock configuration.');
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > skew) fail('expired', 'Delivery signature is outside the accepted time window.');
  const signature = decodeBase64Url(encodedSignature);
  if (signature.byteLength !== 32) fail('unauthorized', 'Invalid delivery signature.');
  const verificationKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify('HMAC', verificationKey, signature, encoder.encode(canonical(keyId, timestamp, attemptId, encodedMetadata, digest)));
  if (!verified) fail('unauthorized', 'Invalid delivery signature.');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(encodedMetadata))); }
  catch { return fail('invalid_metadata', 'Malformed signed metadata.'); }
  return { metadata: validateMetadata(decoded), sha256: digest, attemptId, keyId };
}

export async function verifyDeliveryBody(raw: Uint8Array, verified: VerifiedDelivery): Promise<void> {
  if (raw.byteLength !== verified.metadata.rawSize) fail('size_mismatch', 'Received body length does not match metadata.');
  if (await sha256Hex(raw) !== verified.sha256) fail('digest_mismatch', 'Received body digest does not match the signed digest.');
}

export function matchesAck(value: unknown, expected: { deliveryId: string; sha256: string }): value is DeliveryAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ack = value as Record<string, unknown>;
  return ack.version === 1 && ack.status === 'stored' && ack.deliveryId === expected.deliveryId && ack.sha256 === expected.sha256;
}
