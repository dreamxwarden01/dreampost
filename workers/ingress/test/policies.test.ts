import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPolicyHeaders, hashRoutePolicy, matchesPolicyAck, MAX_POLICY_BYTES, POLICY_PATH, sha256Hex,
  verifyDeliveryBody, verifyDeliveryHeaders, type DeliveryMetadata, type RoutePolicy,
} from '@dreampost/protocol';
import { readConfig, type GatewayConfig } from '../src/config.js';
import { Gateway, LEASE_MS } from '../src/core.js';
import { handlePolicyRequest } from '../src/policies.js';
import type { DeliveryRecord, InboundMessage, RawStore, StoredRaw } from '../src/model.js';
import { sqliteLedger } from './helpers/sqlite-ledger.js';

const contexts: ReturnType<typeof sqliteLedger>[] = [];
afterEach(() => { for (const context of contexts.splice(0)) context.close(); });
const mailboxA = '11111111-1111-4111-8111-111111111111';
const mailboxB = '22222222-2222-4222-8222-222222222222';
const allocationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const allocationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = { id: 'policy', secret: 'development-policy-secret-with-32-bytes' };
const ingestKey = { id: 'ingest', secret: 'development-ingest-secret-with-32-bytes' };
const now = Date.parse('2026-09-26T12:00:00Z');
const body = new TextEncoder().encode('From: sender@example.test\r\nSubject: Policy test\r\n\r\nPreserve this message.\r\n');
const config = (): GatewayConfig => ({ routes: { 'inbox@example.test': mailboxA },
  backendUrl: 'https://api.example.test/internal/v1/deliveries', key: ingestKey,
  doneRetentionDays: 7, routingMode: 'dynamic', policyKeys: { [key.id]: key.secret }, allowedPolicyDomains: ['example.test'] });
function policy(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
  return { version: 1, operationId: randomUUID(), address: 'inbox@example.test', allocationId: allocationA,
    mailboxId: mailboxA, previousRevision: 0, revision: 1, receiveEnabled: true, ...overrides };
}
function context() {
  const result = sqliteLedger();
  contexts.push(result);
  return result;
}
async function apply(db: ReturnType<typeof context>['ledger'], item: RoutePolicy) {
  return db.applyPolicy(item, await hashRoutePolicy(item), now);
}
async function request(item: RoutePolicy, signer = key, signedAt = now): Promise<Request> {
  return new Request(`https://gateway.example.test${POLICY_PATH}`, { method: 'POST', body: JSON.stringify(item),
    headers: await createPolicyHeaders(item, signer, { nowMs: signedAt }) });
}
async function admission(item: RoutePolicy): Promise<DeliveryRecord> {
  const metadata: DeliveryMetadata = { version: 2, deliveryId: randomUUID(), mailboxId: item.mailboxId,
    allocationId: item.allocationId, routeRevision: item.revision, policyDigest: await hashRoutePolicy(item),
    envelopeFrom: 'sender@example.test', envelopeTo: item.address, receivedAt: new Date(now).toISOString(), rawSize: body.length };
  return { deliveryId: metadata.deliveryId, metadata, sha256: null, state: 'receiving', createdAt: now,
    updatedAt: now, nextAttemptAt: now + LEASE_MS, lastEnqueuedAt: null, leaseToken: randomUUID(),
    leaseUntil: now + LEASE_MS, attempts: 0, lastError: null };
}

function runtime(db: ReturnType<typeof context>['ledger']) {
  const settings = config();
  const objects = new Map<string, StoredRaw>();
  const raw: RawStore = {
    async put(id, bytes, metadata, sha256) { objects.set(id, { bytes: new Uint8Array(bytes), metadata: structuredClone(metadata), sha256 }); },
    async get(id) { return structuredClone(objects.get(id) ?? null); },
    async delete(id) { objects.delete(id); },
  };
  const queued: string[] = [];
  const pushed: DeliveryMetadata[] = [];
  const backend = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const verified = await verifyDeliveryHeaders(new Headers(init?.headers), { [ingestKey.id]: ingestKey.secret }, { nowMs: now });
    await verifyDeliveryBody(new Uint8Array(init?.body as Uint8Array), verified);
    pushed.push(verified.metadata);
    return Response.json({ version: 1, deliveryId: verified.metadata.deliveryId, sha256: verified.sha256, status: 'stored' });
  });
  const gateway = new Gateway({ ledger: db, raw, config: settings, queue: { async send(message) { queued.push(message.deliveryId); } },
    fetch: backend as typeof fetch, now: () => now });
  function message(to = 'INBOX@EXAMPLE.TEST'): InboundMessage {
    return { from: 'sender@example.test', to, rawSize: body.length,
      raw: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }), setReject: vi.fn() };
  }
  return { settings, objects, queued, pushed, backend, gateway, message };
}

