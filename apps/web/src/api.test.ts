import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, errorMessage, getMailbox, getMessage, getMessages, getRawMessage } from './api';

const token = 'development-test-token-with-32-characters';
const summary = {
  id: 'message-1', subject: 'Hello', from: 'sender@example.test', to: 'inbox@example.test',
  receivedAt: '2026-09-25T12:00:00Z', preview: 'Message preview', status: 'parsed', sizeBytes: 123,
};

function mockResponse(value: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('development mailbox API', () => {
  it('uses same-origin bearer requests without cookie credentials or redirects', async () => {
    const fetchMock = mockResponse({ mailboxes: [{ id: 'mailbox-1', address: 'inbox@example.test', name: 'Test inbox' }] });
    const signal = new AbortController().signal;
    const mailbox = await getMailbox(token, signal);
    expect(mailbox.id).toBe('mailbox-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/mailboxes', {
      signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
  });

  it('rejects a response exposing more than the fixed development mailbox', async () => {
    const mailbox = { id: 'mailbox-1', address: 'inbox@example.test', name: 'Test inbox' };
    mockResponse({ mailboxes: [mailbox, { ...mailbox, id: 'mailbox-2' }] });
    await expect(getMailbox(token, new AbortController().signal)).rejects.toThrow('exactly one');
  });

  it('preserves international message text and encodes IDs as path components', async () => {
    const preview = '\u90ae\u4ef6 receipt';
    const fetchMock = mockResponse({ messages: [{ ...summary, preview }] });
    const messages = await getMessages('a/b?c', token, new AbortController().signal);
    expect(messages[0]?.preview).toBe(preview);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/mailboxes/a%2Fb%3Fc/messages');
  });

  it('rejects malformed API data rather than silently showing an empty inbox', async () => {
    mockResponse({ messages: [{ ...summary, from: { html: '<script>unexpected</script>' } }] });
    await expect(getMessages('mailbox-1', token, new AbortController().signal)).rejects.toThrow('invalid response');
  });

  it('requires message detail to match the requested ID', async () => {
    mockResponse({ message: { ...summary, id: 'another-message', text: 'Wrong message' } });
    await expect(getMessage('mailbox-1', 'message-1', token, new AbortController().signal)).rejects.toThrow('invalid response');
  });

  it('does not echo backend error bodies that might contain sensitive information', async () => {
    mockResponse({ error: token }, 401);
    const failure = await getMailbox(token, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(errorMessage(failure)).toContain('token was rejected');
    expect(errorMessage(failure)).not.toContain(token);
  });

  it('preserves cancellation instead of replacing it with a connection error', async () => {
    const controller = new AbortController();
    const failure = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    controller.abort();
    await expect(getMailbox(token, controller.signal)).rejects.toBe(failure);
  });

  it('downloads the original as authenticated bytes without putting the token in the URL', async () => {
    const raw = 'From: sender@example.test\r\nSubject: Raw\r\n\r\nOriginal body\r\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(raw, { headers: { 'content-type': 'message/rfc822' } }));
    vi.stubGlobal('fetch', fetchMock);
    const blob = await getRawMessage('mailbox-1', 'message-1', token, new AbortController().signal);
    expect(await blob.text()).toBe(raw);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/mailboxes/mailbox-1/messages/message-1/raw');
    expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('does not save an HTML proxy fallback as an original email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy error</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(getRawMessage('mailbox-1', 'message-1', token, new AbortController().signal)).rejects.toThrow('invalid response');
  });
});
