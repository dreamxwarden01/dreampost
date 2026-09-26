import { MAX_INBOUND_BYTES, normalizeRecipientAddress, validateMetadata } from '@dreampost/protocol';
import type { DeliveryMetadata, RoutePolicy } from '@dreampost/protocol';
import type { DeliveryPatch, DeliveryRecord, DeliveryState, Ledger, RawStore, StoredPolicy, StoredRaw } from './model.js';

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

  async applyPolicy(policy: RoutePolicy, digest: string, now: number): Promise<'applied' | 'conflict'> {
    const json = JSON.stringify(policy);
    // Complete snapshots may skip revisions. Monotonic update, operation-ID protection, and history commit together.
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO recipient_policies
        (address, allocation_id, mailbox_id, revision, receive_enabled, operation_id, policy_digest, policy_json, applied_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM recipient_policy_operations WHERE operation_id = ? AND policy_digest <> ?)
          AND NOT EXISTS (SELECT 1 FROM recipient_policy_operations WHERE address = ? AND revision = ? AND policy_digest <> ?)
        ON CONFLICT(address) DO UPDATE SET allocation_id = excluded.allocation_id, mailbox_id = excluded.mailbox_id,
          revision = excluded.revision, receive_enabled = excluded.receive_enabled, operation_id = excluded.operation_id,
          policy_digest = excluded.policy_digest, policy_json = excluded.policy_json, applied_at = excluded.applied_at
        WHERE recipient_policies.revision < excluded.revision`).bind(
        policy.address, policy.allocationId, policy.mailboxId, policy.revision, Number(policy.receiveEnabled),
        policy.operationId, digest, json, now,
        policy.operationId, digest, policy.address, policy.revision, digest,
      ),
      this.db.prepare(`INSERT INTO recipient_policy_operations
        (operation_id, address, revision, policy_digest, policy_json, applied_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM recipient_policies WHERE address = ? AND revision = ? AND operation_id = ? AND policy_digest = ?
        ) ON CONFLICT(operation_id) DO NOTHING`).bind(
        policy.operationId, policy.address, policy.revision, digest, json, now,
        policy.address, policy.revision, policy.operationId, digest,
      ),
      this.db.prepare('SELECT policy_digest FROM recipient_policy_operations WHERE operation_id = ?').bind(policy.operationId),
    ]);
    const recorded = results[2]?.results[0] as { policy_digest?: string } | undefined;
    return recorded?.policy_digest === digest ? 'applied' : 'conflict';
  }

  async getPolicy(address: string): Promise<StoredPolicy | null> {
    // Read the primary; do not permanently reject based on a potentially stale replica/cache.
    const row = await this.db.withSession('first-primary').prepare(
      'SELECT policy_json, policy_digest FROM recipient_policies WHERE address = ?',
    ).bind(address).first<{ policy_json: string; policy_digest: string }>();
    return row ? { policy: JSON.parse(row.policy_json) as RoutePolicy, sha256: row.policy_digest } : null;
  }

  async admitDynamic(record: DeliveryRecord, address: string): Promise<boolean> {
    const metadata = record.metadata;
    if (metadata.version !== 2 || normalizeRecipientAddress(metadata.envelopeTo) !== address) {
      throw new Error('Dynamic admission requires matching version 2 metadata');
    }
    // Admission and the current route check share one statement, ordered against policy updates.
    const result = await this.db.prepare(`INSERT INTO deliveries
      (delivery_id, metadata_json, sha256, state, created_at, updated_at, next_attempt_at,
       last_enqueued_at, lease_token, lease_until, attempts, last_error)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM recipient_policies WHERE address = ? AND allocation_id = ? AND mailbox_id = ?
          AND revision = ? AND policy_digest = ? AND receive_enabled = 1
      )`).bind(
      record.deliveryId, JSON.stringify(metadata), record.sha256, record.state, record.createdAt,
      record.updatedAt, record.nextAttemptAt, record.lastEnqueuedAt, record.leaseToken, record.leaseUntil,
      record.attempts, record.lastError, address, metadata.allocationId, metadata.mailboxId,
      metadata.routeRevision, metadata.policyDigest,
    ).run();
    return result.meta.changes === 1;
  }

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