describe('authenticated policy control', () => {
  it('is disabled by default and permits only the intended POST endpoint', async () => {
    const db = context().ledger;
    const item = policy();
    expect((await handlePolicyRequest(await request(item), { ...config(), routingMode: 'static' }, db, () => now)).status).toBe(404);
    expect((await handlePolicyRequest(new Request(`https://gateway.example.test${POLICY_PATH}`), config(), db, () => now)).status).toBe(405);
    expect((await handlePolicyRequest(new Request('https://gateway.example.test/'), config(), db, () => now)).status).toBe(404);
    expect(await db.getPolicy(item.address)).toBeNull();
  });
  it('authenticates separate policy credentials and rejects expired or absent authorization', async () => {
    const db = context().ledger;
    const item = policy();
    const unsigned = new Request(`https://gateway.example.test${POLICY_PATH}`, { method: 'POST', body: JSON.stringify(item) });
    expect((await handlePolicyRequest(unsigned, config(), db, () => now)).status).toBe(401);
    expect((await handlePolicyRequest(await request(item, ingestKey), config(), db, () => now)).status).toBe(401);
    expect((await handlePolicyRequest(await request(item, key, now - 600_000), config(), db, () => now)).status).toBe(401);
    expect(await db.getPolicy(item.address)).toBeNull();
  });
  it('bounds streamed policy bodies and rejects signed policies outside the allowed domain', async () => {
    const db = context().ledger;
    const oversized = new Request(`https://gateway.example.test${POLICY_PATH}`, { method: 'POST', body: 'x'.repeat(MAX_POLICY_BYTES + 1) });
    expect((await handlePolicyRequest(oversized, config(), db, () => now)).status).toBe(413);
    const foreign = policy({ address: 'inbox@outside.test' });
    expect((await handlePolicyRequest(await request(foreign), config(), db, () => now)).status).toBe(403);
    expect(await db.getPolicy(foreign.address)).toBeNull();
  });
  it('returns digest-matching idempotent ACKs, including a retained historical ACK without rolling back', async () => {
    const db = context().ledger;
    const first = policy();
    const response = await handlePolicyRequest(await request(first), config(), db, () => now);
    const ack = await response.json();
    expect(response.status).toBe(200);
    expect(matchesPolicyAck(ack, { ...first, sha256: await hashRoutePolicy(first) })).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const paused = policy({ previousRevision: 1, revision: 2, receiveEnabled: false });
    expect(await apply(db, paused)).toBe('applied');
    const retry = await handlePolicyRequest(await request(first), config(), db, () => now);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(ack);
    expect((await db.getPolicy(first.address))?.policy).toEqual(paused);
  });
  it('returns conflict for unknown stale revisions or reused operation IDs with changed payloads', async () => {
    const db = context().ledger;
    const first = policy();
    await apply(db, first);
    for (const invalid of [policy(), { ...first, receiveEnabled: false }]) {
      expect((await handlePolicyRequest(await request(invalid), config(), db, () => now)).status).toBe(409);
    }
    const reused = { ...first, address: 'another@example.test' };
    expect(await apply(db, reused)).toBe('conflict');
    expect(await db.getPolicy(reused.address)).toBeNull();
    expect((await db.getPolicy(first.address))?.policy).toEqual(first);
  });
});

