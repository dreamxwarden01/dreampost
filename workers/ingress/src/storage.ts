import { MAX_INBOUND_BYTES, validateMetadata } from '@dreampost/protocol';
import type { DeliveryMetadata } from '@dreampost/protocol';
import type { DeliveryPatch, DeliveryRecord, DeliveryState, Ledger, RawStore, StoredRaw } from './model.js';

interface Row {
  delivery_id: string;
  metadata_json: string;
  sha256: string | null;
  state: DeliveryState;
  created_at: number;
  updated_at: number;
  next_attempt_at: number;
  last_enqueued_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  attempts: number;
  last_error: string | null;
}

function decode(row: Row): DeliveryRecord {
  return { deliveryId: row.delivery_id, metadata: validateMetadata(JSON.parse(row.metadata_json)),
    sha256: row.sha256, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at, lastEnqueuedAt: row.last_enqueued_at,
    leaseToken: row.lease_token, leaseUntil: row.lease_until, attempts: row.attempts, lastError: row.last_error };
}

const columns: Record<keyof DeliveryPatch, string> = {
  sha256: 'sha256', state: 'state', updatedAt: 'updated_at', nextAttemptAt: 'next_attempt_at',
  leaseToken: 'lease_token', leaseUntil: 'lease_until', lastError: 'last_error',
};

export class D1Ledger implements Ledger {
  constructor(private readonly db: D1Database) {}

  async insert(record: DeliveryRecord): Promise<void> {
    await this.db.prepare(`INSERT INTO deliveries
      (delivery_id, metadata_json, sha256, state, created_at, updated_at, next_attempt_at,
       last_enqueued_at, lease_token, lease_until, attempts, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.deliveryId, JSON.stringify(record.metadata), record.sha256, record.state, record.createdAt,
      record.updatedAt, record.nextAttemptAt, record.lastEnqueuedAt, record.leaseToken, record.leaseUntil,
      record.attempts, record.lastError,
    ).run();
  }

  async get(id: string): Promise<DeliveryRecord | null> {
    const row = await this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').bind(id).first<Row>();
    return row ? decode(row) : null;
  }

  async claim(id: string, state: DeliveryState, token: string, now: number, leaseMs: number): Promise<DeliveryRecord | null> {
    // Claim and increment in one statement; never read then write a lease.
    const row = await this.db.prepare(`UPDATE deliveries SET lease_token = ?, lease_until = ?,
      updated_at = ?, attempts = attempts + 1
      WHERE delivery_id = ? AND state = ? AND next_attempt_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`).bind(
      token, now + leaseMs, now, id, state, now, now,
    ).first<Row>();
    return row ? decode(row) : null;
  }

  async updateOwned(id: string, token: string, state: DeliveryState, patch: DeliveryPatch): Promise<boolean> {
    const entries = Object.entries(patch) as [keyof DeliveryPatch, string | number | null][];
    if (!entries.length) return false;
    const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
    const result = await this.db.prepare(`UPDATE deliveries SET ${assignments}
      WHERE delivery_id = ? AND lease_token = ? AND state = ?`).bind(
      ...entries.map(([, value]) => value), id, token, state,
    ).run();
    return result.meta.changes === 1;
  }

  async noteEnqueued(id: string, now: number): Promise<void> {
    await this.db.prepare(`UPDATE deliveries SET last_enqueued_at = ?
      WHERE delivery_id = ? AND state = 'stored'`).bind(now, id).run();
  }

  async purgeDone(before: number, limit: number): Promise<number> {
    const result = await this.db.prepare(`DELETE FROM deliveries WHERE delivery_id IN (
        SELECT delivery_id FROM deliveries WHERE state = 'done' AND updated_at < ?
          AND lease_token IS NULL ORDER BY updated_at, delivery_id LIMIT ?
      ) AND state = 'done' AND updated_at < ? AND lease_token IS NULL`).bind(before, limit, before).run();
    return result.meta.changes;
  }

  async due(now: number, limit: number, staleQueueBefore: number): Promise<DeliveryRecord[]> {
    const result = await this.db.prepare(`SELECT * FROM deliveries
      WHERE state IN ('receiving', 'stored', 'delivered_pending_delete') AND next_attempt_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?)
        AND (state <> 'stored' OR last_enqueued_at IS NULL OR last_enqueued_at <= ?)
      ORDER BY next_attempt_at, created_at LIMIT ?`).bind(now, now, staleQueueBefore, limit).all<Row>();
    return result.results.map(decode);
  }
}

export class R2RawStore implements RawStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(id: string, bytes: Uint8Array, metadata: DeliveryMetadata, sha256: string): Promise<void> {
    await this.bucket.put(this.key(id), bytes, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: { delivery_metadata: JSON.stringify(metadata), sha256 },
    });
  }

  async get(id: string): Promise<StoredRaw | null> {
    const object = await this.bucket.get(this.key(id));
    if (!object) return null;
    if (object.size > MAX_INBOUND_BYTES) {
      await object.body.cancel();
      throw new Error('Stored raw message exceeds the inbound limit');
    }
    let metadata: unknown;
    try { metadata = JSON.parse(object.customMetadata?.delivery_metadata ?? 'null'); } catch { metadata = null; }
    return { bytes: new Uint8Array(await object.arrayBuffer()), metadata, sha256: object.customMetadata?.sha256 };
  }

  async delete(id: string): Promise<void> { await this.bucket.delete(this.key(id)); }
  private key(id: string): string { return `raw/${id}.eml`; }
}
