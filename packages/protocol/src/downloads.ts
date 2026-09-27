import { ProtocolError, sha256Hex, type SigningKey } from './index.js';

export const DOWNLOAD_CONTROL_PATH = '/internal/v1/attachments/control';
export const MAX_DOWNLOAD_CONTROL_BYTES = 16 * 1024;
export const MAX_ATTACHMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
export type DownloadPurpose = 'download' | 'preview';
export type DownloadControlRequest =
  | { version: 1; op: 'prune'; sessions: Array<{ sessionId: string; secretHash: string }> }
  | { version: 1; op: 'redeem'; flowId: string; ticket: string; challengeHash: string; secretHash: string }
  | { version: 1; op: 'authorize'; sessionId: string; transferId: string; secretHash: string; method: 'GET' | 'HEAD'; requestOrigin: string | null };
export interface DownloadRedeemReply { version: 1; op: 'redeem'; sessionId: string; transferId: string; purpose: DownloadPurpose; expiresAt: number }
export interface DownloadAuthorizeReply {
  version: 1; op: 'authorize'; sessionId: string; transferId: string; purpose: DownloadPurpose;
  objectKey: string; sha256: string; sizeBytes: number; filename: string; mimeType: string;
  expiresAt: number; sessionExpiresAt: number;
}
export interface DownloadPruneReply { version: 1; op: 'prune'; expiredSessionIds: string[] }
export interface DownloadErrorReply { version: 1; op: 'error'; error: string }
export type DownloadControlReply = DownloadRedeemReply | DownloadAuthorizeReply | DownloadPruneReply | DownloadErrorReply;
export interface AttachmentObjectDescriptor { attachmentId: string; sha256: string; sizeBytes: number }
export interface AttachmentObjectAck extends AttachmentObjectDescriptor { version: 1; status: 'stored'; objectKey: string }
export type DownloadHeaders = Headers | Record<string, string | string[] | undefined>;
type VerifyOptions = { nowMs?: number; maxClockSkewSeconds?: number };
type SignOptions = { nowMs?: number; nonce?: string };
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
function fail(): never { throw new ProtocolError('invalid_download_protocol', 'Invalid download authorization or message.'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: string[]) { if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail(); }
export function isDownloadId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function id(value: unknown): string { if (!isDownloadId(value)) fail(); return value; }
function digest(value: unknown): string { if (typeof value !== 'string' || !hash.test(value)) fail(); return value; }
function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(); return value; }
function purpose(value: unknown): DownloadPurpose { if (value !== 'download' && value !== 'preview') fail(); return value; }
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function isDownloadSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !opaque.test(value)) return false;
  try { return base64(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0))) === value; } catch { return false; }
}
export function attachmentObjectKey(attachmentId: string, sha256: string): string { return `attachments/${id(attachmentId)}/${digest(sha256)}`; }
export function validateDownloadControlRequest(value: unknown): DownloadControlRequest {
  const v = object(value); if (v.version !== 1) fail();
  if (v.op === 'prune') {
    exact(v, ['version', 'op', 'sessions']);
    if (!Array.isArray(v.sessions) || v.sessions.length < 1 || v.sessions.length > 32) fail();
    const sessions = v.sessions.map(value => { const entry = object(value); exact(entry, ['sessionId', 'secretHash']);
      return { sessionId: id(entry.sessionId), secretHash: digest(entry.secretHash) }; });
    if (new Set(sessions.map(entry => entry.sessionId)).size !== sessions.length) fail();
    return { version: 1, op: 'prune', sessions };
  }
  if (v.op === 'redeem') {
    exact(v, ['version', 'op', 'flowId', 'ticket', 'challengeHash', 'secretHash']);
    if (!isDownloadSecret(v.ticket)) fail();
    return { version: 1, op: 'redeem', flowId: id(v.flowId), ticket: v.ticket, challengeHash: digest(v.challengeHash), secretHash: digest(v.secretHash) };
  }
  if (v.op === 'authorize') {
    exact(v, ['version', 'op', 'sessionId', 'transferId', 'secretHash', 'method', 'requestOrigin']);
    if ((v.method !== 'GET' && v.method !== 'HEAD') || (v.requestOrigin !== null && (typeof v.requestOrigin !== 'string' || v.requestOrigin.length > 512 || /[\r\n\x00]/.test(v.requestOrigin)))) fail();
    return { version: 1, op: 'authorize', sessionId: id(v.sessionId), transferId: id(v.transferId), secretHash: digest(v.secretHash), method: v.method, requestOrigin: v.requestOrigin as string | null };
  }
  return fail();
}
export function validateDownloadControlReply(value: unknown): DownloadControlReply {
  const v = object(value); if (v.version !== 1) fail();
  if (v.op === 'error') {
    exact(v, ['version', 'op', 'error']);
    if (typeof v.error !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(v.error)) fail();
    return { version: 1, op: 'error', error: v.error };
  }
  if (v.op === 'prune') {
    exact(v, ['version', 'op', 'expiredSessionIds']);
    if (!Array.isArray(v.expiredSessionIds) || v.expiredSessionIds.length > 32) fail();
    const expiredSessionIds = v.expiredSessionIds.map(id);
    if (new Set(expiredSessionIds).size !== expiredSessionIds.length) fail();
    return { version: 1, op: 'prune', expiredSessionIds };
  }
  const common = { version: 1 as const, sessionId: id(v.sessionId), transferId: id(v.transferId), purpose: purpose(v.purpose), expiresAt: number(v.expiresAt, 1) };
  if (v.op === 'redeem') { exact(v, ['version', 'op', 'sessionId', 'transferId', 'purpose', 'expiresAt']); return { ...common, op: 'redeem' }; }
  if (v.op === 'authorize') {
    exact(v, ['version', 'op', 'sessionId', 'transferId', 'purpose', 'expiresAt', 'sessionExpiresAt', 'objectKey', 'sha256', 'sizeBytes', 'filename', 'mimeType']);
    const sha256 = digest(v.sha256);
    if (typeof v.objectKey !== 'string') fail();
    const parts = v.objectKey.split('/');
    if (parts.length !== 3 || attachmentObjectKey(parts[1]!, sha256) !== v.objectKey) fail();
    if (typeof v.filename !== 'string' || !v.filename || encoder.encode(v.filename).length > 1024 || /[\x00-\x1f\x7f]/.test(v.filename)) fail();
    if (typeof v.mimeType !== 'string' || v.mimeType.length > 150 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(v.mimeType)) fail();
    const sessionExpiresAt = number(v.sessionExpiresAt, 1); if (common.expiresAt > sessionExpiresAt) fail();
    return { ...common, op: 'authorize', objectKey: v.objectKey, sha256, sizeBytes: number(v.sizeBytes, 0, MAX_ATTACHMENT_UPLOAD_BYTES), filename: v.filename, mimeType: v.mimeType, sessionExpiresAt };
  }
  return fail();
}
function header(headers: DownloadHeaders, name: string): string {
  const matches = headers instanceof Headers ? [headers.get(name)] : Object.entries(headers).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  if (matches.length !== 1 || typeof matches[0] !== 'string' || !matches[0] || matches[0].length > 1024 || /[\r\n\x00]/.test(matches[0])) fail();
  return matches[0];
}
function checkKey(key: SigningKey) { if (!keyIdPattern.test(key.id) || typeof key.secret !== 'string' || encoder.encode(key.secret).length < 32) fail(); }
async function cryptoKey(secret: string, use: 'sign' | 'verify') { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [use]); }
const canonical = (kind: string, direction: string, method: string, path: string, status: number, keyId: string, timestamp: string, nonce: string, sha256: string) =>
  ['dreampost-download-v1', kind, direction, method, path, String(status), keyId, timestamp, nonce, sha256].join('\n');