describe('atomic D1 policy admission', () => {
  it('applies a higher full snapshot across skipped revisions and never re-enables from an older replay', async () => {
    const db = context().ledger;
    const enabled = policy({ previousRevision: 2, revision: 3 });
    // A new or restored edge can initialize directly from the current full snapshot.
    expect(await apply(db, enabled)).toBe('applied');
    const paused = policy({ previousRevision: 5, revision: 6, receiveEnabled: false });
    expect(await apply(db, paused)).toBe('applied');
    expect((await db.getPolicy(paused.address))?.policy).toEqual(paused);
    // A known replay is acknowledged as historical; it cannot replace revision 6.
    expect(await apply(db, enabled)).toBe('applied');
    expect(await apply(db, policy({ previousRevision: 3, revision: 4 }))).toBe('conflict');
    expect(await apply(db, policy({ previousRevision: 5, revision: 6 }))).toBe('conflict');
    expect((await db.getPolicy(paused.address))?.policy).toEqual(paused);
    expect(await db.admitDynamic(await admission(enabled), enabled.address)).toBe(false);
  });

  it('serializes competing revisions and keeps only the winner in applied history', async () => {
    const { ledger: db, sql } = context();
    await apply(db, policy());
    const candidates = [policy({ previousRevision: 1, revision: 2, receiveEnabled: false }),
      policy({ previousRevision: 1, revision: 2, allocationId: allocationB, mailboxId: mailboxB })];
    const outcomes = await Promise.all(candidates.map(item => apply(db, item)));
    expect(outcomes.sort()).toEqual(['applied', 'conflict']);
    expect(sql.prepare('SELECT count(*) AS count FROM recipient_policy_operations WHERE revision = 2').get()?.count).toBe(1);
  });
  it('rolls back the current policy when its historical evidence fails to commit', async () => {
    const { ledger: db, sql } = context();
    sql.exec("CREATE TRIGGER fail_history BEFORE INSERT ON recipient_policy_operations BEGIN SELECT RAISE(ABORT, 'failure'); END;");
    const item = policy();
    await expect(apply(db, item)).rejects.toThrow();
    expect(await db.getPolicy(item.address)).toBeNull();
  });
  it('admits before pause or rejects after pause with no stale receiving insert', async () => {
    const db = context().ledger;
    const initial = policy();
    await apply(db, initial);
    const accepted = await admission(initial);
    expect(await db.admitDynamic(accepted, initial.address)).toBe(true);
    await apply(db, policy({ previousRevision: 1, revision: 2, receiveEnabled: false }));
    const stale = await admission(initial);
    expect(await db.admitDynamic(stale, initial.address)).toBe(false);
    expect(await db.get(stale.deliveryId)).toBeNull();
    expect((await db.get(accepted.deliveryId))?.metadata).toEqual(accepted.metadata);
  });
  it('preserves original ownership through pause and reassignment', async () => {
    const db = context().ledger;
    const initial = policy();
    await apply(db, initial);
    const oldMail = await admission(initial);
    await db.admitDynamic(oldMail, initial.address);
    await apply(db, policy({ previousRevision: 1, revision: 2, receiveEnabled: false }));
    const replacement = policy({ previousRevision: 2, revision: 3, allocationId: allocationB, mailboxId: mailboxB });
    await apply(db, replacement);
    expect(await db.admitDynamic(await admission(initial), initial.address)).toBe(false);
    const newMail = await admission(replacement);
    expect(await db.admitDynamic(newMail, replacement.address)).toBe(true);
    expect((await db.get(oldMail.deliveryId))?.metadata.mailboxId).toBe(mailboxA);
    expect((await db.get(newMail.deliveryId))?.metadata.mailboxId).toBe(mailboxB);
  });
  it('requires the current digest, allocation, target mailbox, and original-envelope binding', async () => {
    const db = context().ledger;
    const initial = policy();
    await apply(db, initial);
    for (const changed of [{ policyDigest: '0'.repeat(64) }, { allocationId: allocationB }, { mailboxId: mailboxB }]) {
      const candidate = await admission(initial);
      candidate.metadata = { ...candidate.metadata, ...changed };
      expect(await db.admitDynamic(candidate, initial.address)).toBe(false);
    }
    await expect(db.admitDynamic(await admission(initial), 'another@example.test')).rejects.toThrow();
  });
});

