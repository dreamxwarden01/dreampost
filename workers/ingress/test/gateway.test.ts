import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, verifyDeliveryBody, verifyDeliveryHeaders } from '@dreampost/protocol';
import type { DeliveryMetadata } from '@dreampost/protocol';
import { Gateway, LEASE_MS, pushTimeoutMs, REQUEUE_AFTER_MS } from '../src/core.js';
import { readConfig } from '../src/config.js';
import type { GatewayConfig } from '../src/config.js';
import type { DeliveryPatch, DeliveryRecord, DeliveryState, InboundMessage, Ledger, RawStore, StoredRaw } from '../src/model.js';

const mailboxId = '11111111-1111-4111-8111-111111111111';
const secret = 'development-only-change-this-32-byte-secret';
const bytes = new TextEncoder().encode('From: sender@example.test\r\nTo: inbox@example.test\r\nSubject: Test\r\n\r\nA body with \u4e2d\u6587.\r\n');
const clone = <T>(value: T): T => structuredClone(value);

class MemoryLedger implements Ledger {
  records = new Map<string, DeliveryRecord>();
  failUpdates = 0;
  async insert(record: DeliveryRecord) {
    if (this.records.has(record.deliveryId)) throw new Error('Duplicate');
    this.records.set(record.deliveryId, clone(record));
  }
  async get(id: string) { return clone(this.records.get(id) ?? null); }
  async claim(id: string, state: DeliveryState, token: string, now: number, leaseMs: number) {
    const record = this.records.get(id);
    if (!record || record.state !== state || record.nextAttemptAt > now || (record.leaseUntil !== null && record.leaseUntil > now)) return null;
    Object.assign(record, { leaseToken: token, leaseUntil: now + leaseMs, updatedAt: now, attempts: record.attempts + 1 });
    return clone(record);
  }
  async updateOwned(id: string, token: string, state: DeliveryState, patch: DeliveryPatch) {
    if (this.failUpdates-- > 0) throw new Error('Database unavailable');
    const record = this.records.get(id);
    if (!record || record.state !== state || record.leaseToken !== token) return false;
    Object.assign(record, clone(patch));
    return true;
  }
  async noteEnqueued(id: string, now: number) {
    const record = this.records.get(id);
    if (record?.state === 'stored') record.lastEnqueuedAt = now;
  }
  async purgeDone(before: number, limit: number) {
    const expired = [...this.records.values()].filter(record => record.state === 'done'
      && record.updatedAt < before && record.leaseToken === null).slice(0, limit);
    for (const record of expired) this.records.delete(record.deliveryId);
    return expired.length;
  }
  async due(now: number, limit: number, staleQueueBefore: number) {
    return [...this.records.values()].filter(record => ['receiving', 'stored', 'delivered_pending_delete'].includes(record.state)
      && record.nextAttemptAt <= now && (record.leaseUntil === null || record.leaseUntil <= now)
      && (record.state !== 'stored' || record.lastEnqueuedAt === null || record.lastEnqueuedAt <= staleQueueBefore))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt).slice(0, limit).map(clone);
  }
}

class MemoryRaw implements RawStore {
  objects = new Map<string, StoredRaw>();
  failDelete = 0;
  failPut = false;
  deletes = 0;
  async put(id: string, raw: Uint8Array, metadata: DeliveryMetadata, sha256: string) {
    if (this.failPut) throw new Error('R2 unavailable');
    this.objects.set(id, { bytes: new Uint8Array(raw), metadata: clone(metadata), sha256 });
  }
  async get(id: string) { return clone(this.objects.get(id) ?? null); }
  async delete(id: string) {
    this.deletes++;
    if (this.failDelete-- > 0) throw new Error('R2 delete unavailable');
    this.objects.delete(id);
  }
}

