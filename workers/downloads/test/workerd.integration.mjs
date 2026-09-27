import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { attachmentObjectKey, createAttachmentUploadHeaders, createDownloadControlResponseHeaders, sha256Hex,
  verifyAttachmentUploadResponse, verifyDownloadControlRequest } from '@dreampost/protocol';
import { createDownloadsMiniflare } from './miniflare-fixture.mjs';
const key = { id: 'workerd-test', secret: randomBytes(32).toString('base64url') };
const appOrigin = 'https://mail.example.test', downloadOrigin = 'https://downloads.example.test';
const backendUrl = 'https://api.example.test/internal/v1/attachments/control';
const sessionId = randomUUID(), transferId = randomUUID(), flowId = randomUUID();
const ticket = randomBytes(32).toString('base64url'); let sessionSecretHash, descriptor; let calls = 0;
const mf = await createDownloadsMiniflare({
  bindings: { APP_ORIGIN: appOrigin, DOWNLOAD_ORIGIN: downloadOrigin, BACKEND_CONTROL_URL: backendUrl, CONTROL_KEY_ID: key.id, CONTROL_SECRET: key.secret },
  outboundService: async request => {
    assert.equal(request.url, backendUrl); calls++;
    const verified = await verifyDownloadControlRequest(new Headers([...request.headers]), new Uint8Array(await request.arrayBuffer()), { [key.id]: key.secret });
    let result;
    if (verified.request.op === 'redeem') {
      assert.equal(verified.request.flowId, flowId); assert.equal(verified.request.ticket, ticket); sessionSecretHash = verified.request.secretHash;
      result = { version: 1, op: 'redeem', sessionId, transferId, purpose: 'download', expiresAt: Date.now() + 120_000 };
    } else if (verified.request.op === 'prune') {
      result = { version: 1, op: 'prune', expiredSessionIds: verified.request.sessions.filter(value => value.sessionId !== sessionId || value.secretHash !== sessionSecretHash).map(value => value.sessionId) };
    } else {
      assert.equal(verified.request.secretHash, sessionSecretHash);
      result = { version: 1, op: 'authorize', sessionId, transferId, purpose: 'download', ...descriptor, expiresAt: Date.now() + 60_000, sessionExpiresAt: Date.now() + 3600_000 };
    }
    const headers = await createDownloadControlResponseHeaders(result, key, { requestNonce: verified.nonce, status: 200 });
    return new Response(JSON.stringify(result), { headers });
  },
});
const checks = [];
try {
  const attachmentId = randomUUID(), body = new TextEncoder().encode('Workerd exact R2 bytes 0123456789');
  const sha256 = await sha256Hex(body), value = { attachmentId, sha256, sizeBytes: body.length };
  const put = async (data = body, expected = value) => {
    const headers = await createAttachmentUploadHeaders(expected, key);
    const response = await mf.dispatchFetch(`${downloadOrigin}/internal/v1/objects/${attachmentId}`, { method: 'PUT', headers, body: data });
    if (response.status === 200) await verifyAttachmentUploadResponse(new Headers([...response.headers]), new Uint8Array(await response.arrayBuffer()), { [key.id]: key.secret }, expected, { requestNonce: headers['x-dreampost-download-nonce'] });
    return response.status;
  };
  assert.equal(await put(), 200); assert.equal(await put(), 200); checks.push('R2 FixedLengthStream upload/checksum/conditional retry');
  const bucket = await mf.getR2Bucket('ATTACHMENTS'); const objectKey = attachmentObjectKey(attachmentId, sha256);
  const stored = await bucket.get(objectKey); assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), body); assert.equal(stored.customMetadata.attachmentId, attachmentId);
  checks.push('R2 persisted metadata and exact original bytes');
  const mismatch = { ...value, sha256: 'f'.repeat(64) };
  assert.equal(await put(body, mismatch), 422); assert.equal(await bucket.head(attachmentObjectKey(attachmentId, mismatch.sha256)), null); checks.push('R2 rejects checksum mismatch without an object');
  const empty = { attachmentId, sha256: await sha256Hex(new Uint8Array()), sizeBytes: 0 };
  assert.equal(await put(new Uint8Array(), empty), 200); checks.push('R2 zero-byte checksum upload');
  descriptor = { objectKey, sha256, sizeBytes: body.length, filename: 'receipt.pdf', mimeType: 'application/pdf' };
  const challenge = await mf.dispatchFetch(`${downloadOrigin}/bootstrap/challenge`, { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ flowId }) });
  assert.equal(challenge.status, 200); const challengeValue = await challenge.json(); const challengeCookie = challenge.headers.getSetCookie()[0].split(';')[0]; assert.equal(challengeValue.flowId, flowId);
  const redeemed = await mf.dispatchFetch(`${downloadOrigin}/bootstrap/redeem`, { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json', cookie: `${challengeCookie}; _ga=1; _ga=2; junk` }, body: JSON.stringify({ flowId, ticket }) });
  assert.equal(redeemed.status, 200); const ready = await redeemed.json(); const sessionCookie = redeemed.headers.getSetCookie().find(value => value.startsWith('__Host-dp-download-')).split(';')[0];
  checks.push('actual Worker challenge and hashed-secret bootstrap');
  const read = async (headers = {}, method = 'GET') => mf.dispatchFetch(ready.url, { method, headers: { cookie: sessionCookie, ...headers } });
  const full = await read(); assert.equal(full.status, 200); assert.deepEqual(new Uint8Array(await full.arrayBuffer()), body); assert.equal(full.headers.get('etag'), `"sha256-${sha256}"`);
  const partial = await read({ range: 'bytes=2-7' }); assert.equal(partial.status, 206); assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), body.slice(2, 8));
  const head = await read({}, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(body.length)); assert(Number(head.headers.get('x-dreampost-session-expires-at')) > Date.now() + 120_000); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await read({ 'if-none-match': `"sha256-${sha256}"` })).status, 304);
  const invalid = await read({ range: 'bytes=999-' }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${body.length}`);
  const changed = await read({ range: 'bytes=2-7', 'if-range': '"wrong"' }); assert.equal(changed.status, 200); assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), body);
  checks.push('actual R2 GET/HEAD/206/304/416/If-Range fallback');
  const unrelated = await read({ cookie: `${sessionCookie}; _ga=1; _ga=2; junk` });
  assert.equal(unrelated.status, 200); assert.deepEqual(new Uint8Array(await unrelated.arrayBuffer()), body);
  const beforeDuplicate = calls;
  const duplicate = await read({ cookie: `${sessionCookie}; ${sessionCookie}; _ga=1; _ga=2` });
  assert.equal(duplicate.status, 400); await duplicate.text(); assert.equal(calls, beforeDuplicate);
  checks.push('unrelated duplicate/malformed cookies ignored; owned duplicates rejected before callback');
  const deadSession = randomUUID(), malformedSession = randomUUID();
  const pruned = await mf.dispatchFetch(`${downloadOrigin}/bootstrap/challenge`, { method: 'POST',
    headers: { origin: appOrigin, 'content-type': 'application/json', cookie: `${sessionCookie}; __Host-dp-download-${deadSession}=${randomBytes(32).toString('base64url')}; __Host-dp-download-${malformedSession}=broken` },
    body: JSON.stringify({ flowId: randomUUID() }) });
  assert.equal(pruned.status, 200);
  const removed = pruned.headers.getSetCookie().filter(value => value.includes('Max-Age=0'));
  assert.equal(removed.length, 2); assert(removed.some(value => value.startsWith(`__Host-dp-download-${deadSession}=`)));
  assert(removed.some(value => value.startsWith(`__Host-dp-download-${malformedSession}=`)));
  assert(!removed.some(value => value.startsWith(`__Host-dp-download-${sessionId}=`)));
  checks.push('signed dead-cookie pruning preserves the active session; authorized HEAD exposes its real expiry');
  assert.equal((await mf.dispatchFetch(ready.url)).status, 401); checks.push('bare URL denied');
  descriptor = { ...descriptor, sha256: empty.sha256, sizeBytes: 0, objectKey: attachmentObjectKey(attachmentId, empty.sha256) };
  const zero = await read(); assert.equal(zero.status, 200); assert.equal(zero.headers.get('content-length'), '0'); assert.equal((await zero.arrayBuffer()).byteLength, 0);
  assert.equal((await read({ range: 'bytes=0-' })).status, 416); checks.push('zero-byte GET and range rejection');
  console.log(JSON.stringify({ status: 'passed', checks, authenticatedControlCalls: calls, liveCloudflare: false }, null, 2));
} finally { await mf.dispose(); }

// A separate local runtime gives this admission test its own synthetic counters.
// Production counters are approximate/location-local; this does not assert global quotas.
let rejectedControlCalls = 0;
const limited = await createDownloadsMiniflare({
  requestLimit: 2,
  bindings: { APP_ORIGIN: appOrigin, DOWNLOAD_ORIGIN: downloadOrigin, BACKEND_CONTROL_URL: backendUrl, CONTROL_KEY_ID: key.id, CONTROL_SECRET: key.secret },
  outboundService: async request => {
    assert.equal(request.url, backendUrl); rejectedControlCalls++;
    const verified = await verifyDownloadControlRequest(new Headers([...request.headers]), new Uint8Array(await request.arrayBuffer()), { [key.id]: key.secret });
    const value = { version: 1, op: 'error', error: 'invalid_download_session' };
    const headers = await createDownloadControlResponseHeaders(value, key, { requestNonce: verified.nonce, status: 401 });
    return new Response(JSON.stringify(value), { status: 401, headers });
  },
});
try {
  for (let i = 0; i < 2; i++) {
    const session = randomUUID(), transfer = randomUUID(), secret = randomBytes(32).toString('base64url');
    const response = await limited.dispatchFetch(`${downloadOrigin}/sessions/${session}/transfers/${transfer}`, {
      headers: { 'cf-connecting-ip': '192.0.2.55', cookie: `__Host-dp-download-${session}=${secret}` },
    });
    assert.equal(response.status, 401); await response.text();
  }
  const blocked = await limited.dispatchFetch(`${downloadOrigin}/sessions/${sessionId}/transfers/${transferId}`, {
    headers: { 'cf-connecting-ip': '192.0.2.55', cookie: `__Host-dp-download-${sessionId}=${randomBytes(32).toString('base64url')}` },
  });
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60'); await blocked.text();
  const challenge = await limited.dispatchFetch(`${downloadOrigin}/bootstrap/challenge`, { method: 'POST',
    headers: { 'cf-connecting-ip': '192.0.2.55', origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ flowId: randomUUID() }) });
  assert.equal(challenge.status, 429); await challenge.text();
  const put = await limited.dispatchFetch(`${downloadOrigin}/internal/v1/objects/${randomUUID()}`, { method: 'PUT',
    headers: { 'cf-connecting-ip': '192.0.2.55' }, body: 'not authorized' });
  assert.equal(put.status, 429); await put.text();
  assert.equal(rejectedControlCalls, 2);
  console.log(JSON.stringify({ status: 'passed', check: 'native Workers limiter blocks rotated forged cookies and other endpoint starts before callback/upload', admittedSyntheticStarts: 2, backendCallbacks: rejectedControlCalls, liveCloudflare: false }, null, 2));
} finally { await limited.dispose(); }
