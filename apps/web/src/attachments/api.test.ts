import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAttachmentAccessCache, getAttachments, parseAttachmentConfig, parseAttachmentList, prepareAttachmentAccess, readAttachmentRange, type AttachmentAccess, type AttachmentItem } from './api';

const config = { downloadOrigin: 'https://download.example.com', previewOrigin: 'https://preview.example.net', maxPreviewBytes: 25 * 1024 * 1024 };
const access = { mailboxId: 'mailbox/1', messageId: 'message?1', token: '', csrfToken: 'synthetic-csrf' };
const id = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222', transferId = '33333333-3333-4333-8333-333333333333';
const item: AttachmentItem = { id, filename: '<unsafe>.pdf', sizeBytes: 4, mimeType: 'application/pdf', sha256: 'a'.repeat(64), deliveryKind: 'mime', state: 'ready', previewKind: 'pdf' };
const session: AttachmentAccess = { sessionId, transferId, purpose: 'preview', expiresAt: Date.now() + 60_000, url: `${config.downloadOrigin}/sessions/${sessionId}/transfers/${transferId}` };
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
beforeEach(() => { vi.stubGlobal('localStorage', new MemoryStorage()); vi.stubGlobal('navigator', {}); });
afterEach(() => { clearAttachmentAccessCache(); vi.unstubAllGlobals(); });

function headResponse(overrides: Record<string, string | undefined> = {}, status = 200) {
  const headers = new Headers({ ETag: `"sha256-${item.sha256}"`, 'Content-Length': String(item.sizeBytes), 'X-DreamPost-Session-Expires-At': String(Date.now() + 3600_000) });
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) headers.set(key, value);
  return new Response(null, { status, headers });
}
function bootstrap(overrides: { challenge?: Record<string, unknown>; redeem?: Record<string, unknown> } = {}) {
  let purpose: AttachmentAccess['purpose'] = 'preview';
  const fetcher = vi.fn(async (input: string, options: RequestInit) => {
    if (options.method === 'HEAD') return headResponse();
    const body = JSON.parse(String(options.body));
    if (input.endsWith('/challenge')) return Response.json({ flowId: body.flowId, challengeHash: 'b'.repeat(64), ...overrides.challenge });
    if (input.endsWith('/redeem')) return Response.json({ ...session, purpose, ...overrides.redeem });
    if (input.endsWith('/transfers')) return Response.json({ ...session, purpose: body.purpose, expiresAt: Date.now() + 3600_000 });
    purpose = body.purpose;
    return Response.json({ ticket: 'opaque-signed-bootstrap-ticket' });
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
function rangeResponse(bytes = new Uint8Array([1, 2]), overrides: Record<string, string | undefined> = {}, status = 206) {
  const headers = new Headers({ ETag: `"sha256-${item.sha256}"`, 'Content-Range': 'bytes 1-2/4', 'Content-Length': '2' });
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) headers.set(key, value);
  return new Response(bytes, { status, headers });
}

describe('attachment configuration and metadata', () => {
  it('keeps an unconfigured attachment feature unavailable', () => expect(parseAttachmentConfig(undefined, 'https://mail.example.com')).toBeUndefined());
  it('accepts exact isolated origins', () => expect(parseAttachmentConfig(config, 'https://mail.example.com')).toEqual(config));
  it.each([
    { ...config, previewOrigin: 'https://mail.example.com:8443' },
    { ...config, previewOrigin: 'https://download.example.com:8443' },
    { ...config, downloadOrigin: 'https://mail.example.com' },
    { ...config, downloadOrigin: 'https://mail.example.com:9443' },
    { ...config, downloadOrigin: 'https://download.example.com/path' },
    { ...config, previewOrigin: 'http://preview.example.net' },
  ])('rejects unsafe origin configuration %j', value => expect(() => parseAttachmentConfig(value, 'https://mail.example.com')).toThrow());
  it('preserves filenames as plain strings and rejects duplicate attachment identities', () => {
    expect(parseAttachmentList({ state: 'ready', items: [item] }).items[0]?.filename).toBe('<unsafe>.pdf');
    expect(() => parseAttachmentList({ state: 'ready', items: [item, item] })).toThrow();
  });
  it('does not interpret an unknown shared delivery as an inline MIME attachment', () => expect(() => parseAttachmentList({ state: 'ready', items: [{ ...item, deliveryKind: 'shared-link' }] })).toThrow());
  it('preserves mailbox authorization on the metadata request', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ state: 'ready', items: [item] })); vi.stubGlobal('fetch', fetcher);
    await getAttachments({ ...access, token: 'dev-secret' }, new AbortController().signal);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/mailboxes/mailbox%2F1/messages/message%3F1/attachments');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer dev-secret' } });
  });
});

