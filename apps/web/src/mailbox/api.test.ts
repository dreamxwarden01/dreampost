import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePage, loadMail, mailRequest, parseRetryAfter, watchMailbox } from './api';
const capabilities = { canSetPersonalFlags: true, canManageMessages: false, canManageLabels: false };
afterEach(() => vi.unstubAllGlobals());
describe('mailbox client boundaries', () => {
  it('background literal search preserves the opaque cursor and does not renew foreground activity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ view: 'messages', messages: [], nextCursor: null, changeSequence: '9007199254740999', capabilities })); vi.stubGlobal('fetch', fetch);
    const result = await loadMail('box', { folder: 'inbox', view: 'messages', q: '中文 + literal%', unread: true }, 'opaque:cursor/value', new AbortController().signal, true);
    const [path, options] = fetch.mock.calls[0]!; const url = new URL(String(path), 'https://mail.example.test');
    expect(url.searchParams.get('q')).toBe('中文 + literal%'); expect(url.searchParams.get('cursor')).toBe('opaque:cursor/value'); expect(options?.headers).toMatchObject({ 'X-DreamPost-Background': '1' }); expect(options?.credentials).toBe('same-origin'); expect(result.changeSequence).toBe('9007199254740999');
  });
  it('rejects a numeric message revision rather than rounding a server concurrency token', () => {
    expect(() => decodePage({ view: 'messages', messages: [{ id: 'one', threadId: null, read: false, starred: false, folder: 'inbox', labelIds: [], version: 1 }], nextCursor: null, changeSequence: '1', capabilities })).toThrow();
  });
  it('preserves both Retry-After forms on a transient response', async () => {
    const now = Date.parse('2026-09-27T00:00:00Z'); expect(parseRetryAfter('120', now)).toBe(120000); expect(parseRetryAfter('Sun, 27 Sep 2026 00:02:00 GMT', now)).toBe(120000); expect(parseRetryAfter('invalid', now)).toBeUndefined();
    vi.stubGlobal('fetch', async () => Response.json({ error: 'outbound_busy' }, { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(mailRequest('/api/fixture')).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
  });
  it('stops an unauthorized live connection without an automatic reconnect loop', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 401 })); vi.stubGlobal('fetch', fetch); const status = vi.fn();
    await watchMailbox('box', new AbortController().signal, vi.fn(), status); expect(fetch).toHaveBeenCalledTimes(1); expect(status).toHaveBeenLastCalledWith('expired');
  });
  it('treats an SSE history reset as a scoped invalidation without exposing event content', async () => {
    const controller = new AbortController(); const invalidate = vi.fn(() => controller.abort());
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('id: 12\nevent: reset\ndata: {"sequence":"12"}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await watchMailbox('box', controller.signal, invalidate, vi.fn()); expect(invalidate).toHaveBeenCalledExactlyOnceWith();
  });
});
