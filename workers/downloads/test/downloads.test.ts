import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentObjectKey, createAttachmentUploadHeaders, createDownloadControlResponseHeaders, sha256Hex,
  verifyAttachmentUploadResponse, verifyDownloadControlRequest,
  type DownloadAuthorizeReply, type DownloadControlRequest, type DownloadControlReply,
} from '@dreampost/protocol';
import { createDownloadWorker, type Env } from '../src/index.js';
import { readConfig } from '../src/config.js';
import { cookies, requireSecret } from '../src/http.js';
const now = 1_790_510_400_000;
const key = { id: 'downloads-test', secret: 'independent-download-machine-test-secret' };
const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const aid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', flow = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const cookieSecret = 'A'.repeat(43);
const cookieName = `__Host-dp-download-${sid}`;
const appOrigin = 'https://mail.example.com', downloadOrigin = 'https://download.example.com';
const path = `/sessions/${sid}/transfers/${tid}`;
const data = new TextEncoder().encode('0123456789');
class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number) { let size = 0; super({ transform(chunk, controller) { size += chunk.length; if (size > expected) throw new Error('too_long'); controller.enqueue(chunk); }, flush() { if (size !== expected) throw new Error('too_short'); } }); }
}
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
interface Stored { bytes: Uint8Array; digest: string }
let env: Env;
let store: Map<string, Stored>;
let calls: DownloadControlRequest[];
let descriptor: DownloadAuthorizeReply;
let clock: number;
let backend: (request: DownloadControlRequest) => { reply: DownloadControlReply; status: number };
let wireTransform: ((response: Response) => Response | Promise<Response>) | undefined;
let readCount: number;
let putCount: number;
let worker: ReturnType<typeof createDownloadWorker>;
let beforeBody: (() => void) | undefined;
let beforeHead: (() => void) | undefined;
let corruptMetadata = false;
function metadata(key: string, item: Stored) {
  return { key, size: item.bytes.length, checksums: { sha256: Uint8Array.from(item.digest.match(/../g)!, part => Number.parseInt(part, 16)).buffer },
    etag: 'r2-etag', httpEtag: '"r2-etag"', version: 'version-1', uploaded: new Date(now), storageClass: 'Standard', customMetadata: { attachmentId: corruptMetadata ? sid : key.split('/')[1], sha256: item.digest } };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function request(suffix = path, init: RequestInit = {}): Request { return new Request(`${downloadOrigin}${suffix}`, init); }
function authHeaders(extra: Record<string, string> = {}) { return { cookie: `${cookieName}=${cookieSecret}`, ...extra }; }
function post(url: string, value: unknown, headers: Record<string, string> = {}) { return request(url, { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) }); }
async function get(init: RequestInit = {}) { return worker.fetch(request(path, { ...init, headers: { ...authHeaders(), ...Object.fromEntries(new Headers(init.headers)) } }), env); }
beforeEach(async () => {
  vi.stubGlobal('FixedLengthStream', TestFixedLengthStream);
  clock = now; calls = []; store = new Map(); readCount = 0; putCount = 0; wireTransform = undefined; beforeBody = undefined; beforeHead = undefined; corruptMetadata = false;
  const digest = await sha256Hex(data), objectKey = attachmentObjectKey(aid, digest); store.set(objectKey, { bytes: data, digest });
  descriptor = { version: 1, op: 'authorize', sessionId: sid, transferId: tid, purpose: 'download', objectKey,
    sha256: digest, sizeBytes: data.length, filename: 'receipt.pdf', mimeType: 'application/pdf', expiresAt: now + 60_000, sessionExpiresAt: now + 3600_000 };
  backend = (value) => ({ status: 200, reply: value.op === 'redeem'
    ? { version: 1, op: 'redeem', sessionId: sid, transferId: tid, purpose: 'download', expiresAt: now + 120_000 }
    : value.op === 'prune' ? { version: 1, op: 'prune', expiredSessionIds: [] } : descriptor });
  env = { APP_ORIGIN: appOrigin, DOWNLOAD_ORIGIN: downloadOrigin,
    BACKEND_CONTROL_URL: 'https://api.example.com/internal/v1/attachments/control', CONTROL_KEY_ID: key.id, CONTROL_SECRET: key.secret,
    REQUEST_START_LIMITER: { limit: async () => ({ success: true }) },
    ATTACHMENTS: {
      async head(key: string) { beforeHead?.(); const item = store.get(key); return item ? metadata(key, item) : null; },
      async get(key: string, options?: { range?: { offset: number; length: number } }) {
        readCount++; const item = store.get(key); if (!item) return null;
        beforeBody?.();
        const selected = options?.range ? item.bytes.slice(options.range.offset, options.range.offset + options.range.length) : item.bytes;
        return { ...metadata(key, item), body: new ReadableStream({ start(controller) { controller.enqueue(selected); controller.close(); } }), range: options?.range };
      },
      async put(key: string, body: ReadableStream<Uint8Array>, options: { onlyIf?: { etagDoesNotMatch?: string }; sha256: ArrayBuffer }) {
        putCount++; expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
        if (store.has(key)) return null;
        const received = new Uint8Array(await new Response(body).arrayBuffer());
        const digest = await sha256Hex(received); if (digest !== hex(options.sha256)) throw new Error('checksum_mismatch');
        const item = { bytes: received, digest }; store.set(key, item); return metadata(key, item);
      },
    } as unknown as R2Bucket,
  };
  worker = createDownloadWorker({ now: () => clock, fetch: async (url, init) => {
    expect(String(url)).toBe(env.BACKEND_CONTROL_URL); expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    const raw = new TextEncoder().encode(String(init?.body));
    const verified = await verifyDownloadControlRequest(new Headers(init?.headers), raw, { [key.id]: key.secret }, { nowMs: clock });
    calls.push(verified.request); const value = backend(verified.request);
    const headers = await createDownloadControlResponseHeaders(value.reply, key, { requestNonce: verified.nonce, status: value.status, nowMs: clock });
    const response = new Response(JSON.stringify(value.reply), { status: value.status, headers });
    return wireTransform ? wireTransform(response) : response;
  } });
});
afterEach(() => vi.unstubAllGlobals());
describe('download Worker bootstrap and origin boundaries', () => {
  it('creates an independent 32-byte HttpOnly challenge without HTML or credentials in JSON', async () => {
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }), env);
    expect(response.status).toBe(200); const payload = await response.json() as { flowId: string; challengeHash: string };
    const value = response.headers.getSetCookie()[0]!;
    expect(value).toMatch(new RegExp(`^__Host-dp-bootstrap-${flow}=[A-Za-z0-9_-]{43};`));
    expect(value).toContain('HttpOnly'); expect(value).toContain('Secure'); expect(value).toContain('SameSite=Lax'); expect(value).toContain('Max-Age=120'); expect(value).not.toContain('Domain=');
    const secret = value.split(';')[0]!.split('=')[1]!;
    expect(payload).toEqual({ flowId: flow, challengeHash: await sha256Hex(new TextEncoder().encode(secret)) });
    expect(response.headers.get('access-control-allow-origin')).toBe(appOrigin); expect(calls).toHaveLength(0);
    expect((await worker.fetch(request(`/bootstrap?flow=${flow}`), env)).status).toBe(404);
  });
  it.each(['https://evil.example.com', 'https://mail.example.com.evil.test', 'null'])('rejects a bootstrap from %s', async origin => {
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { origin }), env)).status).toBe(403); expect(calls).toHaveLength(0);
  });
  it('rejects missing Origin, form content, unknown fields and uppercase flow IDs', async () => {
    expect((await worker.fetch(request('/bootstrap/challenge', { method: 'POST', body: JSON.stringify({ flowId: flow }), headers: { 'content-type': 'application/json' } }), env)).status).toBe(403);
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { 'content-type': 'application/x-www-form-urlencoded' }), env)).status).toBe(415);
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow, extra: true }), env)).status).toBe(400);
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow.toUpperCase() }), env)).status).toBe(400);
  });
  it('redeems the exact challenge and sends only the fresh session secret hash to the backend', async () => {
    const response = await worker.fetch(post('/bootstrap/redeem', { flowId: flow, ticket: 'A'.repeat(43) }, { cookie: `__Host-dp-bootstrap-${flow}=${cookieSecret}` }), env);
    expect(response.status).toBe(200); const payload = await response.json();
    expect(payload).toEqual({ sessionId: sid, transferId: tid, purpose: 'download', expiresAt: now + 120_000, url: `${downloadOrigin}${path}` });
    const set = response.headers.getSetCookie(); expect(set).toHaveLength(2);
    const current = set.find(value => value.startsWith(cookieName + '='))!; const secret = current.split(';')[0]!.split('=')[1]!;
    expect(secret).not.toBe(cookieSecret); expect(current).toContain('Max-Age=120');
    expect(set.some(value => value.startsWith(`__Host-dp-bootstrap-${flow}=`) && value.includes('Max-Age=0'))).toBe(true);
    expect(calls[0]).toMatchObject({ op: 'redeem', challengeHash: await sha256Hex(new TextEncoder().encode(cookieSecret)), secretHash: await sha256Hex(new TextEncoder().encode(secret)) });
    expect(JSON.stringify(calls)).not.toContain(secret); expect(JSON.stringify(payload)).not.toContain(secret);
  });
  it('denies absent/duplicate challenge cookies and never overwrites an existing session cookie', async () => {
    expect((await worker.fetch(post('/bootstrap/redeem', { flowId: flow, ticket: cookieSecret }), env)).status).toBe(401);
    const challenge = `__Host-dp-bootstrap-${flow}=${cookieSecret}`;
    expect((await worker.fetch(post('/bootstrap/redeem', { flowId: flow, ticket: cookieSecret }, { cookie: `${challenge}; ${challenge}` }), env)).status).toBe(400);
    const clash = await worker.fetch(post('/bootstrap/redeem', { flowId: flow, ticket: cookieSecret }, { cookie: `${challenge}; ${cookieName}=${cookieSecret}` }), env);
    expect(clash.status).toBe(409); expect(clash.headers.getSetCookie()).toEqual([]);
  });
  it('bounds pending bootstrap and existing session cookie counts independently', async () => {
    const challenges = Array.from({ length: 4 }, (_, i) => `__Host-dp-bootstrap-e0000000-0000-4000-8000-${String(i).padStart(12, '0')}=${cookieSecret}`).join('; ');
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: challenges }), env)).status).toBe(429);
    const sessions = Array.from({ length: 16 }, (_, i) => `__Host-dp-download-e0000000-0000-4000-8000-${String(i).padStart(12, '0')}=${cookieSecret}`).join('; ');
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: sessions }), env)).status).toBe(429);
    expect(calls).toHaveLength(1); expect(calls[0]?.op).toBe('prune');
  });
  it('allows only path-specific CORS preflights', async () => {
    const response = await worker.fetch(request(path, { method: 'OPTIONS', headers: { origin: appOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'Range, If-Range' } }), env);
    expect(response.status).toBe(204); expect(response.headers.get('access-control-allow-credentials')).toBe('true'); expect(response.headers.get('vary')).toContain('Origin');
    expect((await worker.fetch(request(path, { method: 'OPTIONS', headers: { origin: appOrigin, 'access-control-request-method': 'PUT' } }), env)).status).toBe(403);
    expect((await worker.fetch(request('/bootstrap/redeem', { method: 'OPTIONS', headers: { origin: appOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization' } }), env)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
describe('download Worker authorized byte responses', () => {
  it('denies naked URLs, wrong or duplicate cookies, and case-variant IDs', async () => {
    expect((await worker.fetch(request(path), env)).status).toBe(401);
    expect((await worker.fetch(request(path, { headers: { cookie: `__Host-dp-download-${tid}=${cookieSecret}` } }), env)).status).toBe(401);
    expect((await get({ headers: { cookie: `${cookieName}=${cookieSecret}; ${cookieName}=${cookieSecret}` } })).status).toBe(400);
    expect((await worker.fetch(request(path.toUpperCase(), { headers: authHeaders() }), env)).status).toBe(404); expect(calls).toHaveLength(0);
  });
  it('streams authorized content and extends only the same cookie to the fixed backend deadline', async () => {
    const response = await get(); expect(response.status).toBe(200); expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('etag')).toBe(`"sha256-${descriptor.sha256}"`);
    expect(response.headers.get('content-length')).toBe('10'); expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-disposition')).toContain('attachment;'); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.getSetCookie()).toEqual([`${cookieName}=${cookieSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`]);
    expect(calls[0]).toMatchObject({ method: 'GET', requestOrigin: null, secretHash: await sha256Hex(new TextEncoder().encode(cookieSecret)) });
  });
  it.each([['bytes=0-0', '0', 'bytes 0-0/10'], ['bytes=3-6', '3456', 'bytes 3-6/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10']])('serves exact single ranges: %s', async (range, text, contentRange) => {
    const response = await get({ headers: { range } }); expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-length')).toBe(String(text.length)); expect(await response.text()).toBe(text);
  });
  it.each(['bytes=10-', 'bytes=5-1', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=90071992547409999-', 'other=0-1'])('rejects invalid or excessive ranges: %s', async range => {
    const response = await get({ headers: { range } }); expect(response.status).toBe(416); expect(response.headers.get('content-range')).toBe('bytes */10'); expect(readCount).toBe(0);
  });
  it('authorizes HEAD and conditionals and implements If-Range instead of relying on R2', async () => {
    const head = await get({ method: 'HEAD', headers: { range: 'bytes=2-3' } }); expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe('10'); expect(head.headers.get('x-dreampost-session-expires-at')).toBe(String(descriptor.sessionExpiresAt)); expect(await head.text()).toBe(''); expect(readCount).toBe(0);
    const tag = `"sha256-${descriptor.sha256}"`;
    const unchanged = await get({ headers: { 'if-none-match': `W/${tag}` } }); expect(unchanged.status).toBe(304); expect(readCount).toBe(0);
    expect((await get({ headers: { 'if-match': '"wrong"' } })).status).toBe(412);
    const partial = await get({ headers: { range: 'bytes=2-3', 'if-range': tag } }); expect(partial.status).toBe(206); expect(await partial.text()).toBe('23');
    const full = await get({ headers: { range: 'bytes=2-3', 'if-range': '"changed"' } }); expect(full.status).toBe(200); expect(await full.text()).toBe('0123456789');
    expect(calls).toHaveLength(5);
  });
  it('supports an empty immutable object and rejects a range of it', async () => {
    const digest = await sha256Hex(new Uint8Array()); descriptor = { ...descriptor, sha256: digest, sizeBytes: 0, objectKey: attachmentObjectKey(aid, digest) };
    store.set(descriptor.objectKey, { digest, bytes: new Uint8Array() });
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get('content-length')).toBe('0'); expect(await response.text()).toBe('');
    expect((await get({ headers: { range: 'bytes=0-' } })).status).toBe(416);
  });
  it('requires the trusted app Origin for preview and binds it into authorization', async () => {
    descriptor.purpose = 'preview'; expect((await get()).status).toBe(403); expect(readCount).toBe(0);
    const response = await get({ headers: { origin: appOrigin } }); expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect(calls.at(-1)).toMatchObject({ requestOrigin: appOrigin });
    expect((await get({ headers: { origin: 'https://evil.example.com' } })).status).toBe(403);
  });
  it('rejects expired or mismatched grants before releasing any R2 bytes', async () => {
    descriptor.expiresAt = now - 1; expect((await get()).status).toBe(401); expect(readCount).toBe(0);
    descriptor.expiresAt = now + 60_000; descriptor.sessionId = tid; expect((await get()).status).toBe(503); expect(readCount).toBe(0);
  });
  it('rechecks expiry after asynchronous R2 work but does not cut off an admitted body', async () => {
    beforeBody = () => { clock = now + 61_000; };
    expect((await get()).status).toBe(503);
    clock = now; beforeBody = undefined; const response = await get(); expect(response.status).toBe(200);
    clock = now + 61_000; expect(await response.text()).toBe('0123456789');
  });
  it('rechecks admission expiry after HEAD before returning a conditional304', async () => {
    beforeHead = () => { clock = now + 61_000; };
    const response = await get({ headers: { 'if-none-match': `"sha256-${descriptor.sha256}"` } });
    expect(response.status).toBe(401); expect(readCount).toBe(0);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('binds actual R2 checksums and custom metadata to the immutable attachment identity', async () => {
    corruptMetadata = true; expect((await get()).status).toBe(503); expect(readCount).toBe(0);
    const value = { attachmentId: aid, sha256: descriptor.sha256, sizeBytes: data.length };
    const signed = await createAttachmentUploadHeaders(value, key, { nowMs: now });
    const response = await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body: data }), env);
    expect(response.status).toBe(409); expect(store.get(descriptor.objectKey)?.bytes).toEqual(data);
  });
  it('forces unknown or active MIME formats to a non-executable download type', async () => {
    descriptor.mimeType = 'text/html'; const response = await get();
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });
  it('fails closed on forged, malformed, redirected and oversized backend responses', async () => {
    for (const changed of [() => new Response('{}', { status: 200 }), () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }),
      () => new Response('x'.repeat(17 * 1024), { status: 200 })]) {
      wireTransform = changed; expect((await get()).status).toBe(503);
    }
    expect(readCount).toBe(0);
  });
  it('does not trust R2 custom metadata in place of the actual stored checksum', async () => {
    const item = store.get(descriptor.objectKey)!; item.digest = 'f'.repeat(64);
    expect((await get()).status).toBe(503); expect(readCount).toBe(0);
  });
  it('uses safe original-filename metadata without permitting header/path injection', async () => {
    descriptor.filename = '../invoices/\u6536\u636e "2026".pdf';
    const response = await get(); const header = response.headers.get('content-disposition')!;
    expect(header).toContain("filename*=UTF-8''"); expect(header).toContain('%E6%94%B6%E6%8D%AE'); expect(header).not.toContain('../'); expect(header).not.toContain('\n');
  });
  it('clears only the targeted cookie on signed invalid-session denial, not on outages', async () => {
    backend = () => ({ status: 401, reply: { version: 1, op: 'error', error: 'invalid_download_session' } });
    const denied = await get(); expect(denied.status).toBe(401); expect(denied.headers.getSetCookie()).toEqual([`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);
    backend = () => ({ status: 503, reply: { version: 1, op: 'error', error: 'backend_busy' } });
    const busy = await get(); expect(busy.status).toBe(503); expect(busy.headers.getSetCookie()).toEqual([]);
  });
});
describe('download Worker immutable upload and configuration', () => {
  it('streams a checksum-verified upload and returns a signed matching durable acknowledgment', async () => {
    const body = new TextEncoder().encode('new immutable attachment'); const descriptor = { attachmentId: aid, sha256: await sha256Hex(body), sizeBytes: body.length };
    const signed = await createAttachmentUploadHeaders(descriptor, key, { nowMs: now });
    const response = await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body }), env);
    expect(response.status).toBe(200);
    const ack = await verifyAttachmentUploadResponse(response.headers, new Uint8Array(await response.arrayBuffer()), { [key.id]: key.secret }, descriptor,
      { requestNonce: signed['x-dreampost-download-nonce'], nowMs: now });
    expect(store.get(ack.objectKey)?.bytes).toEqual(body); expect(putCount).toBe(1);
    const retry = await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body }), env);
    expect(retry.status).toBe(200); expect(putCount).toBe(2); expect(store.get(ack.objectKey)?.bytes).toEqual(body);
  });
  it('does not store bytes with the wrong digest or signed length', async () => {
    const value = { attachmentId: aid, sha256: await sha256Hex(bytes('expected')), sizeBytes: 3 };
    const signed = await createAttachmentUploadHeaders(value, key, { nowMs: now });
    const response = await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body: 'bad' }), env);
    expect(response.status).toBe(422); expect(store.has(attachmentObjectKey(aid, value.sha256))).toBe(false);
    const length = await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body: 'too long' }), env);
    expect(length.status).toBe(422); expect(store.has(attachmentObjectKey(aid, value.sha256))).toBe(false);
  });
  it('handles a zero-byte upload and rejects unauthorized uploads before R2 access', async () => {
    const value = { attachmentId: aid, sha256: await sha256Hex(new Uint8Array()), sizeBytes: 0 };
    const signed = await createAttachmentUploadHeaders(value, key, { nowMs: now });
    expect((await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed }), env)).status).toBe(200);
    expect((await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', body: 'unauthorized' }), env)).status).toBe(401); expect(putCount).toBe(1);
  });
  it('enforces schemeful same-site origins including private suffixes and a strict backend path', () => {
    expect(readConfig(env).secure).toBe(true);
    expect(() => readConfig({ ...env, APP_ORIGIN: 'https://alice.github.io', DOWNLOAD_ORIGIN: 'https://bob.github.io' })).toThrow();
    expect(() => readConfig({ ...env, DOWNLOAD_ORIGIN: 'https://download.example.net' })).toThrow();
    expect(() => readConfig({ ...env, DOWNLOAD_ORIGIN: appOrigin })).toThrow();
    expect(() => readConfig({ ...env, BACKEND_CONTROL_URL: 'https://api.example.com/arbitrary' })).toThrow();
    expect(() => readConfig({ ...env, APP_ORIGIN: 'http://mail.example.com' })).toThrow();
    expect(readConfig({ ...env, APP_ORIGIN: 'http://127.0.0.1:5173', DOWNLOAD_ORIGIN: 'http://127.0.0.1:8788', BACKEND_CONTROL_URL: 'http://127.0.0.1:3001/internal/v1/attachments/control', ALLOW_INSECURE_LOCAL: 'true' }).secure).toBe(false);
  });
});


describe('download Worker pre-authentication request-start protection', () => {
  it('fails closed without a production binding, before any backend or storage work', async () => {
    delete env.REQUEST_START_LIMITER;
    expect((await get()).status).toBe(503);
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow }), env)).status).toBe(503);
    const value = { attachmentId: aid, sha256: descriptor.sha256, sizeBytes: data.length };
    const signed = await createAttachmentUploadHeaders(value, key, { nowMs: now });
    expect((await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body: data }), env)).status).toBe(503);
    expect(calls).toHaveLength(0); expect(readCount).toBe(0); expect(putCount).toBe(0);
  });
  it('blocks well-formed forged cookies, bootstrap and uploads before backend callbacks', async () => {
    env.REQUEST_START_LIMITER = { limit: async () => ({ success: false }) };
    const blocked = await get({ headers: { cookie: `${cookieName}=${'Q'.repeat(43)}`, origin: appOrigin } });
    expect(blocked.status).toBe(429); expect(blocked.headers.get('retry-after')).toBe('60');
    expect(blocked.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect(blocked.headers.get('cache-control')).toContain('no-store'); expect(blocked.headers.getSetCookie()).toEqual([]);
    expect((await worker.fetch(post('/bootstrap/challenge', { flowId: flow }), env)).status).toBe(429);
    expect((await worker.fetch(post('/bootstrap/redeem', { flowId: flow, ticket: cookieSecret }, { cookie: `__Host-dp-bootstrap-${flow}=${cookieSecret}` }), env)).status).toBe(429);
    const value = { attachmentId: aid, sha256: descriptor.sha256, sizeBytes: data.length };
    const signed = await createAttachmentUploadHeaders(value, key, { nowMs: now });
    expect((await worker.fetch(request(`/internal/v1/objects/${aid}`, { method: 'PUT', headers: signed, body: data }), env)).status).toBe(429);
    expect(calls).toHaveLength(0); expect(readCount).toBe(0); expect(putCount).toBe(0);
  });
  it('does not let cookie/session/path or untrusted forwarding-header rotation reset the client bucket', async () => {
    const keys: string[] = [];
    env.REQUEST_START_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    await get({ headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.1' } });
    await worker.fetch(request(`/sessions/${tid}/transfers/${sid}`, { headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '203.0.113.2', cookie: `__Host-dp-download-${tid}=${'Q'.repeat(43)}` } }), env);
    await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { 'cf-connecting-ip': '192.0.2.10' }), env);
    expect(new Set(keys).size).toBe(1); expect(keys[0]).not.toContain('192.0.2.10'); expect(calls).toHaveLength(0);
    await get({ headers: { 'cf-connecting-ip': '192.0.2.11' } }); expect(keys[3]).not.toBe(keys[0]);
  });
  it('bounds missing/malformed addresses together and fails closed if the binding errors', async () => {
    const keys: string[] = [];
    env.REQUEST_START_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    await get(); await get({ headers: { 'cf-connecting-ip': 'attacker-controlled-invalid' } });
    expect(keys[0]).toBe(keys[1]);
    env.REQUEST_START_LIMITER = { limit: async () => { throw new Error('binding unavailable'); } };
    expect((await get()).status).toBe(503);
    env.REQUEST_START_LIMITER = { limit: async () => ({ success: 'yes' }) } as unknown as RateLimit;
    expect((await get()).status).toBe(503); expect(calls).toHaveLength(0);
  });
  it('permits explicit loopback-only bypass but rejects bypass on named deployments', async () => {
    expect(() => readConfig({ ...env, ALLOW_LOCAL_RATE_LIMIT_BYPASS: 'true' })).toThrow();
    expect(() => readConfig({ ...env, ALLOW_LOCAL_RATE_LIMIT_BYPASS: 'true', ALLOW_INSECURE_LOCAL: 'true' })).toThrow();
    const local = { ...env, APP_ORIGIN: 'http://127.0.0.1:5173', DOWNLOAD_ORIGIN: 'http://127.0.0.1:8788',
      BACKEND_CONTROL_URL: 'http://127.0.0.1:3001/internal/v1/attachments/control', ALLOW_INSECURE_LOCAL: 'true', ALLOW_LOCAL_RATE_LIMIT_BYPASS: 'true' };
    delete local.REQUEST_START_LIMITER;
    const response = await worker.fetch(new Request('http://127.0.0.1:8788/bootstrap/challenge', { method: 'POST', headers: { origin: local.APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ flowId: flow }) }), local);
    expect(response.status).toBe(200); expect(calls).toHaveLength(0);
  });
});


describe('download Worker owns only its credential cookie namespace', () => {
  it('ignores duplicated and malformed unrelated cookies on an authenticated download', async () => {
    const response = await get({ headers: { cookie: `${cookieName}=${cookieSecret}; _ga=1; _ga=2; junk; =bad; other=unclosed"` } });
    expect(response.status).toBe(200); expect(await response.text()).toBe('0123456789'); expect(calls).toHaveLength(1);
  });
  it('ignores unrelated cookies during bootstrap challenge and redeem', async () => {
    const junk = '_ga=1; _ga=2; junk';
    const challenge = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: junk }), env);
    expect(challenge.status).toBe(200);
    const redeem = await worker.fetch(post('/bootstrap/redeem', { flowId: flow, ticket: cookieSecret },
      { cookie: `__Host-dp-bootstrap-${flow}=${cookieSecret}; ${junk}` }), env);
    expect(redeem.status).toBe(200); expect(calls).toHaveLength(1);
  });
  it('does not count invalid UUID suffixes as owned sessions or bootstrap challenges', async () => {
    const junk = Array.from({ length: 40 }, (_, i) => `__Host-dp-download-junk${i}=${cookieSecret}; __Host-dp-bootstrap-junk${i}=${cookieSecret}`).join('; ');
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: junk }), env);
    expect(response.status).toBe(200); expect(calls).toHaveLength(0);
    expect(cookies(request(path, { headers: { cookie: junk } }), true).size).toBe(0);
  });
  it.each([
    cookieName, `${cookieName}=`, `${cookieName}="${cookieSecret}"`,
    `${cookieName}=too-short`, `${cookieName}=${cookieSecret}=`, `${cookieName}=not a secret`,
  ])('rejects a malformed selected owned credential without calling the backend: %s', async cookie => {
    const response = await get({ headers: { cookie } });
    expect(response.status).toBe(401); expect(calls).toHaveLength(0); expect(readCount).toBe(0);
  });
  it('rejects duplicate valid owned names even when unrelated to the selected transfer', async () => {
    const other = `__Host-dp-bootstrap-${flow}=${cookieSecret}`;
    const response = await get({ headers: { cookie: `${cookieName}=${cookieSecret}; ${other}; ${other}; _ga=1; _ga=2` } });
    expect(response.status).toBe(400); expect(calls).toHaveLength(0);
  });
  it('parses secure and explicit local cookie names only in their respective modes', () => {
    const localName = `dp-download-${sid}`;
    const raw = `${cookieName}=${cookieSecret}; ${localName}=${cookieSecret}; _ga=1; _ga=2; junk`;
    const req = request(path, { headers: { cookie: raw } });
    const production = cookies(req, true), local = cookies(req, false);
    expect([...production.keys()]).toEqual([cookieName]); expect([...local.keys()]).toEqual([localName]);
    expect(requireSecret(production, cookieName)).toBe(cookieSecret); expect(requireSecret(local, localName)).toBe(cookieSecret);
    expect(() => requireSecret(production, localName)).toThrow(); expect(() => requireSecret(local, cookieName)).toThrow();
    expect(() => cookies(request(path, { headers: { cookie: `${localName}=${cookieSecret}; ${localName}=${cookieSecret}` } }), false)).toThrow('duplicate_cookie');
  });
  it('retains the total cookie-header bound even when the excess cookies are unrelated', async () => {
    const response = await get({ headers: { cookie: `${cookieName}=${cookieSecret}; analytics=${'x'.repeat(16_384)}` } });
    expect(response.status).toBe(431); expect(calls).toHaveLength(0);
  });
});