function fixture() {
  let now = Date.parse('2026-09-25T12:00:00Z');
  let uuid = 0;
  const ledger = new MemoryLedger();
  const raw = new MemoryRaw();
  const messages: { deliveryId: string }[] = [];
  const queue = { fail: false, send: vi.fn(async (body: { deliveryId: string }) => {
    if (queue.fail) throw new Error('Queue unavailable');
    expect((await ledger.get(body.deliveryId))?.state).toBe('stored');
    messages.push(body);
  }) };
  const config: GatewayConfig = { routes: { 'inbox@example.test': mailboxId },
    backendUrl: 'https://api.example.test/internal/v1/deliveries', key: { id: 'development', secret }, doneRetentionDays: 7 };
  const calls: { headers: Headers; raw: Uint8Array }[] = [];
  const local = new Map<string, string>();
  const backend = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const rawBytes = new Uint8Array(init?.body as Uint8Array);
    calls.push({ headers, raw: rawBytes });
    const verified = await verifyDeliveryHeaders(headers, { development: secret }, { nowMs: now });
    await verifyDeliveryBody(rawBytes, verified);
    const old = local.get(verified.metadata.deliveryId);
    if (old && old !== verified.sha256) return new Response(null, { status: 409 });
    local.set(verified.metadata.deliveryId, verified.sha256);
    return Response.json({ version: 1, deliveryId: verified.metadata.deliveryId, sha256: verified.sha256, status: 'stored' });
  });
  const log = vi.fn();
  const gateway = new Gateway({ ledger, raw, queue, config, fetch: backend as typeof fetch, now: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, log });
  function message(to = 'inbox@example.test'): InboundMessage {
    return { from: 'sender@example.test', to, rawSize: bytes.length,
      raw: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }),
      setReject: vi.fn() };
  }
  async function receive() {
    await gateway.receive(message());
    return [...ledger.records.keys()].at(-1)!;
  }
  return { ledger, raw, queue, config, gateway, backend, local, calls, messages, log, message, receive,
    advance(ms: number) { now += ms; }, now: () => now };
}