describe('download session bootstrap', () => {
  it('uses a CSPRNG flow and keeps application credentials off the download host', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const first = fetcher.mock.calls[0]!, second = fetcher.mock.calls[1]!, third = fetcher.mock.calls[2]!;
    const flow = JSON.parse(String(first[1].body)).flowId;
    expect(flow).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first[1]).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
    expect(first[1].headers).not.toHaveProperty('Authorization'); expect(first[1].headers).not.toHaveProperty('X-CSRF-Token');
    expect(second[1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-CSRF-Token': 'synthetic-csrf' } });
    expect(JSON.parse(String(second[1].body))).toEqual({ flowId: flow, challengeHash: 'b'.repeat(64), purpose: 'preview' });
    expect(JSON.parse(String(third[1].body))).toEqual({ flowId: flow, ticket: 'opaque-signed-bootstrap-ticket' });
    expect(third[1].headers).not.toHaveProperty('X-CSRF-Token');
  });
  it('uses the development bearer only for the local ticket endpoint', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, { ...access, token: 'fixed-mailbox-secret', csrfToken: undefined }, item, 'preview', new AbortController().signal);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ credentials: 'omit', headers: { Authorization: 'Bearer fixed-mailbox-secret' } });
    expect(fetcher.mock.calls[0]?.[1].headers).not.toHaveProperty('Authorization');
    expect(fetcher.mock.calls[2]?.[1].headers).not.toHaveProperty('Authorization');
  });
  it('reuses an existing session while authorizing a new attachment transfer independently', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    await prepareAttachmentAccess(config, access, { ...item, id: sessionId }, 'preview', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls[4]?.[0]).toContain(`/${sessionId}/transfers`);
    expect(JSON.parse(String(fetcher.mock.calls[4]?.[1].body))).toEqual({ sessionId, purpose: 'preview' });
  });
  it('does not retry a denied transfer by silently creating a new session', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    fetcher.mockImplementation(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
    await expect(prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('starts a fresh challenge exactly once when the old session is not active', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    fetcher.mockImplementationOnce(async () => Response.json({ error: 'not_active' }, { status: 409 }));
    await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(fetcher.mock.calls[5]?.[0]).toBe(`${config.downloadOrigin}/bootstrap/challenge`);
  });
  it('does not reuse sessions across authentication sources', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    await prepareAttachmentAccess(config, { ...access, csrfToken: 'another-session-csrf' }, item, 'preview', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(8); expect(fetcher.mock.calls[4]?.[0]).toBe(`${config.downloadOrigin}/bootstrap/challenge`);
  });

  it('verifies credentialed HEAD readiness before returning either fresh or reused access', async () => {
    const fetcher = bootstrap();
    const first = await prepareAttachmentAccess(config, access, item, 'download', new AbortController().signal);
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'error' });
    expect(first.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    await prepareAttachmentAccess(config, access, item, 'download', new AbortController().signal);
    expect(fetcher.mock.calls.filter(call => call[1].method === 'HEAD')).toHaveLength(2);
  });
  it('recovers a missing cookie by replacing the matching cached session once', async () => {
    const fetcher = bootstrap(); const originalAccess = await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    const ordinary = fetcher.getMockImplementation()!;
    const replacementId = '44444444-4444-4444-8444-444444444444';
    fetcher.mockImplementation(async (input, options) => {
      if (options.method === 'HEAD' && input.includes(sessionId)) return headResponse({}, 401);
      if (input.endsWith('/redeem')) return Response.json({ ...session, sessionId: replacementId, url: `${config.downloadOrigin}/sessions/${replacementId}/transfers/${transferId}` });
      return ordinary(input, options);
    });
    const recovered = await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    expect(recovered.sessionId).toBe(replacementId);
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/challenge'))).toHaveLength(2);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(readAttachmentRange(config, originalAccess, item, 1, 3, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).sessionId).toBe(replacementId);
  });
  it('never falls back after a forbidden HEAD and does not cache the unusable session', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    const ordinary = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, options) => options.method === 'HEAD' ? headResponse({}, 403) : ordinary(input, options));
    await expect(prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/challenge'))).toHaveLength(1);
    expect(localStorage.length).toBe(0);
  });
  it('does not return a ready URL when a fresh cookie was not accepted', async () => {
    const fetcher = bootstrap(), ordinary = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, options) => options.method === 'HEAD' ? headResponse({}, 401) : ordinary(input, options));
    await expect(prepareAttachmentAccess(config, access, item, 'download', new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(localStorage.length).toBe(0); expect(fetcher.mock.calls.filter(call => call[0].endsWith('/challenge'))).toHaveLength(1);
  });
  it.each([{ ETag: '"wrong"' }, { 'Content-Length': '999' }, { 'X-DreamPost-Session-Expires-At': 'invalid' }])('rejects incorrect HEAD metadata %j', async overrides => {
    const fetcher = bootstrap(), ordinary = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, options) => options.method === 'HEAD' ? headResponse(overrides) : ordinary(input, options));
    await expect(prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal)).rejects.toThrow(); expect(localStorage.length).toBe(0);
  });
  it('invalidates only the preview-purpose locator after a denied Range', async () => {
    const fetcher = bootstrap(); const preview = await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    await prepareAttachmentAccess(config, access, item, 'download', new AbortController().signal);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(readAttachmentRange(config, preview, item, 1, 3, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(localStorage.length).toBe(1); expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).purpose).toBe('download');
  });
  it('does not let a late Range failure clear a different authentication source', async () => {
    const fetcher = bootstrap(); const old = await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    await prepareAttachmentAccess(config, { ...access, csrfToken: 'different-current-session' }, item, 'preview', new AbortController().signal);
    const before = localStorage.getItem(localStorage.key(0)!);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(readAttachmentRange(config, old, item, 1, 3, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(before);
  });
  it('persists only a noncredential locator and reuses it after twenty module reloads', async () => {
    const fetcher = bootstrap(); await prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(Object.keys(stored).sort()).toEqual(['expiresAt', 'purpose', 'sessionId']);
    expect(localStorage.key(0)).not.toContain(access.csrfToken);
    for (let index = 0; index < 20; index++) {
      vi.resetModules(); const reloaded = await import('./api');
      await reloaded.prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    }
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/challenge'))).toHaveLength(1);
    clearAttachmentAccessCache(); expect(localStorage.length).toBe(0);
  });
  it('serializes concurrent first use while authorizing both requested transfers', async () => {
    const fetcher = bootstrap();
    await Promise.all([prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal), prepareAttachmentAccess(config, access, { ...item, id: sessionId }, 'preview', new AbortController().signal)]);
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/challenge'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/transfers'))).toHaveLength(1);
  });
  it('lets an aborted lock waiter leave without cancelling the active caller', async () => {
    const fetcher = bootstrap(), ordinary = fetcher.getMockImplementation()!;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    fetcher.mockImplementation(async (input, options) => { if (input.endsWith('/challenge')) { entered = true; await held; } return ordinary(input, options); });
    const first = prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal);
    await vi.waitFor(() => expect(entered).toBe(true));
    const controller = new AbortController(); const second = prepareAttachmentAccess(config, access, item, 'preview', controller.signal);
    controller.abort(); await expect(second).rejects.toMatchObject({ name: 'AbortError' }); release(); await first;
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/challenge'))).toHaveLength(1);
  });

  it('stops before ticket issuance when the challenge belongs to another flow', async () => {
    const fetcher = bootstrap({ challenge: { flowId: id } });
    await expect(prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { url: 'https://attacker.example.com/file' }, { url: `${session.url}?token=leaked` },
    { purpose: 'download' }, { expiresAt: 1 },
  ])('rejects an inconsistent or expired redemption %j', async redeem => {
    bootstrap({ redeem }); await expect(prepareAttachmentAccess(config, access, item, 'preview', new AbortController().signal)).rejects.toThrow();
  });
});

