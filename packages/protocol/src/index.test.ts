import { describe, expect, it } from 'vitest';
import { createDeliveryHeaders, matchesAck, normalizeRecipientAddress, ProtocolError, sha256Hex, validateMetadata, verifyDeliveryBody, verifyDeliveryHeaders } from './index.js';
import type { DeliveryMetadata } from './index.js';

const raw = new TextEncoder().encode('From: sender@example.test\r\nTo: inbox@example.test\r\nSubject: Example\r\n\r\nHello.\r\n');
const key = { id: 'primary', secret: 'test-only-signing-secret-with-at-least-32-bytes' };
const nowMs = Date.parse('2026-09-25T12:00:00.000Z');
const metadata: DeliveryMetadata = {
  version: 1,
  deliveryId: '73a51f44-cc76-4578-8fce-86cb1f2b9e84',
  mailboxId: '33333333-3333-4333-8333-333333333333',
  envelopeFrom: 'sender@example.test',
  envelopeTo: 'inbox@example.test',
  receivedAt: '2026-09-25T11:59:59.000Z',
  rawSize: raw.byteLength,
};

async function signed() { return createDeliveryHeaders(metadata, raw, key, { nowMs }); }

describe('delivery authentication', () => {
  it('round-trips raw bytes and binds the configured mailbox and envelope', async () => {
    const headers = await signed();
    const checked = await verifyDeliveryHeaders(new Headers(headers), { primary: key.secret }, { nowMs });
    expect(checked.metadata).toEqual(metadata);
    await expect(verifyDeliveryBody(raw, checked)).resolves.toBeUndefined();
    expect(checked.sha256).toBe(await sha256Hex(raw));
  });

  it('rejects envelope or mailbox metadata tampering even with the same body', async () => {
    const headers = await signed();
    const changed = { ...metadata, mailboxId: '44444444-4444-4444-8444-444444444444' };
    headers['x-dreampost-metadata'] = btoa(JSON.stringify(changed)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    await expect(verifyDeliveryHeaders(headers, { primary: key.secret }, { nowMs })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects altered body bytes after authenticating the declared digest', async () => {
    const checked = await verifyDeliveryHeaders(await signed(), { primary: key.secret }, { nowMs });
    const altered = new Uint8Array(raw); altered[altered.length - 3] = 88;
    await expect(verifyDeliveryBody(altered, checked)).rejects.toMatchObject({ code: 'digest_mismatch' });
  });

  it('rejects stale and future signatures', async () => {
    const headers = await signed();
    for (const delta of [-301_000, 301_000]) {
      await expect(verifyDeliveryHeaders(headers, { primary: key.secret }, { nowMs: nowMs + delta })).rejects.toMatchObject({ code: 'expired' });
    }
  });

  it('supports delayed delivery with a freshly signed attempt', async () => {
    const tomorrow = nowMs + 86_400_000;
    const headers = await createDeliveryHeaders(metadata, raw, key, { nowMs: tomorrow });
    const checked = await verifyDeliveryHeaders(headers, { primary: key.secret }, { nowMs: tomorrow });
    expect(checked.metadata.deliveryId).toBe(metadata.deliveryId);
    expect(checked.metadata.receivedAt).toBe(metadata.receivedAt);
  });

  it('rejects unknown keys, wrong secrets, repeated headers, and weak keys', async () => {
    const headers = await signed();
    await expect(verifyDeliveryHeaders(headers, {}, { nowMs })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verifyDeliveryHeaders(headers, { primary: 'another-secret-that-is-at-least-32-bytes' }, { nowMs })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verifyDeliveryHeaders({ ...headers, 'X-DreamPost-Key-Id': 'primary' }, { primary: key.secret }, { nowMs })).rejects.toBeInstanceOf(ProtocolError);
    await expect(createDeliveryHeaders(metadata, raw, { id: 'primary', secret: 'short' })).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('permits empty SMTP envelope senders but rejects missing destinations and control characters', () => {
    expect(validateMetadata({ ...metadata, envelopeFrom: '' }).envelopeFrom).toBe('');
    expect(normalizeRecipientAddress('Inbox+Tag@Example.TEST')).toBe('inbox+tag@example.test');
    expect(validateMetadata({ ...metadata, envelopeTo: 'Inbox@Example.TEST' }).envelopeTo).toBe('Inbox@Example.TEST');
    expect(() => validateMetadata({ ...metadata, envelopeTo: '' })).toThrow(ProtocolError);
    expect(() => validateMetadata({ ...metadata, envelopeTo: 'a@example.test\r\nInjected: yes' })).toThrow(ProtocolError);
    expect(() => validateMetadata({ ...metadata, extra: 'ignored?' })).toThrow(ProtocolError);
    expect(() => validateMetadata({ ...metadata, receivedAt: '2026-02-31T00:00:00Z' })).toThrow(ProtocolError);
  });

  it('does not accept a generic success response or an unrelated receipt', async () => {
    const sha256 = await sha256Hex(raw);
    const expected = { deliveryId: metadata.deliveryId, sha256 };
    expect(matchesAck({ version: 1, status: 'stored', ...expected }, expected)).toBe(true);
    expect(matchesAck({ success: true }, expected)).toBe(false);
    expect(matchesAck({ version: 1, status: 'stored', ...expected, sha256: '0'.repeat(64) }, expected)).toBe(false);
    expect(matchesAck('<html>Login successful</html>', expected)).toBe(false);
  });
});