describe('inbound gateway', () => {
  it('rejects unconfigured exact recipients before persistence', async () => {
    const f = fixture();
    for (const address of ['unknown@example.test', 'inbox+tag@example.test']) {
      const message = f.message(address);
      await f.gateway.receive(message);
      expect(message.setReject).toHaveBeenCalledOnce();
    }
    expect(f.ledger.records.size).toBe(0);
    expect(f.raw.objects.size).toBe(0);
  });

  it('matches a recipient case-insensitively while signing its original spelling', async () => {
    const f = fixture();
    const incoming = f.message('INBOX@EXAMPLE.TEST');
    await f.gateway.receive(incoming);
    expect(incoming.setReject).not.toHaveBeenCalled();
    const record = [...f.ledger.records.values()][0]!;
    expect(record.metadata.envelopeTo).toBe('INBOX@EXAMPLE.TEST');
    await f.gateway.deliver(record.deliveryId);
    const verified = await verifyDeliveryHeaders(f.calls[0]!.headers, { development: secret }, { nowMs: f.now() });
    expect(verified.metadata.envelopeTo).toBe('INBOX@EXAMPLE.TEST');
  });

  it('defers finalization after a lost CAS once complete raw data is safely stored', async () => {
    const f = fixture();
    vi.spyOn(f.ledger, 'updateOwned').mockResolvedValueOnce(false);
    const id = await f.receive();
    expect(f.ledger.records.get(id)?.state).toBe('receiving');
    expect(f.raw.objects.has(id)).toBe(true);
    expect(f.log).toHaveBeenCalledWith('receipt_finalization_deferred', id);
    f.advance(LEASE_MS + 1);
    await f.gateway.repair();
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
  });

  it('persists complete bytes and uses a matching durable ACK before deleting', async () => {
    const f = fixture();
    const originalPut = f.raw.put.bind(f.raw);
    f.raw.put = async (id, body, metadata, digest) => {
      expect((await f.ledger.get(id))?.state).toBe('receiving');
      await originalPut(id, body, metadata, digest);
    };
    const originalDelete = f.raw.delete.bind(f.raw);
    f.raw.delete = async id => {
      expect((await f.ledger.get(id))?.state).toBe('delivered_pending_delete');
      expect(f.local.has(id)).toBe(true);
      await originalDelete(id);
    };
    const id = await f.receive();
    expect(f.raw.objects.get(id)?.bytes).toEqual(bytes);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
    expect(f.calls[0]?.raw).toEqual(bytes);
    expect(f.ledger.records.get(id)?.state).toBe('done');
    expect(f.raw.objects.size).toBe(0);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
    expect(f.backend).toHaveBeenCalledOnce();
  });

  it('keeps stored mail after enqueue failure and repairs after a queue retention interval', async () => {
    const f = fixture();
    f.queue.fail = true;
    const id = await f.receive();
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
    f.advance(15 * 86400_000);
    f.queue.fail = false;
    await f.gateway.repair();
    expect(f.messages).toEqual([{ deliveryId: id }]);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
  });

  it('recreates a lost queue pointer after the repair interval', async () => {
    const f = fixture();
    const id = await f.receive();
    f.messages.length = 0;
    f.advance(REQUEUE_AFTER_MS + 1);
    await f.gateway.repair();
    expect(f.messages).toEqual([{ deliveryId: id }]);
  });

  it('accepts durable R2 data when finalization fails and later repairs receiving state', async () => {
    const f = fixture();
    f.ledger.failUpdates = 1;
    await expect(f.receive()).resolves.toBeDefined();
    const id = [...f.ledger.records.keys()][0]!;
    expect(f.ledger.records.get(id)?.state).toBe('receiving');
    expect(f.raw.objects.has(id)).toBe(true);
    f.advance(LEASE_MS + 1);
    await f.gateway.repair();
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
  });

  it('never deletes old receiving objects and can recover a late completed upload', async () => {
    const f = fixture();
    f.raw.failPut = true;
    await expect(f.receive()).rejects.toThrow();
    const record = [...f.ledger.records.values()][0]!;
    f.advance(30 * 86400_000);
    await f.gateway.repair();
    expect(f.ledger.records.get(record.deliveryId)?.state).toBe('receiving');
    expect(f.raw.deletes).toBe(0);
    f.raw.failPut = false;
    await f.raw.put(record.deliveryId, bytes, record.metadata, await sha256Hex(bytes));
    f.advance(3600_000);
    await f.gateway.repair();
    expect(f.ledger.records.get(record.deliveryId)?.state).toBe('stored');
    expect(f.raw.deletes).toBe(0);
  });

  it('freshly signs a lost-ACK retry and stores only one local delivery', async () => {
    const f = fixture();
    const realBackend = f.backend.getMockImplementation()!;
    f.backend.mockImplementationOnce(async (...args) => { await realBackend(...args); throw new Error('ACK lost'); });
    const id = await f.receive();
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.raw.objects.has(id)).toBe(true);
    f.advance(24 * 3600_000);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
    expect(f.local.size).toBe(1);
    expect(f.calls[0]?.headers.get('x-dreampost-attempt-id')).not.toBe(f.calls[1]?.headers.get('x-dreampost-attempt-id'));
    expect(f.calls[0]?.headers.get('x-dreampost-timestamp')).not.toBe(f.calls[1]?.headers.get('x-dreampost-timestamp'));
  });

  it.each([
    ['non-JSON', () => new Response('<html>OK</html>')],
    ['wrong digest', () => Response.json({ version: 1, deliveryId: 'wrong', sha256: '0'.repeat(64), status: 'stored' })],
    ['missing fields', () => Response.json({ status: 'stored' })],
    ['oversized ACK', () => new Response('a'.repeat(5000))],
    ['unauthorized', () => new Response(null, { status: 403 })],
    ['not committed', () => new Response(null, { status: 202 })],
  ])('retries %s without deleting raw mail', async (_label, response) => {
    const f = fixture();
    f.backend.mockImplementationOnce(async () => response());
    const id = await f.receive();
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
    expect(f.raw.deletes).toBe(0);
  });

  it('uses manual redirects supported by workerd and never forwards signed credentials to a redirect target', async () => {
    const f = fixture();
    f.backend.mockImplementationOnce(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test/' } });
    });
    const id = await f.receive();
    await f.gateway.deliver(id);
    expect(f.backend).toHaveBeenCalledOnce();
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
    expect(f.raw.deletes).toBe(0);
  });

  it('requires the digest to match even when the delivery ID is correct', async () => {
    const f = fixture();
    const id = await f.receive();
    f.backend.mockImplementationOnce(async () => Response.json({ version: 1, deliveryId: id, sha256: '0'.repeat(64), status: 'stored' }));
    await f.gateway.deliver(id);
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
  });

  it('retries a network failure while reading an otherwise successful response', async () => {
    const f = fixture();
    f.backend.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('Connection reset during ACK')); },
    })));
    const id = await f.receive();
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
    f.advance(30_000);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
  });

  it.each([401, 403])('recovers HTTP %s automatically after credentials or clock configuration is corrected', async status => {
    const f = fixture();
    const id = await f.receive();
    f.backend.mockImplementationOnce(async () => Response.json({ error: 'invalid_delivery_authorization' }, { status }));
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    f.advance(30_000);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
  });

  it.each([
    [400, 'delivery_body_mismatch'], [409, 'delivery_id_conflict'], [413, 'message_too_large'],
    [415, 'unsupported_content_type'], [422, 'recipient_not_configured'],
  ])('blocks only the recognized deterministic HTTP %s backend error %s', async (status, error) => {
    const f = fixture();
    f.backend.mockImplementationOnce(async () => Response.json({ error }, { status: status as number }));
    const id = await f.receive();
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
    expect(f.ledger.records.get(id)?.state).toBe('blocked');
    expect(f.raw.objects.has(id)).toBe(true);
  });

  it.each([
    [400, { error: 'recipient_not_configured' }], [409, { error: 'proxy_denied' }],
    [404, { error: 'recipient_not_configured' }], [422, { message: 'recipient_not_configured' }],
    [200, { error: 'delivery_id_conflict' }],
  ])('retries unrecognized status/payload combinations without deleting raw data', async (status, payload) => {
    const f = fixture();
    f.backend.mockImplementationOnce(async () => Response.json(payload, { status }));
    const id = await f.receive();
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
  });

  it.each([429, 500, 503])('retries HTTP %s and preserves the raw message', async status => {
    const f = fixture();
    f.backend.mockImplementationOnce(async () => new Response(null, { status }));
    const id = await f.receive();
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.ledger.records.get(id)?.state).toBe('stored');
    expect(f.raw.objects.has(id)).toBe(true);
    f.advance(30_000);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
  });

  it('retries cleanup after delivery without pushing the message again', async () => {
    const f = fixture();
    f.raw.failDelete = 1;
    const id = await f.receive();
    expect((await f.gateway.deliver(id)).action).toBe('retry');
    expect(f.ledger.records.get(id)?.state).toBe('delivered_pending_delete');
    f.advance(30_000);
    await f.gateway.repair();
    expect(f.ledger.records.get(id)?.state).toBe('done');
    expect(f.raw.objects.has(id)).toBe(false);
    expect(f.backend).toHaveBeenCalledOnce();
  });

  it('does not let a stale failed attempt overwrite a newer completed delivery', async () => {
    const f = fixture();
    let resolveFirst!: (response: Response) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    f.backend.mockImplementationOnce(async () => {
      started();
      return new Promise<Response>(resolve => { resolveFirst = resolve; });
    });
    const id = await f.receive();
    const first = f.gateway.deliver(id);
    await firstStarted;
    f.advance(LEASE_MS + 1);
    expect(await f.gateway.deliver(id)).toEqual({ action: 'ack' });
    resolveFirst(new Response(null, { status: 503 }));
    await first;
    expect(f.ledger.records.get(id)?.state).toBe('done');
    expect(f.ledger.records.get(id)?.lastError).toBeNull();
    expect(f.raw.objects.has(id)).toBe(false);
  });

  it('blocks a changed stored raw body before making any backend request', async () => {
    const f = fixture();
    const id = await f.receive();
    f.raw.objects.get(id)!.bytes[0] ^= 1;
    await f.gateway.deliver(id);
    expect(f.ledger.records.get(id)?.state).toBe('blocked');
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.raw.objects.has(id)).toBe(true);
  });

  it('purges only completed tombstones after the configured retention period', async () => {
    const f = fixture();
    f.config.doneRetentionDays = 2;
    const completed = await f.receive();
    await f.gateway.deliver(completed);
    const pending = await f.receive();
    const blocked = await f.receive();
    f.backend.mockImplementationOnce(async () => Response.json({ error: 'recipient_not_configured' }, { status: 422 }));
    await f.gateway.deliver(blocked);
    f.advance(2 * 86400_000);
    await f.gateway.repair();
    expect(f.ledger.records.has(completed)).toBe(true);
    f.advance(1);
    await f.gateway.repair();
    expect(f.ledger.records.has(completed)).toBe(false);
    expect(f.ledger.records.get(pending)?.state).toBe('stored');
    expect(f.ledger.records.get(blocked)?.state).toBe('blocked');
    expect(f.raw.objects.has(pending)).toBe(true);
    expect(f.raw.objects.has(blocked)).toBe(true);
  });

  it('keeps later repair work visible when recently queued records fill an earlier page', async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) await f.receive();
    f.queue.fail = true;
    const id = await f.receive();
    f.queue.fail = false;
    await f.gateway.repair();
    expect(f.messages.at(-1)).toEqual({ deliveryId: id });
  });
});

