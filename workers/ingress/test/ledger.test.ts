import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryRecord } from '../src/model.js';
import { sqliteLedger } from './helpers/sqlite-ledger.js';

const databases: ReturnType<typeof sqliteLedger>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function ledger() {
  const context = sqliteLedger();
  databases.push(context);
  return context.ledger;
}

function record(id = '00000000-0000-4000-8000-000000000001'): DeliveryRecord {
  return { deliveryId: id, metadata: { version: 1, deliveryId: id,
    mailboxId: '11111111-1111-4111-8111-111111111111', envelopeFrom: 'sender@example.test',
    envelopeTo: 'inbox@example.test', receivedAt: '2026-09-25T12:00:00Z', rawSize: 1 },
    sha256: 'a'.repeat(64), state: 'stored', createdAt: 100, updatedAt: 100, nextAttemptAt: 100,
    lastEnqueuedAt: null, leaseToken: null, leaseUntil: null, attempts: 0, lastError: null };
}

describe('D1 ledger SQL', () => {
  it('atomically grants one lease, permits takeover after expiry, and rejects stale transitions', async () => {
    const db = ledger();
    const row = record();
    await db.insert(row);
    const claims = await Promise.all(['first', 'second'].map(token => db.claim(row.deliveryId, 'stored', token, 100, 200)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const oldToken = claims.find(Boolean)!.leaseToken!;
    expect(await db.claim(row.deliveryId, 'stored', 'replacement', 299, 200)).toBeNull();
    expect((await db.claim(row.deliveryId, 'stored', 'replacement', 300, 200))?.attempts).toBe(2);
    expect(await db.updateOwned(row.deliveryId, oldToken, 'stored', { state: 'blocked' })).toBe(false);
    expect(await db.updateOwned(row.deliveryId, 'replacement', 'stored', { state: 'delivered_pending_delete' })).toBe(true);
    expect(await db.updateOwned(row.deliveryId, 'replacement', 'stored', { state: 'blocked' })).toBe(false);
    expect((await db.get(row.deliveryId))?.state).toBe('delivered_pending_delete');
  });

  it('does not allow claims before a retry is due', async () => {
    const db = ledger();
    const row = { ...record(), nextAttemptAt: 1000 };
    await db.insert(row);
    expect(await db.claim(row.deliveryId, 'stored', 'early', 999, 200)).toBeNull();
    expect(await db.claim(row.deliveryId, 'stored', 'due', 1000, 200)).not.toBeNull();
  });

  it('filters recently enqueued rows before limiting the repair page', async () => {
    const db = ledger();
    const recent = record();
    const missing = record('00000000-0000-4000-8000-000000000002');
    await db.insert(recent);
    await db.noteEnqueued(recent.deliveryId, 1000);
    await db.insert(missing);
    const rows = await db.due(1000, 1, 700);
    expect(rows.map(row => row.deliveryId)).toEqual([missing.deliveryId]);
  });

  it('bounds retention deletion to old done rows and never deletes pending, blocked, or unfinished cleanup', async () => {
    const db = ledger();
    const states = ['receiving', 'stored', 'blocked', 'delivered_pending_delete', 'done', 'done', 'done'] as const;
    const ids: string[] = [];
    for (const [i, state] of states.entries()) {
      const row = { ...record(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`), state,
        updatedAt: i === 6 ? 1000 : 100 };
      ids.push(row.deliveryId);
      await db.insert(row);
    }
    expect(await db.purgeDone(500, 1)).toBe(1);
    expect((await Promise.all(ids.map(id => db.get(id)))).filter(Boolean)).toHaveLength(6);
    expect(await db.purgeDone(500, 100)).toBe(1);
    for (const id of [...ids.slice(0, 4), ids[6]!]) expect(await db.get(id)).not.toBeNull();
    expect(await db.purgeDone(500, 100)).toBe(0);
  });

  it('retains the completed tombstone when a delayed queue-send receipt arrives', async () => {
    const db = ledger();
    const row = { ...record(), state: 'done' as const };
    await db.insert(row);
    await db.noteEnqueued(row.deliveryId, 2000);
    expect((await db.get(row.deliveryId))?.lastEnqueuedAt).toBeNull();
    expect(await db.due(3000, 100, 2500)).toEqual([]);
  });
});
