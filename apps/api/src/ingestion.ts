import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { normalizeRecipientAddress, type DeliveryAck, type DeliveryMetadata, type VerifiedDelivery } from '@dreampost/protocol';
import type { RawBlobStore } from './blob-store.js';
import { appendChange } from './database.js';
import { ApiError } from './errors.js';

interface StoredDelivery { metadata: DeliveryMetadata; sha256: string; }

function assertSame(existing: StoredDelivery, verified: VerifiedDelivery): void {
  const keys: (keyof DeliveryMetadata)[] = ['version', 'deliveryId', 'mailboxId', 'envelopeFrom', 'envelopeTo', 'receivedAt', 'rawSize'];
  if (existing.sha256 !== verified.sha256 || keys.some((key) => existing.metadata[key] !== verified.metadata[key])) {
    throw new ApiError(409, 'delivery_id_conflict');
  }
}

const existingDelivery = 'SELECT metadata, sha256 FROM deliveries WHERE id = $1';
const configuredRoute = `SELECT m.id FROM mailboxes m JOIN recipient_routes r ON r.mailbox_id = m.id
  WHERE m.id = $1 AND lower(r.address) = $2 AND m.enabled AND r.enabled`;

export async function ingest(pool: Pool, blobs: RawBlobStore, verified: VerifiedDelivery, raw: Uint8Array): Promise<DeliveryAck> {
  const { metadata, sha256 } = verified;
  const recipient = normalizeRecipientAddress(metadata.envelopeTo);
  const ack: DeliveryAck = { version: 1, deliveryId: metadata.deliveryId, sha256, status: 'stored' };
  const previous = await pool.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
  if (previous.rows[0]) {
    assertSame(previous.rows[0], verified);
  } else {
    // Reject unknown routing before writing, without holding a database transaction during fsync.
    const route = await pool.query(configuredRoute, [metadata.mailboxId, recipient]);
    if (!route.rowCount) {
      const raced = await pool.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
      if (!raced.rows[0]) throw new ApiError(422, 'recipient_not_configured');
      assertSame(raced.rows[0], verified);
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
    const route = await client.query(`${configuredRoute} FOR UPDATE OF m, r`, [metadata.mailboxId, recipient]);
    if (!route.rowCount) {
      // Another attempt may have committed before the route changed while this one waited.
      const raced = await client.query<StoredDelivery>(existingDelivery, [metadata.deliveryId]);
      if (!raced.rows[0]) throw new ApiError(422, 'recipient_not_configured');
      assertSame(raced.rows[0], verified);
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
      assertSame(raced.rows[0], verified);
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
