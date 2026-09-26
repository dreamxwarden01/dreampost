import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { normalizeRecipientAddress, type DeliveryAck, type DeliveryMetadata, type VerifiedDelivery } from '@dreampost/protocol';
import type { RawBlobStore } from './blob-store.js';
import { appendChange } from './database.js';
import { ApiError } from './errors.js';

interface StoredDelivery { metadata: DeliveryMetadata; sha256: string; }

function assertSame(existing: StoredDelivery, verified: VerifiedDelivery): void {
  if (existing.sha256 !== verified.sha256 || JSON.stringify(existing.metadata) !== JSON.stringify(verified.metadata)) {
    // PostgreSQL jsonb reorders fields; compare the strict canonical metadata shape below.
    const keys = new Set([...Object.keys(existing.metadata), ...Object.keys(verified.metadata)]);
    const left = existing.metadata as unknown as Record<string, unknown>;
    const right = verified.metadata as unknown as Record<string, unknown>;
    if (existing.sha256 !== verified.sha256 || [...keys].some(key => left[key] !== right[key])) {
      throw new ApiError(409, 'delivery_id_conflict');
    }
  }
}

const existingDelivery = 'SELECT metadata, sha256 FROM deliveries WHERE id = $1';
const configuredRoute = `SELECT m.id FROM mailboxes m JOIN recipient_routes r ON r.mailbox_id = m.id
  WHERE m.id = $1 AND lower(r.address) = $2 AND m.enabled AND r.enabled`;

export async function ingest(pool: Pool, blobs: RawBlobStore, verified: VerifiedDelivery, raw: Uint8Array): Promise<DeliveryAck> {
  const { metadata, sha256 } = verified;
  const recipient = normalizeRecipientAddress(metadata.envelopeTo);
  const historyRoute = `SELECT m.id FROM mailboxes m JOIN address_policy_history p ON p.mailbox_id = m.id
    WHERE m.id = $1 AND p.address = $2 AND p.allocation_id = $3 AND p.revision = $4 AND p.sha256 = $5 AND p.receive_enabled`;
  // V2 validates the admission-era binding, even if the address or user is now paused.
  // It must never reinterpret an accepted message using the current address owner.
  const routeQuery = metadata.version === 2 ? historyRoute : configuredRoute;
  const routeParameters = metadata.version === 2
    ? [metadata.mailboxId, recipient, metadata.allocationId, metadata.routeRevision, metadata.policyDigest]
    : [metadata.mailboxId, recipient];
  const lockClause = metadata.version === 2 ? ' FOR UPDATE OF m' : ' FOR UPDATE OF m, r';
  async function unknownRoute(db: Pick<Pool, 'query'>): Promise<never> {
    if (metadata.version === 2) {
      const known = await db.query('SELECT 1 FROM address_policy_history WHERE allocation_id = $1 AND revision = $2',
        [metadata.allocationId, metadata.routeRevision]);
      if (!known.rowCount) throw new ApiError(503, 'admission_history_unavailable');
    }
    throw new ApiError(422, 'recipient_not_configured');
  }
  const ack: DeliveryAck = { version: 1, deliveryId: metadata.deliveryId, sha256, status: 'stored' };
  const previous = await pool.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
  if (previous.rows[0]) {
    assertSame(previous.rows[0], verified);
  } else {
    // Reject unknown routing before writing, without holding a database transaction during fsync.
    const route = await pool.query(routeQuery, routeParameters);
    if (!route.rowCount) {
      const raced = await pool.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
      if (!raced.rows[0]) await unknownRoute(pool);
      assertSame(raced.rows[0]!, verified);
    }
  }
  await blobs.put(sha256, raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit = on');
    const committed = await client.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
    if (committed.rows[0]) {
      assertSame(committed.rows[0], verified);
      // A committed identical delivery remains acknowledgeable after its route is disabled.
      await client.query('COMMIT');
      return ack;
    }
    // Use the lifecycle service's mailbox-before-route lock order.
    await client.query('SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE', [metadata.mailboxId]);
    const route = await client.query(`${routeQuery}${lockClause}`, routeParameters);
    if (!route.rowCount) {
      // Another attempt may have committed before the route changed while this one waited.
      const raced = await client.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
      if (!raced.rows[0]) await unknownRoute(client);
      assertSame(raced.rows[0]!, verified);
      await client.query('COMMIT');
      return ack;
    }
    const inserted = await client.query(
      `INSERT INTO deliveries (id, mailbox_id, metadata, sha256, raw_size, received_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [metadata.deliveryId, metadata.mailboxId, metadata, sha256, metadata.rawSize, metadata.receivedAt],
    );
    if (!inserted.rowCount) {
      const raced = await client.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
      if (!raced.rows[0]) throw new Error('delivery_race');
      assertSame(raced.rows[0]!, verified);
    } else {
      await client.query('INSERT INTO durable_jobs (id, delivery_id, kind) VALUES ($1, $2, $3)', [randomUUID(), metadata.deliveryId, 'parse']);
      await appendChange(client, metadata.mailboxId, metadata.deliveryId, 'message.received');
    }
    await client.query('COMMIT');
    return ack;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
