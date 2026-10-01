import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { RawBlobStore } from '../blob-store.js';
import { fingerprintMessageContent, MAIL_CONTENT_FINGERPRINT_VERSION } from './content-fingerprint.js';
import { reconcileVerifiedCopies, storeMailContentFingerprint } from './verified-copies.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Bounded operator maintenance. Raw reads and hashing precede the write lock. */
export async function backfillMailContentFingerprints(pool: Pool, blobs: RawBlobStore,
  options: { limit?: number; afterDeliveryId?: string; mailboxId?: string } = {},
): Promise<{ processed: number; linked: number; moved: number; failures: Array<{deliveryId:string;code:string}>; nextCursor: string | null }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000
    || [options.afterDeliveryId,options.mailboxId].some(value => value !== undefined && !UUID.test(value))) throw new Error('invalid_fingerprint_backfill');
  const rows = (await pool.query<{id:string;mailbox_id:string;sha256:string;raw_size:number}>(`SELECT d.id,d.mailbox_id,d.sha256,d.raw_size FROM deliveries d
    JOIN mail_thread_headers h ON h.message_id=d.id AND h.mailbox_id=d.mailbox_id
    WHERE d.deleted_at IS NULL AND d.parse_status='parsed' AND ($1::uuid IS NULL OR d.id>$1)
      AND ($2::uuid IS NULL OR d.mailbox_id=$2)
      AND NOT EXISTS(SELECT 1 FROM mail_content_fingerprints f WHERE f.delivery_id=d.id)
    ORDER BY d.id LIMIT $3`, [options.afterDeliveryId??null,options.mailboxId??null,limit+1])).rows;
  let processed = 0, linked = 0, moved = 0;
  const failures: Array<{deliveryId:string;code:string}> = [];
  for (const row of rows.slice(0,limit)) {
    let raw: Buffer;
    try { raw = await blobs.get(row.sha256); }
    catch { failures.push({deliveryId:row.id,code:'fingerprint_raw_unavailable'});continue; }
    if (raw.byteLength !== row.raw_size || createHash('sha256').update(raw).digest('hex') !== row.sha256) {
      failures.push({deliveryId:row.id,code:'fingerprint_raw_identity_mismatch'});continue;
    }
    const fingerprint = fingerprintMessageContent(raw);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[row.mailbox_id]);
      const current = await client.query(`SELECT 1 FROM deliveries WHERE id=$1 AND mailbox_id=$2 AND sha256=$3 AND raw_size=$4 AND deleted_at IS NULL`,
        [row.id,row.mailbox_id,row.sha256,row.raw_size]);
      if (current.rowCount) {
        await storeMailContentFingerprint(client,{deliveryId:row.id,mailboxId:row.mailbox_id,version:MAIL_CONTENT_FINGERPRINT_VERSION,
          sha256:fingerprint?.sha256??null,rawSha256:row.sha256,rawSize:row.raw_size});
        const result = await reconcileVerifiedCopies(client,{mailboxId:row.mailbox_id,messageId:row.id});
        processed++;linked+=result.linked;moved+=result.moved;
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return { processed,linked,moved,failures,nextCursor:rows.length>limit?rows[limit-1]!.id:null };
}