describe('bounded attachment byte reads', () => {
  it('uses only the scoped cookie URL and verifies exact representation/range metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(rangeResponse()); vi.stubGlobal('fetch', fetcher);
    expect(new Uint8Array(await readAttachmentRange(config, session, item, 1, 3, new AbortController().signal))).toEqual(new Uint8Array([1, 2]));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', redirect: 'error', headers: { Range: 'bytes=1-2', 'If-Range': `"sha256-${item.sha256}"` } });
  });
  it.each([
    { ETag: '"another-file"' }, { 'Content-Range': 'bytes 0-1/4' }, { 'Content-Length': '4' }, { 'Content-Encoding': 'gzip' },
  ])('rejects mismatched byte metadata %j', async overrides => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rangeResponse(undefined, overrides)));
    await expect(readAttachmentRange(config, session, item, 1, 3, new AbortController().signal)).rejects.toThrow();
  });
  it('never appends a full 200 representation to a requested range', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rangeResponse(undefined, {}, 200)));
    await expect(readAttachmentRange(config, session, item, 1, 3, new AbortController().signal)).rejects.toThrow();
  });
  it.each([new Uint8Array([1]), new Uint8Array([1, 2, 3])])('rejects incomplete and oversized actual response bodies', async bytes => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rangeResponse(bytes)));
    await expect(readAttachmentRange(config, session, item, 1, 3, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects a download-purpose session and out-of-bounds input before fetching', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(readAttachmentRange(config, { ...session, purpose: 'download' }, item, 1, 3, new AbortController().signal)).rejects.toThrow();
    await expect(readAttachmentRange(config, session, item, -1, 3, new AbortController().signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
