import { describe, expect, it } from 'vitest';
import { sha256Hex } from './index.js';
import {
  attachmentObjectKey, createAttachmentUploadHeaders, createAttachmentUploadResponseHeaders, createDownloadControlHeaders,
  createDownloadControlResponseHeaders, isDownloadId, isDownloadSecret, validateDownloadControlReply,
  verifyAttachmentUploadHeaders, verifyAttachmentUploadResponse, verifyDownloadControlRequest, verifyDownloadControlResponse,
  type AttachmentObjectAck, type DownloadAuthorizeReply, type DownloadControlRequest,
} from './downloads.js';
const key = { id: 'downloads-test', secret: 'dedicated-download-key-32-byte-secret' };
const keys = { [key.id]: key.secret };
const nowMs = Date.parse('2026-09-27T12:00:00.000Z');
const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nonce = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const request: DownloadControlRequest = { version: 1, op: 'authorize', sessionId: sid, transferId: tid, secretHash: '0'.repeat(64), method: 'GET', requestOrigin: null };
const reply: DownloadAuthorizeReply = { version: 1, op: 'authorize', sessionId: sid, transferId: tid, purpose: 'download',
  objectKey: attachmentObjectKey(tid, '0'.repeat(64)), sha256: '0'.repeat(64), sizeBytes: 0, filename: 'receipt.pdf', mimeType: 'application/pdf',
  expiresAt: nowMs + 60_000, sessionExpiresAt: nowMs + 3600_000 };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe('download machine protocol', () => {
  it('binds requests to raw bytes and returns the nonce for replay admission', async () => {
    const headers = await createDownloadControlHeaders(request, key, { nowMs, nonce });
    expect(await verifyDownloadControlRequest(headers, bytes(request), keys, { nowMs })).toMatchObject({ request, nonce, keyId: key.id });
    await expect(verifyDownloadControlRequest(headers, bytes({ ...request, method: 'HEAD' }), keys, { nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlRequest(headers, new TextEncoder().encode(JSON.stringify(request, null, 2)), keys, { nowMs })).rejects.toThrow();
  });
  it('rejects expired, forged, unknown-key and duplicate authorization headers', async () => {
    const headers = await createDownloadControlHeaders(request, key, { nowMs, nonce });
    await expect(verifyDownloadControlRequest(headers, bytes(request), keys, { nowMs: nowMs + 61_000 })).rejects.toThrow();
    await expect(verifyDownloadControlRequest({ ...headers, 'x-dreampost-download-signature': 'A'.repeat(43) }, bytes(request), keys, { nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlRequest(headers, bytes(request), {}, { nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlRequest({ ...headers, 'X-Dreampost-Download-Nonce': nonce }, bytes(request), keys, { nowMs })).rejects.toThrow();
  });
  it('binds signed replies to nonce, status, direction and bytes', async () => {
    const headers = await createDownloadControlResponseHeaders(reply, key, { requestNonce: nonce, status: 200, nowMs });
    expect(await verifyDownloadControlResponse(headers, bytes(reply), keys, { requestNonce: nonce, status: 200, nowMs })).toEqual(reply);
    await expect(verifyDownloadControlResponse(headers, bytes(reply), keys, { requestNonce: sid, status: 200, nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlResponse(headers, bytes(reply), keys, { requestNonce: nonce, status: 403, nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlRequest(headers, bytes(reply), keys, { nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlResponse(headers, bytes({ ...reply, filename: 'changed.pdf' }), keys, { requestNonce: nonce, status: 200, nowMs })).rejects.toThrow();
  });
  it('supports signed errors and rejects a success disguised as an error status', async () => {
    const value = { version: 1 as const, op: 'error' as const, error: 'access_denied' };
    const headers = await createDownloadControlResponseHeaders(value, key, { requestNonce: nonce, status: 403, nowMs });
    expect(await verifyDownloadControlResponse(headers, bytes(value), keys, { requestNonce: nonce, status: 403, nowMs })).toEqual(value);
    await expect(createDownloadControlResponseHeaders(reply, key, { requestNonce: nonce, status: 403, nowMs })).rejects.toThrow();
  });
  it('requires lowercase IDs, canonical 32-byte secrets and constrained immutable descriptors', () => {
    expect(isDownloadId(sid)).toBe(true); expect(isDownloadId(sid.toUpperCase())).toBe(false);
    expect(isDownloadSecret('A'.repeat(43))).toBe(true); expect(isDownloadSecret('A'.repeat(42) + 'B')).toBe(false);
    for (const change of [{ objectKey: '../private' }, { objectKey: `attachments/${tid}/${'f'.repeat(64)}` },
      { sizeBytes: -1 }, { sizeBytes: 25 * 1024 * 1024 + 1 }, { filename: 'bad\r\nheader' },
      { mimeType: 'text/html; charset=utf-8' }, { expiresAt: nowMs + 7200_000 }]) {
      expect(() => validateDownloadControlReply({ ...reply, ...change })).toThrow();
    }
  });
  it('supports browser-bound redeem requests without a plaintext session secret', async () => {
    const value: DownloadControlRequest = { version: 1, op: 'redeem', flowId: sid, ticket: 'A'.repeat(43), challengeHash: '1'.repeat(64), secretHash: '2'.repeat(64) };
    const headers = await createDownloadControlHeaders(value, key, { nowMs, nonce });
    expect((await verifyDownloadControlRequest(headers, bytes(value), keys, { nowMs })).request).toEqual(value);
    await expect(createDownloadControlHeaders({ ...value, secret: 'A'.repeat(43) } as DownloadControlRequest, key, { nowMs })).rejects.toThrow();
  });
  it('binds upload method/path/digest/length and a zero-byte immutable acknowledgment', async () => {
    const descriptor = { attachmentId: tid, sizeBytes: 0, sha256: await sha256Hex(new Uint8Array()) };
    const headers = await createAttachmentUploadHeaders(descriptor, key, { nowMs, nonce });
    expect((await verifyAttachmentUploadHeaders(headers, tid, keys, { nowMs })).descriptor).toEqual(descriptor);
    await expect(verifyAttachmentUploadHeaders(headers, sid, keys, { nowMs })).rejects.toThrow();
    await expect(verifyAttachmentUploadHeaders({ ...headers, 'content-length': '1' }, tid, keys, { nowMs })).rejects.toThrow();
    await expect(verifyDownloadControlRequest(headers, new Uint8Array(), keys, { nowMs })).rejects.toThrow();
    const ack: AttachmentObjectAck = { version: 1, status: 'stored', ...descriptor, objectKey: attachmentObjectKey(tid, descriptor.sha256) };
    const signed = await createAttachmentUploadResponseHeaders(ack, key, { requestNonce: nonce, nowMs });
    expect(await verifyAttachmentUploadResponse(signed, bytes(ack), keys, descriptor, { requestNonce: nonce, nowMs })).toEqual(ack);
    await expect(verifyAttachmentUploadResponse(signed, bytes(ack), keys, { ...descriptor, sizeBytes: 1 }, { requestNonce: nonce, nowMs })).rejects.toThrow();
  });
});

describe('download session-prune protocol', () => {
  it('signs only bounded session identifiers and credential hashes', async () => {
    const request: DownloadControlRequest = { version: 1, op: 'prune', sessions: [{ sessionId: sid, secretHash: '0'.repeat(64) }] };
    const headers = await createDownloadControlHeaders(request, key, { nowMs, nonce });
    expect((await verifyDownloadControlRequest(headers, bytes(request), keys, { nowMs })).request).toEqual(request);
    const reply = { version: 1 as const, op: 'prune' as const, expiredSessionIds: [sid] };
    const signed = await createDownloadControlResponseHeaders(reply, key, { requestNonce: nonce, status: 200, nowMs });
    expect(await verifyDownloadControlResponse(signed, bytes(reply), keys, { requestNonce: nonce, status: 200, nowMs })).toEqual(reply);
  });
  it('rejects empty, duplicate and excessive prune requests and malformed hashes', async () => {
    const session = { sessionId: sid, secretHash: '0'.repeat(64) };
    for (const sessions of [[], [session, session], [{ ...session, secretHash: 'invalid' }],
      Array.from({ length: 33 }, (_, i) => ({ sessionId: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, secretHash: '0'.repeat(64) }))]) {
      await expect(createDownloadControlHeaders({ version: 1, op: 'prune', sessions }, key, { nowMs })).rejects.toThrow();
    }
  });
  it('rejects duplicate or excessive reply IDs while allowing an empty dead set', () => {
    expect(validateDownloadControlReply({ version: 1, op: 'prune', expiredSessionIds: [] })).toEqual({ version: 1, op: 'prune', expiredSessionIds: [] });
    expect(() => validateDownloadControlReply({ version: 1, op: 'prune', expiredSessionIds: [sid, sid] })).toThrow();
    expect(() => validateDownloadControlReply({ version: 1, op: 'prune', expiredSessionIds: Array.from({ length: 33 }, (_, i) => `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`) })).toThrow();
  });
});