describe('download Worker safe dead-cookie pruning and lifetime reporting', () => {
  it('clears only backend-confirmed dead cookies before enforcing the cap', async () => {
    env.MAX_DOWNLOAD_SESSIONS = '1';
    backend = value => {
      expect(value).toEqual({ version: 1, op: 'prune', sessions: [{ sessionId: sid, secretHash: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
      return { status: 200, reply: { version: 1, op: 'prune', expiredSessionIds: [sid] } };
    };
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, authHeaders()), env);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toContain(`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
    expect(response.headers.getSetCookie().some(value => value.startsWith(`__Host-dp-bootstrap-${flow}=`))).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it('does not evict a valid active session to create another one', async () => {
    env.MAX_DOWNLOAD_SESSIONS = '1';
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, authHeaders()), env);
    expect(response.status).toBe(429); expect(response.headers.getSetCookie()).toEqual([]);
    expect(calls[0]?.op).toBe('prune');
  });
  it('preserves requested sessions omitted from the dead set and clears malformed local values', async () => {
    const other = `__Host-dp-download-${tid}`;
    const malformed = `__Host-dp-download-${aid}`;
    backend = () => ({ status: 200, reply: { version: 1, op: 'prune', expiredSessionIds: [tid] } });
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow },
      { cookie: `${cookieName}=${cookieSecret}; ${other}=${cookieSecret}; ${malformed}=broken; _ga=1; _ga=2; junk` }), env);
    expect(response.status).toBe(200);
    const cleared = response.headers.getSetCookie().filter(value => value.includes('Max-Age=0'));
    expect(cleared).toHaveLength(2); expect(cleared.some(value => value.startsWith(`${other}=`))).toBe(true);
    expect(cleared.some(value => value.startsWith(`${malformed}=`))).toBe(true);
    expect(cleared.some(value => value.startsWith(`${cookieName}=`))).toBe(false);
    expect(calls[0]).toMatchObject({ op: 'prune', sessions: [{ sessionId: sid }, { sessionId: tid }] });
  });
  it('clears a malformed owned value locally when there is nothing to ask the backend', async () => {
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: `${cookieName}=broken` }), env);
    expect(response.status).toBe(200); expect(calls).toHaveLength(0);
    expect(response.headers.getSetCookie().some(value => value.startsWith(`${cookieName}=`) && value.includes('Max-Age=0'))).toBe(true);
  });
  it('rejects signed prune IDs outside the request without clearing any cookies', async () => {
    backend = () => ({ status: 200, reply: { version: 1, op: 'prune', expiredSessionIds: [tid] } });
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: `${cookieName}=${cookieSecret}; __Host-dp-download-${aid}=broken` }), env);
    expect(response.status).toBe(503); expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('does not clear cookies on a temporary prune failure', async () => {
    backend = () => ({ status: 503, reply: { version: 1, op: 'error', error: 'backend_busy' } });
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: `${cookieName}=${cookieSecret}; __Host-dp-download-${aid}=broken` }), env);
    expect(response.status).toBe(503); expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('never truncates an excessive prune request or silently drops unexamined sessions', async () => {
    const all = Array.from({ length: 33 }, (_, i) => `__Host-dp-download-e0000000-0000-4000-8000-${String(i).padStart(12, '0')}=${cookieSecret}`).join('; ');
    const response = await worker.fetch(post('/bootstrap/challenge', { flowId: flow }, { cookie: all }), env);
    expect(response.status).toBe(429); expect(response.headers.getSetCookie()).toEqual([]); expect(calls).toHaveLength(0);
  });
  it('reports the authorized fixed session expiry to credentialed HEAD clients', async () => {
    const response = await get({ method: 'HEAD', headers: { origin: appOrigin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-dreampost-session-expires-at')).toBe(String(descriptor.sessionExpiresAt));
    expect(response.headers.get('access-control-expose-headers')).toContain('X-DreamPost-Session-Expires-At');
    backend = () => ({ status: 401, reply: { version: 1, op: 'error', error: 'invalid_download_session' } });
    expect((await get({ method: 'HEAD' })).headers.get('x-dreampost-session-expires-at')).toBeNull();
  });
});