describe('gateway configuration', () => {
  const vars = { RECIPIENT_ROUTES_JSON: JSON.stringify({ 'inbox@example.test': mailboxId }),
    BACKEND_INGEST_URL: 'https://api.example.test/internal/v1/deliveries', INGEST_KEY_ID: 'development', INGEST_SECRET: secret };
  it('allows HTTPS and explicitly opted-in loopback development only', () => {
    expect(readConfig(vars).backendUrl).toBe(vars.BACKEND_INGEST_URL);
    expect(() => readConfig({ ...vars, BACKEND_INGEST_URL: 'http://api.example.test/internal/v1/deliveries' })).toThrow();
    expect(() => readConfig({ ...vars, BACKEND_INGEST_URL: 'http://127.0.0.1:3001/internal/v1/deliveries' })).toThrow();
    expect(readConfig({ ...vars, BACKEND_INGEST_URL: 'http://127.0.0.1:3001/internal/v1/deliveries', ALLOW_INSECURE_LOCAL_BACKEND: 'true' }).backendUrl).toContain('127.0.0.1');
  });
  it('normalizes case-folded routes and rejects conflicting duplicate destinations', () => {
    const same = readConfig({ ...vars, RECIPIENT_ROUTES_JSON: JSON.stringify({
      'Inbox@Example.test': mailboxId, 'inbox@example.test': mailboxId,
    }) });
    expect(Object.keys(same.routes)).toEqual(['inbox@example.test']);
    expect(() => readConfig({ ...vars, RECIPIENT_ROUTES_JSON: JSON.stringify({
      'Inbox@Example.test': mailboxId, 'inbox@example.test': '22222222-2222-4222-8222-222222222222',
    }) })).toThrow('Conflicting recipient configuration');
  });
  it('defaults completed tombstone retention to seven days and rejects unsafe values', () => {
    expect(readConfig(vars).doneRetentionDays).toBe(7);
    expect(readConfig({ ...vars, DONE_RETENTION_DAYS: '14' }).doneRetentionDays).toBe(14);
    for (const value of ['0', '-1', 'Infinity', '1.5', '3651']) {
      expect(() => readConfig({ ...vars, DONE_RETENTION_DAYS: value })).toThrow();
    }
  });
  it('rejects catch-all and invalid destination identifiers', () => {
    expect(() => readConfig({ ...vars, RECIPIENT_ROUTES_JSON: JSON.stringify({ '*@example.test': mailboxId }) })).toThrow();
    expect(() => readConfig({ ...vars, RECIPIENT_ROUTES_JSON: JSON.stringify({ 'inbox@example.test': 'unconfigured' }) })).toThrow();
  });
});


describe('upload time budget', () => {
  it('scales with raw size and always remains below the ownership lease', () => {
    expect(pushTimeoutMs(256 * 1024)).toBe(31_000);
    expect(pushTimeoutMs(25 * 1024 * 1024)).toBe(130_000);
    expect(pushTimeoutMs(100 * 1024 * 1024)).toBe(150_000);
    expect(LEASE_MS).toBeGreaterThan(pushTimeoutMs(100 * 1024 * 1024));
  });
});
