import { describe, expect, it } from 'vitest';
import { createDeliveryHeaders, verifyDeliveryHeaders, validateMetadata, type DeliveryMetadataV2,
  createPolicyHeaders, verifyPolicyRequest, hashRoutePolicy, matchesPolicyAck, validateRoutePolicy, type RoutePolicy } from './index.js';
const key = { id: 'control-1', secret: 'test-control-key-with-at-least-32-bytes' };
const nowMs = Date.parse('2026-09-26T12:00:00Z');
const policy: RoutePolicy = { version: 1, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  address: 'reader@example.test', allocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  mailboxId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', previousRevision: 0, revision: 1, receiveEnabled: true };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('recipient policy protocol', () => {
  it('authenticates canonical policy content independently of JSON field order', async () => {
    const headers = await createPolicyHeaders(policy, key, { nowMs });
    const reversed = Object.fromEntries(Object.entries(policy).reverse());
    expect(await verifyPolicyRequest(headers, bytes(reversed), { [key.id]: key.secret }, { nowMs }))
      .toEqual({ policy, digest: await hashRoutePolicy(policy) });
  });
  it.each(['receiveEnabled', 'mailboxId', 'allocationId', 'revision'])('rejects signed policy tampering in %s', async field => {
    const headers = await createPolicyHeaders(policy, key, { nowMs });
    const value = { ...policy, [field]: field === 'receiveEnabled' ? false : field === 'revision' ? 2 : policy.operationId };
    await expect(verifyPolicyRequest(headers, bytes(value), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
  });
  it('rejects expired signatures, wrong keys, duplicated headers, and oversized control bodies', async () => {
    const headers = await createPolicyHeaders(policy, key, { nowMs });
    await expect(verifyPolicyRequest(headers, bytes(policy), { [key.id]: key.secret }, { nowMs: nowMs + 301_000 })).rejects.toThrow();
    await expect(verifyPolicyRequest(headers, bytes(policy), { [key.id]: 'a'.repeat(40) }, { nowMs })).rejects.toThrow();
    await expect(verifyPolicyRequest({ ...headers, 'Content-Type': 'application/json' }, bytes(policy), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
    await expect(verifyPolicyRequest(headers, new Uint8Array(16_385), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
  });
  it.each(['Reader@example.test', 'bad..name@example.test', 'reader@-example.test', 'reader@example..test', '*@example.test'])('rejects noncanonical or unsupported hosted address %s', address => {
    expect(() => validateRoutePolicy({ ...policy, address })).toThrow();
  });
  it('requires consecutive safe revisions and exact policy fields', () => {
    expect(() => validateRoutePolicy({ ...policy, revision: 3 })).toThrow();
    expect(() => validateRoutePolicy({ ...policy, previousRevision: Number.MAX_SAFE_INTEGER, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => validateRoutePolicy({ ...policy, extra: true })).toThrow();
  });
  it('acknowledgment binds operation, target, revision, and content digest', async () => {
    const sha256 = await hashRoutePolicy(policy);
    const ack = { version: 1, status: 'applied', operationId: policy.operationId, address: policy.address, revision: policy.revision, sha256 };
    expect(matchesPolicyAck(ack, { ...policy, sha256 })).toBe(true);
    expect(matchesPolicyAck({ ...ack, revision: 2 }, { ...policy, sha256 })).toBe(false);
    expect(matchesPolicyAck({ ...ack, sha256: '0'.repeat(64) }, { ...policy, sha256 })).toBe(false);
  });
});

describe('version two admission evidence', () => {
  it('signs immutable allocation and route evidence without changing v1 transport acknowledgment', async () => {
    const raw = bytes('test mail');
    const metadata: DeliveryMetadataV2 = { version: 2, deliveryId: policy.operationId, mailboxId: policy.mailboxId,
      envelopeFrom: 'sender@example.test', envelopeTo: 'Reader@example.test', receivedAt: new Date(nowMs).toISOString(), rawSize: raw.length,
      allocationId: policy.allocationId, routeRevision: 1, policyDigest: await hashRoutePolicy(policy) };
    const headers = await createDeliveryHeaders(metadata, raw, key, { nowMs });
    expect((await verifyDeliveryHeaders(headers, { [key.id]: key.secret }, { nowMs })).metadata).toEqual(metadata);
    expect(() => validateMetadata({ ...metadata, policyDigest: 'unknown' })).toThrow();
    expect(() => validateMetadata({ ...metadata, version: 1 })).toThrow();
    await expect(verifyPolicyRequest(headers, bytes(policy), { [key.id]: key.secret }, { nowMs })).rejects.toThrow();
  });
});