async function sign(kind: string, direction: string, method: string, path: string, status: number, sha256: string, key: SigningKey, options: SignOptions) {
  checkKey(key); const nonce = id(options.nonce ?? crypto.randomUUID()); const now = number(options.nowMs ?? Date.now());
  const timestamp = String(Math.floor(now / 1000));
  const signature = base64(new Uint8Array(await crypto.subtle.sign('HMAC', await cryptoKey(key.secret, 'sign'), encoder.encode(canonical(kind, direction, method, path, status, key.id, timestamp, nonce, digest(sha256))))));
  return { 'x-dreampost-download-key-id': key.id, 'x-dreampost-download-timestamp': timestamp, 'x-dreampost-download-nonce': nonce,
    'x-dreampost-download-sha256': sha256, 'x-dreampost-download-signature': signature };
}
async function verify(kind: string, direction: string, method: string, path: string, status: number, headers: DownloadHeaders, keys: Record<string, string>, options: VerifyOptions, expectedNonce?: string) {
  const keyId = header(headers, 'x-dreampost-download-key-id');
  if (!Object.hasOwn(keys, keyId)) fail(); checkKey({ id: keyId, secret: keys[keyId]! });
  const timestamp = header(headers, 'x-dreampost-download-timestamp'), nonce = id(header(headers, 'x-dreampost-download-nonce'));
  const sha256 = digest(header(headers, 'x-dreampost-download-sha256')), signature = header(headers, 'x-dreampost-download-signature');
  if (!/^\d{1,12}$/.test(timestamp) || !isDownloadSecret(signature) || (expectedNonce !== undefined && nonce !== id(expectedNonce))) fail();
  const now = number(options.nowMs ?? Date.now()), skew = number(options.maxClockSkewSeconds ?? 60, 0, 300);
  if (Math.abs(now - Number(timestamp) * 1000) > skew * 1000) fail();
  const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
  if (!await crypto.subtle.verify('HMAC', await cryptoKey(keys[keyId]!, 'verify'), bytes, encoder.encode(canonical(kind, direction, method, path, status, keyId, timestamp, nonce, sha256)))) fail();
  return { nonce, keyId, digest: sha256 };
}
function json(bytes: Uint8Array): unknown { if (bytes.length > MAX_DOWNLOAD_CONTROL_BYTES) fail(); try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); } }
function jsonType(headers: DownloadHeaders) { if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(headers, 'content-type'))) fail(); }
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
export async function createDownloadControlHeaders(request: DownloadControlRequest, key: SigningKey, options: SignOptions = {}) {
  validateDownloadControlRequest(request); const raw = bytes(request); if (raw.length > MAX_DOWNLOAD_CONTROL_BYTES) fail();
  return { 'content-type': 'application/json', ...await sign('control', 'request', 'POST', DOWNLOAD_CONTROL_PATH, 0, await sha256Hex(raw), key, options) };
}
export async function verifyDownloadControlRequest(headers: DownloadHeaders, raw: Uint8Array, keys: Record<string, string>, options: VerifyOptions = {}) {
  jsonType(headers); if (raw.length > MAX_DOWNLOAD_CONTROL_BYTES) fail();
  const verified = await verify('control', 'request', 'POST', DOWNLOAD_CONTROL_PATH, 0, headers, keys, options);
  if (await sha256Hex(raw) !== verified.digest) fail(); return { ...verified, request: validateDownloadControlRequest(json(raw)) };
}
export async function createDownloadControlResponseHeaders(reply: DownloadControlReply, key: SigningKey, options: { requestNonce: string; status: number; nowMs?: number }) {
  validateDownloadControlReply(reply); const status = number(options.status, 200, 599);
  if ((status === 200) === (reply.op === 'error')) fail();
  return { 'content-type': 'application/json', ...await sign('control', 'response', 'POST', DOWNLOAD_CONTROL_PATH, status, await sha256Hex(bytes(reply)), key, { nonce: options.requestNonce, nowMs: options.nowMs }) };
}
export async function verifyDownloadControlResponse(headers: DownloadHeaders, raw: Uint8Array, keys: Record<string, string>, options: VerifyOptions & { requestNonce: string; status: number }): Promise<DownloadControlReply> {
  jsonType(headers); if (raw.length > MAX_DOWNLOAD_CONTROL_BYTES) fail();
  const status = number(options.status, 200, 599);
  const verified = await verify('control', 'response', 'POST', DOWNLOAD_CONTROL_PATH, status, headers, keys, options, options.requestNonce);
  if (await sha256Hex(raw) !== verified.digest) fail(); const reply = validateDownloadControlReply(json(raw));
  if ((status === 200) === (reply.op === 'error')) fail(); return reply;
}
export function validateAttachmentObjectDescriptor(value: unknown): AttachmentObjectDescriptor {
  const v = object(value); exact(v, ['attachmentId', 'sha256', 'sizeBytes']);
  return { attachmentId: id(v.attachmentId), sha256: digest(v.sha256), sizeBytes: number(v.sizeBytes, 0, MAX_ATTACHMENT_UPLOAD_BYTES) };
}
export async function createAttachmentUploadHeaders(value: AttachmentObjectDescriptor, key: SigningKey, options: SignOptions = {}) {
  const descriptor = validateAttachmentObjectDescriptor(value);
  return { 'content-type': 'application/octet-stream', 'content-length': String(descriptor.sizeBytes),
    'x-dreampost-download-size': String(descriptor.sizeBytes),
    ...await sign(`upload:${descriptor.sizeBytes}`, 'request', 'PUT', `/internal/v1/objects/${descriptor.attachmentId}`, 0, descriptor.sha256, key, options) };
}
export async function verifyAttachmentUploadHeaders(headers: DownloadHeaders, attachmentId: string, keys: Record<string, string>, options: VerifyOptions = {}) {
  if (header(headers, 'content-type') !== 'application/octet-stream') fail();
  const size = header(headers, 'x-dreampost-download-size'); if (!/^(?:0|[1-9]\d{0,8})$/.test(size) || header(headers, 'content-length') !== size) fail();
  const verified = await verify(`upload:${size}`, 'request', 'PUT', `/internal/v1/objects/${id(attachmentId)}`, 0, headers, keys, options);
  return { ...verified, descriptor: validateAttachmentObjectDescriptor({ attachmentId, sha256: verified.digest, sizeBytes: Number(size) }) };
}
function ack(value: unknown): AttachmentObjectAck {
  const v = object(value); exact(v, ['version', 'status', 'attachmentId', 'sha256', 'sizeBytes', 'objectKey']);
  const descriptor = validateAttachmentObjectDescriptor({ attachmentId: v.attachmentId, sha256: v.sha256, sizeBytes: v.sizeBytes });
  if (v.version !== 1 || v.status !== 'stored' || v.objectKey !== attachmentObjectKey(descriptor.attachmentId, descriptor.sha256)) fail();
  return { version: 1, status: 'stored', ...descriptor, objectKey: v.objectKey as string };
}
export async function createAttachmentUploadResponseHeaders(value: AttachmentObjectAck, key: SigningKey, options: { requestNonce: string; nowMs?: number }) {
  const reply = ack(value);
  return { 'content-type': 'application/json', ...await sign('upload', 'response', 'PUT', `/internal/v1/objects/${reply.attachmentId}`, 200, await sha256Hex(bytes(value)), key, { nonce: options.requestNonce, nowMs: options.nowMs }) };
}
export async function verifyAttachmentUploadResponse(headers: DownloadHeaders, raw: Uint8Array, keys: Record<string, string>, expected: AttachmentObjectDescriptor, options: VerifyOptions & { requestNonce: string }): Promise<AttachmentObjectAck> {
  jsonType(headers); if (raw.length > MAX_DOWNLOAD_CONTROL_BYTES) fail(); const descriptor = validateAttachmentObjectDescriptor(expected);
  const verified = await verify('upload', 'response', 'PUT', `/internal/v1/objects/${descriptor.attachmentId}`, 200, headers, keys, options, options.requestNonce);
  if (await sha256Hex(raw) !== verified.digest) fail(); const reply = ack(json(raw));
  if (reply.attachmentId !== descriptor.attachmentId || reply.sha256 !== descriptor.sha256 || reply.sizeBytes !== descriptor.sizeBytes) fail(); return reply;
}