describe('dynamic receive and retained delivery', () => {
  it('never falls back to static configuration when a dynamic policy is absent or disabled', async () => {
    const db = context().ledger;
    const f = runtime(db);
    const absent = f.message();
    await f.gateway.receive(absent);
    expect(absent.setReject).toHaveBeenCalledOnce();
    await apply(db, policy({ receiveEnabled: false }));
    const disabled = f.message();
    await f.gateway.receive(disabled);
    expect(disabled.setReject).toHaveBeenCalledOnce();
    expect(f.objects.size).toBe(0);
  });
  it('reloads a changed enabled policy and signs the admitted revision with original envelope spelling', async () => {
    const db = context().ledger;
    await apply(db, policy());
    const changed = policy({ previousRevision: 1, revision: 2 });
    const realAdmit = db.admitDynamic.bind(db);
    vi.spyOn(db, 'admitDynamic').mockImplementationOnce(async (...args) => { await apply(db, changed); return realAdmit(...args); });
    const f = runtime(db);
    await f.gateway.receive(f.message());
    await f.gateway.deliver(f.queued[0]!);
    expect(f.pushed[0]).toMatchObject({ version: 2, routeRevision: 2, policyDigest: await hashRoutePolicy(changed), envelopeTo: 'INBOX@EXAMPLE.TEST' });
  });
  it('does not permanently reject solely because admission keeps racing', async () => {
    const db = context().ledger;
    await apply(db, policy());
    vi.spyOn(db, 'admitDynamic').mockResolvedValue(false);
    const f = runtime(db);
    const incoming = f.message();
    await expect(f.gateway.receive(incoming)).rejects.toThrow('policy changed');
    expect(incoming.setReject).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(0);
  });
  it('delivers admitted old mail to its original mailbox even after the address is reassigned', async () => {
    const db = context().ledger;
    const initial = policy();
    await apply(db, initial);
    const f = runtime(db);
    await f.gateway.receive(f.message());
    const oldId = f.queued[0]!;
    await apply(db, policy({ previousRevision: 1, revision: 2, receiveEnabled: false }));
    await apply(db, policy({ previousRevision: 2, revision: 3, allocationId: allocationB, mailboxId: mailboxB }));
    await f.gateway.receive(f.message());
    await f.gateway.deliver(oldId);
    await f.gateway.deliver(f.queued[1]!);
    expect(f.pushed.map(item => item.mailboxId)).toEqual([mailboxA, mailboxB]);
    expect(f.objects.size).toBe(0);
  });
  it('continues to deliver previously queued v1 mail after opting into dynamic routing', async () => {
    const db = context().ledger;
    const f = runtime(db);
    f.settings.routingMode = 'static';
    await f.gateway.receive(f.message());
    const id = f.queued[0]!;
    f.settings.routingMode = 'dynamic';
    await f.gateway.deliver(id);
    expect(f.pushed[0]?.version).toBe(1);
    expect((await db.get(id))?.state).toBe('done');
  });
  it('detects modified v2 policy evidence in the stored raw recovery metadata', async () => {
    const db = context().ledger;
    await apply(db, policy());
    const f = runtime(db);
    await f.gateway.receive(f.message());
    const id = f.queued[0]!;
    const raw = f.objects.get(id)!;
    raw.metadata = { ...(raw.metadata as DeliveryMetadata), routeRevision: 100 };
    await f.gateway.deliver(id);
    expect((await db.get(id))?.state).toBe('blocked');
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.objects.has(id)).toBe(true);
  });
});

describe('dynamic configuration', () => {
  const variables = { RECIPIENT_ROUTES_JSON: '{}', BACKEND_INGEST_URL: config().backendUrl,
    INGEST_KEY_ID: ingestKey.id, INGEST_SECRET: ingestKey.secret };
  it('keeps static as the default and requires explicit domain scope and separate policy keys for dynamic mode', () => {
    expect(readConfig(variables).routingMode).toBe('static');
    expect(() => readConfig({ ...variables, ROUTING_MODE: 'dynamic' })).toThrow();
    const dynamic = { ...variables, ROUTING_MODE: 'dynamic', POLICY_KEYS_JSON: JSON.stringify({ [key.id]: key.secret }),
      POLICY_ALLOWED_DOMAINS_JSON: '["example.test"]' };
    expect(readConfig(dynamic).routingMode).toBe('dynamic');
    expect(() => readConfig({ ...dynamic, POLICY_KEYS_JSON: JSON.stringify({ bad: ingestKey.secret }) })).toThrow();
    expect(() => readConfig({ ...dynamic, POLICY_ALLOWED_DOMAINS_JSON: '["*"]' })).toThrow();
    expect(() => readConfig({ ...dynamic, POLICY_ALLOWED_DOMAINS_JSON: '[]' })).toThrow();
  });
});
