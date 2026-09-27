import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RawBlobStore } from '../blob-store.js';
import { AttachmentStorageError } from './storage.js';
import { attachmentUuidV7 } from './uuid.js';
import { ATTACHMENT_EXTRACTOR_VERSION, AttachmentExtractionError, attachmentManifest, attachmentManifestSha256, extractAttachmentsIsolated } from './extractor.js';
import type { AttachmentBudget, AttachmentExtraction, AttachmentInventory, AttachmentItem, AttachmentRecord, AttachmentStagingStore, UploadReceipt, UploadTask } from './types.js';
export type { AttachmentBudget, AttachmentInventory, AttachmentItem, AttachmentRecord, AttachmentStagingStore, UploadReceipt, UploadTask } from './types.js';

type Database = Pick<PoolClient, 'query'>;
interface ExtractionTask { deliveryId: string; leaseId: string; sha256: string; attempts: number }
const stagingIoErrors = new Set(['EACCES','EPERM','ENOSPC','EDQUOT','EIO','EROFS','EMFILE','ENFILE','ENXIO','ENODEV','EBUSY','ENOENT','ENOTDIR']);
const permanentErrors = new Set(['attachment_count_limit', 'attachment_metadata_limit', 'attachment_content_unavailable', 'attachment_decoded_size_limit', 'attachment_input_size_limit', 'attachment_calendar_correspondence_mismatch', 'attachment_mime_parse_failed', 'attachment_inventory_drift']);

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Call inside the ingestion transaction; the raw-mail ACK does not wait for extraction or upload. */
export async function enqueueAttachmentExtraction(db: Database, deliveryId: string): Promise<void> {
  await db.query('INSERT INTO attachment_inventories(delivery_id) VALUES($1) ON CONFLICT DO NOTHING', [deliveryId]);
  await db.query('INSERT INTO attachment_extraction_jobs(delivery_id) VALUES($1) ON CONFLICT DO NOTHING', [deliveryId]);
}

/** Backfill only messages without a manifest; known immutable inventories use explicit repair. */
export async function scheduleAttachmentBackfill(pool: Pool, options: { limit?: number } = {}): Promise<number> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Attachment backfill limit must be between 1 and 1000.');
  return transaction(pool, async client => {
    const { rows } = await client.query<{ id: string }>(`SELECT d.id FROM deliveries d LEFT JOIN attachment_extraction_jobs j ON j.delivery_id=d.id
      LEFT JOIN attachment_inventories i ON i.delivery_id=d.id
      WHERE d.deleted_at IS NULL AND i.manifest IS NULL
        AND (j.delivery_id IS NULL OR (j.status IN ('done','failed') AND j.extractor_version_attempted<$1))
      ORDER BY d.stored_at,d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED`, [ATTACHMENT_EXTRACTOR_VERSION, limit]);
    let count = 0;
    for (const row of rows) {
      const inserted = await client.query('INSERT INTO attachment_extraction_jobs(delivery_id) VALUES($1) ON CONFLICT DO NOTHING', [row.id]);
      // Recheck after locking in the same job -> inventory order as extraction. A concurrent attempt
      // may have published its manifest after the candidate query; do not requeue that inventory.
      const job = await client.query<{ status: string; extractor_version_attempted: number }>(
        'SELECT status,extractor_version_attempted FROM attachment_extraction_jobs WHERE delivery_id=$1 FOR UPDATE SKIP LOCKED', [row.id]);
      if (!job.rows[0]) continue;
      await client.query('INSERT INTO attachment_inventories(delivery_id) VALUES($1) ON CONFLICT DO NOTHING', [row.id]);
      const inventory = await client.query<{ manifest: unknown }>('SELECT manifest FROM attachment_inventories WHERE delivery_id=$1 FOR UPDATE', [row.id]);
      if (inventory.rows[0]!.manifest !== null) {
        if (inserted.rowCount) await client.query('DELETE FROM attachment_extraction_jobs WHERE delivery_id=$1', [row.id]);
        continue;
      }
      if (inserted.rowCount) { count++; continue; }
      if (!['done','failed'].includes(job.rows[0].status) || job.rows[0].extractor_version_attempted >= ATTACHMENT_EXTRACTOR_VERSION) continue;
      await client.query(`UPDATE attachment_extraction_jobs SET status='pending',attempts=0,available_at=now(),last_error_code=NULL,completed_at=NULL
        WHERE delivery_id=$1`, [row.id]);
      count++;
    }
    return count;
  });
}

async function claimExtraction(pool: Pool): Promise<ExtractionTask | null> {
  return transaction(pool, async client => {
    const { rows } = await client.query<{ delivery_id: string; sha256: string; attempts: number }>(`SELECT j.delivery_id,d.sha256,j.attempts FROM attachment_extraction_jobs j
      JOIN deliveries d ON d.id=j.delivery_id WHERE d.deleted_at IS NULL AND j.available_at<=now()
        AND (j.status IN ('pending','waiting_budget') OR (j.status='inflight' AND j.lease_until<now()))
      ORDER BY j.available_at,j.delivery_id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
    const row = rows[0]; if (!row) return null;
    const leaseId = attachmentUuidV7();
    await client.query(`UPDATE attachment_extraction_jobs SET status='inflight',lease_id=$2,lease_until=now()+interval '120 seconds',
      attempts=attempts+1,extractor_version_attempted=GREATEST(extractor_version_attempted,$3) WHERE delivery_id=$1`, [row.delivery_id, leaseId, ATTACHMENT_EXTRACTOR_VERSION]);
    return { deliveryId: row.delivery_id, sha256: row.sha256, attempts: row.attempts + 1, leaseId };
  });
}
async function lockExtraction(client: PoolClient, task: ExtractionTask): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM attachment_extraction_jobs WHERE delivery_id=$1 AND status='inflight' AND lease_id=$2
    AND lease_until>now() FOR UPDATE`, [task.deliveryId, task.leaseId]);
  return !!result.rowCount;
}
function validateBudget(budget: AttachmentBudget): void {
  for (const value of [budget.stageMaxBytes, budget.storageMaxBytes]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_attachment_budget');
}
function validateExtraction(extraction: AttachmentExtraction): void {
  if (!Number.isSafeInteger(extraction.extractorVersion) || extraction.extractorVersion < 1 || !/^[0-9a-f]{64}$/.test(extraction.optionsSha256)
    || extraction.parts.length > 100) throw new AttachmentExtractionError('attachment_count_limit');
  let total = 0;
  for (const [index, part] of extraction.parts.entries()) {
    total += part.sizeBytes;
    if (part.ordinal !== index || !(part.bytes instanceof Uint8Array) || part.sizeBytes !== part.bytes.byteLength
      || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 0 || total > 25 * 1024 * 1024
      || createHash('sha256').update(part.bytes).digest('hex') !== part.sha256) throw new AttachmentExtractionError('attachment_decoded_size_limit');
  }
}

async function reserveManifest(pool: Pool, task: ExtractionTask, extraction: AttachmentExtraction, budget: AttachmentBudget): Promise<boolean> {
  const manifest = attachmentManifest(extraction.parts), sha256 = attachmentManifestSha256(extraction.parts);
  return transaction(pool, async client => {
    if (!await lockExtraction(client, task)) return false;
    const delivery = await client.query('SELECT 1 FROM deliveries WHERE id=$1 AND deleted_at IS NULL', [task.deliveryId]);
    if (!delivery.rowCount) throw new AttachmentExtractionError('attachment_source_deleted');
    const { rows } = await client.query<{ manifest: unknown; matches: boolean }>(`SELECT manifest,
      (manifest_sha256=$2 AND manifest=$3::jsonb) AS matches
      FROM attachment_inventories WHERE delivery_id=$1 FOR UPDATE`, [task.deliveryId, sha256, JSON.stringify(manifest)]);
    const inventory = rows[0]; if (!inventory) throw new Error('attachment_inventory_missing');
    if (inventory.manifest !== null) {
      // A newer parser may repair missing bytes only when every ordered source tuple still matches.
      // The first manifest's parser/options provenance, attachment IDs and reservations stay immutable.
      if (!inventory.matches) throw new AttachmentExtractionError('attachment_inventory_drift');
      return true;
    }
    const total = extraction.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    const capacity = await client.query<{ staging_bytes: string; storage_bytes: string }>('SELECT staging_bytes,storage_bytes FROM attachment_capacity WHERE singleton FOR UPDATE');
    if (Number(capacity.rows[0]!.staging_bytes) + total > budget.stageMaxBytes || Number(capacity.rows[0]!.storage_bytes) + total > budget.storageMaxBytes) {
      throw new AttachmentExtractionError('attachment_storage_budget_exceeded');
    }
    await client.query('UPDATE attachment_capacity SET staging_bytes=staging_bytes+$1,storage_bytes=storage_bytes+$1 WHERE singleton', [total]);
    await client.query(`UPDATE attachment_inventories SET extractor_version=$2,options_sha256=$3,manifest_sha256=$4,manifest=$5,
      status='pending',error_code=NULL,updated_at=now() WHERE delivery_id=$1`, [task.deliveryId, extraction.extractorVersion, extraction.optionsSha256, sha256, JSON.stringify(manifest)]);
    for (const part of extraction.parts) {
      const id = attachmentUuidV7(), objectKey = `attachments/${id}/${part.sha256}`;
      await client.query(`INSERT INTO attachment_objects(id,sha256,size_bytes,object_key,preview_kind,media_type) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, part.sha256, part.sizeBytes, objectKey, part.previewKind, part.mediaType]);
      await client.query(`INSERT INTO message_attachments(delivery_id,ordinal,attachment_id,filename,mime_type,disposition,content_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [task.deliveryId, part.ordinal, id, part.filename, part.mimeType, part.disposition, part.contentId]);
    }
    return true;
  });
}
async function stageManifest(pool: Pool, task: ExtractionTask, extraction: AttachmentExtraction, staging: AttachmentStagingStore): Promise<void> {
  for (const part of extraction.parts) {
    const owned = await transaction(pool, async client => {
      if (!await lockExtraction(client, task)) return false;
      const { rows } = await client.query<{ id: string; state: string }>(`SELECT o.id,o.state FROM attachment_objects o JOIN message_attachments a ON a.attachment_id=o.id
        WHERE a.delivery_id=$1 AND a.ordinal=$2 FOR UPDATE OF o`, [task.deliveryId, part.ordinal]);
      const object = rows[0]; if (!object) throw new Error('attachment_object_missing');
      if (object.state === 'staging') {
        // IDs and both capacity reservations committed before this write; crashes reuse the same paths.
        try { await staging.put(object.id, part.sha256, part.bytes); }
        catch (error) {
          if (!(error instanceof AttachmentStorageError) && error && typeof error === 'object' && 'code' in error
            && typeof error.code === 'string' && stagingIoErrors.has(error.code)) throw new AttachmentExtractionError('attachment_staging_io_unavailable');
          throw error;
        }
        await client.query("UPDATE attachment_objects SET state='queued' WHERE id=$1", [object.id]);
        await client.query('INSERT INTO attachment_upload_jobs(id,attachment_id) VALUES($1,$2) ON CONFLICT(attachment_id) DO NOTHING', [attachmentUuidV7(), object.id]);
      }
      await client.query("UPDATE attachment_extraction_jobs SET lease_until=now()+interval '120 seconds' WHERE delivery_id=$1", [task.deliveryId]);
      return true;
    });
    if (!owned) return;
  }
  await transaction(pool, async client => {
    if (!await lockExtraction(client, task)) return;
    await client.query("UPDATE attachment_inventories SET status='complete',error_code=NULL,updated_at=now() WHERE delivery_id=$1", [task.deliveryId]);
    await client.query(`UPDATE attachment_extraction_jobs SET status='done',lease_id=NULL,lease_until=NULL,last_error_code=NULL,completed_at=now() WHERE delivery_id=$1`, [task.deliveryId]);
  });
}
async function failExtraction(pool: Pool, task: ExtractionTask, errorCode: string): Promise<void> {
  await transaction(pool, async client => {
    if (!await lockExtraction(client, task)) return;
    const waitingBudget = ['attachment_storage_budget_exceeded', 'attachment_staging_disk_pressure'].includes(errorCode);
    const failed = permanentErrors.has(errorCode) || task.attempts >= 5 || errorCode === 'attachment_source_deleted';
    const status = waitingBudget ? 'waiting_budget' : failed ? 'failed' : 'pending';
    await client.query(`UPDATE attachment_extraction_jobs SET status=$3,lease_id=NULL,lease_until=NULL,last_error_code=$4,
      attempts=attempts-$5,available_at=now()+make_interval(secs=>$6),completed_at=CASE WHEN $3='failed' THEN now() ELSE NULL END
      WHERE delivery_id=$1 AND lease_id=$2`, [task.deliveryId, task.leaseId, status, errorCode, waitingBudget ? 1 : 0, waitingBudget ? 60 : Math.min(3600, 30 * 2 ** Math.max(0, task.attempts - 1))]);
    await client.query(`UPDATE attachment_inventories SET status=$2,error_code=$3,updated_at=now() WHERE delivery_id=$1`,
      [task.deliveryId, errorCode === 'attachment_inventory_drift' ? 'drift' : status === 'failed' ? 'unavailable' : 'pending', errorCode]);
  });
}
export async function runOneAttachmentExtractionJob(pool: Pool, rawBlobs: RawBlobStore, staging: AttachmentStagingStore, budget: AttachmentBudget,
  options: { extract?: typeof extractAttachmentsIsolated } = {}): Promise<boolean> {
  validateBudget(budget);
  const task = await claimExtraction(pool); if (!task) return false;
  try {
    const extraction = await (options.extract ?? extractAttachmentsIsolated)(await rawBlobs.get(task.sha256));
    validateExtraction(extraction);
    if (await reserveManifest(pool, task, extraction, budget)) await stageManifest(pool, task, extraction, staging);
  } catch (error) { await failExtraction(pool, task, error instanceof AttachmentExtractionError || error instanceof AttachmentStorageError ? error.code : 'attachment_storage_unavailable'); }
  return true;
}

interface AttachmentRow { id: string; filename: string; mime_type: string; media_type: string; size_bytes: string; disposition: string | null;
  content_id: string | null; upload_status: string | null; state: AttachmentItem['state']; preview_kind: AttachmentItem['previewKind']; sha256: string; object_key: string; delivery_id: string; mailbox_id: string; ordinal: number }
const selectAttachment = `SELECT o.*,u.status AS upload_status,a.filename,a.mime_type,a.disposition,a.content_id,a.delivery_id,a.ordinal,d.mailbox_id
  FROM attachment_objects o JOIN message_attachments a ON a.attachment_id=o.id JOIN deliveries d ON d.id=a.delivery_id JOIN mailboxes m ON m.id=d.mailbox_id LEFT JOIN attachment_upload_jobs u ON u.attachment_id=o.id`;
function safeFilename(original: string, ordinal: number): string {
  const basename = (original.split(/[\\/]/).at(-1) ?? '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  let name = '', bytes = 0;
  for (const character of basename) { const size = Buffer.byteLength(character); if (bytes + size > 240) break; name += character; bytes += size; }
  return name && name !== '.' && name !== '..' ? name : `attachment-${ordinal + 1}`;
}
function item(row: AttachmentRow): AttachmentItem { return { id: row.id, filename: safeFilename(row.filename, row.ordinal), mimeType: row.media_type,
  sizeBytes: Number(row.size_bytes), disposition: row.disposition, contentId: row.content_id, deliveryKind: 'mime', state: row.state === 'queued' && row.upload_status === 'blocked' ? 'failed' : row.state, previewKind: row.preview_kind, sha256: row.sha256 }; }
/** The caller must authorize mailbox membership. This helper also excludes deleted sources and disabled mailboxes. */
export async function getAttachment(pool: Pick<Pool, 'query'>, deliveryId: string, attachmentId: string): Promise<AttachmentRecord | null> {
  const { rows } = await pool.query<AttachmentRow>(`${selectAttachment} WHERE a.delivery_id=$1 AND o.id=$2 AND d.deleted_at IS NULL AND m.enabled`, [deliveryId, attachmentId]);
  const row = rows[0]; return row ? { ...item(row), deliveryId: row.delivery_id, mailboxId: row.mailbox_id, objectKey: row.object_key } : null;
}
/** Status is separate from items: a drift warning does not hide previously ready immutable objects. */
export async function listAttachments(pool: Pick<Pool, 'query'>, deliveryId: string): Promise<AttachmentInventory> {
  const { rows: inventories } = await pool.query<{ status: AttachmentInventory['status']; error_code: string | null }>(`SELECT i.status,i.error_code FROM attachment_inventories i
    JOIN deliveries d ON d.id=i.delivery_id JOIN mailboxes m ON m.id=d.mailbox_id WHERE i.delivery_id=$1 AND d.deleted_at IS NULL AND m.enabled`, [deliveryId]);
  const { rows } = await pool.query<AttachmentRow>(`${selectAttachment} WHERE a.delivery_id=$1 AND d.deleted_at IS NULL AND m.enabled ORDER BY a.ordinal`, [deliveryId]);
  return { status: inventories[0]?.status ?? 'pending', errorCode: inventories[0]?.error_code ?? null, items: rows.map(item) };
}

export async function claimAttachmentUpload(pool: Pool): Promise<UploadTask | null> {
  return transaction(pool, async client => {
    const { rows } = await client.query<{ id: string; attachment_id: string; object_key: string; sha256: string; size_bytes: string; attempts: number }>(`SELECT j.id,j.attachment_id,o.object_key,o.sha256,o.size_bytes,j.attempts
      FROM attachment_upload_jobs j JOIN attachment_objects o ON o.id=j.attachment_id JOIN message_attachments a ON a.attachment_id=o.id
      JOIN deliveries d ON d.id=a.delivery_id WHERE o.state='queued' AND d.deleted_at IS NULL AND j.available_at<=now()
        AND (j.status='pending' OR (j.status='inflight' AND j.lease_until<now())) ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
    const row = rows[0]; if (!row) return null;
    const leaseId = attachmentUuidV7();
    await client.query("UPDATE attachment_upload_jobs SET status='inflight',lease_id=$2,lease_until=now()+interval '300 seconds',attempts=attempts+1 WHERE id=$1", [row.id, leaseId]);
    return { id: row.id, attachmentId: row.attachment_id, leaseId, objectKey: row.object_key, sha256: row.sha256, sizeBytes: Number(row.size_bytes), attempts: row.attempts + 1 };
  });
}
/** Only call with a remotely verified immutable-object receipt, never merely after a successful HTTP status. */
export async function completeAttachmentUpload(pool: Pool, task: UploadTask, receipt: UploadReceipt): Promise<boolean> {
  if (receipt.objectKey !== task.objectKey || receipt.sha256 !== task.sha256 || receipt.sizeBytes !== task.sizeBytes) throw new Error('attachment_upload_receipt_mismatch');
  return transaction(pool, async client => {
    const job = await client.query(`SELECT 1 FROM attachment_upload_jobs WHERE id=$1 AND attachment_id=$2 AND status='inflight'
      AND lease_id=$3 AND lease_until>now() FOR UPDATE`, [task.id, task.attachmentId, task.leaseId]);
    if (!job.rowCount) return false;
    const object = await client.query(`UPDATE attachment_objects SET state='ready',ready_at=now() WHERE id=$1 AND state='queued'
      AND sha256=$2 AND size_bytes=$3 AND object_key=$4 RETURNING id`, [task.attachmentId, task.sha256, task.sizeBytes, task.objectKey]);
    if (!object.rowCount) throw new Error('attachment_upload_object_mismatch');
    await client.query("UPDATE attachment_upload_jobs SET status='done',lease_id=NULL,lease_until=NULL,last_error_code=NULL,completed_at=now() WHERE id=$1", [task.id]);
    return true;
  });
}
export async function retryAttachmentUpload(pool: Pool, task: UploadTask, errorCode: string, options: { blocked?: boolean } = {}): Promise<boolean> {
  if (!/^[a-z][a-z0-9_]{0,95}$/.test(errorCode)) throw new Error('invalid_attachment_error_code');
  const result = await pool.query(`UPDATE attachment_upload_jobs SET status=$4,lease_id=NULL,lease_until=NULL,last_error_code=$5,
    available_at=now()+make_interval(secs=>$6) WHERE id=$1 AND attachment_id=$2 AND status='inflight' AND lease_id=$3 AND lease_until>now()`,
  [task.id, task.attachmentId, task.leaseId, options.blocked ? 'blocked' : 'pending', errorCode, Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, task.attempts - 1)))]);
  return !!result.rowCount;
}

/** Explicit repair after a verified local ENOENT; do not use for corrupt bytes or failed remote authorization. */
export async function repairMissingAttachmentStaging(pool: Pool, task: UploadTask): Promise<boolean> {
  return transaction(pool, async client => {
    const source = await client.query<{ delivery_id: string }>(`SELECT a.delivery_id FROM message_attachments a JOIN deliveries d ON d.id=a.delivery_id
      WHERE a.attachment_id=$1 AND d.deleted_at IS NULL`, [task.attachmentId]);
    const deliveryId = source.rows[0]?.delivery_id; if (!deliveryId) return false;
    const extraction = await client.query(`SELECT 1 FROM attachment_extraction_jobs WHERE delivery_id=$1 AND status<>'inflight' FOR UPDATE`, [deliveryId]);
    if (!extraction.rowCount) return false;
    const upload = await client.query(`SELECT 1 FROM attachment_upload_jobs WHERE id=$1 AND attachment_id=$2 AND status='inflight'
      AND lease_id=$3 AND lease_until>now() FOR UPDATE`, [task.id, task.attachmentId, task.leaseId]);
    if (!upload.rowCount) return false;
    const object = await client.query(`UPDATE attachment_objects SET state='staging' WHERE id=$1 AND state='queued'
      AND sha256=$2 AND size_bytes=$3 AND object_key=$4 RETURNING id`, [task.attachmentId, task.sha256, task.sizeBytes, task.objectKey]);
    if (!object.rowCount) return false;
    await client.query(`UPDATE attachment_extraction_jobs SET status='pending',attempts=0,available_at=now(),completed_at=NULL,last_error_code='attachment_staging_missing' WHERE delivery_id=$1`, [deliveryId]);
    await client.query(`UPDATE attachment_inventories SET status='pending',error_code='attachment_staging_missing',updated_at=now() WHERE delivery_id=$1`, [deliveryId]);
    return true;
  });
}


export interface StagingRetryRequest {
  deliveryId: string; expectedManifestSha256: string; expectedAttempts: number; expectedFailureAt: string; operatorLabel: string;
}
export interface StagingRetryReceipt {
  deliveryId: string; manifestSha256: string; previousAttempts: number; previousFailureAt: string; operatorLabel: string; scheduledAt: string;
}
/** Privileged local maintenance only. No HTTP route exposes this retry and no admission checks are relaxed. */
export async function retryFailedAttachmentStaging(pool: Pool, request: StagingRetryRequest): Promise<StagingRetryReceipt | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.deliveryId)
    || !/^[0-9a-f]{64}$/.test(request.expectedManifestSha256) || !Number.isSafeInteger(request.expectedAttempts)
    || request.expectedAttempts < 5 || request.expectedAttempts > 2147483647
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(request.expectedFailureAt) || !Number.isFinite(Date.parse(request.expectedFailureAt))
    || typeof request.operatorLabel !== 'string' || !request.operatorLabel.trim() || request.operatorLabel.length > 128
    || /[\x00-\x1f\x7f]/.test(request.operatorLabel)) throw new Error('invalid_attachment_staging_retry');
  return transaction(pool, async client => {
    const job = await client.query(`SELECT 1 FROM attachment_extraction_jobs j JOIN deliveries d ON d.id=j.delivery_id
      WHERE j.delivery_id=$1 AND j.status='failed' AND j.lease_id IS NULL AND j.lease_until IS NULL
        AND j.attempts=$2 AND j.completed_at=$3::timestamptz AND j.last_error_code='attachment_staging_io_unavailable'
        AND d.deleted_at IS NULL FOR UPDATE OF j`, [request.deliveryId, request.expectedAttempts, request.expectedFailureAt]);
    if (!job.rowCount) return null;
    const inventory = await client.query(`SELECT 1 FROM attachment_inventories WHERE delivery_id=$1 AND status='unavailable'
      AND error_code='attachment_staging_io_unavailable' AND manifest IS NOT NULL AND manifest_sha256=$2 FOR UPDATE`,
    [request.deliveryId, request.expectedManifestSha256]);
    if (!inventory.rowCount) return null;
    const staging = await client.query(`SELECT 1 FROM message_attachments a JOIN attachment_objects o ON o.id=a.attachment_id
      WHERE a.delivery_id=$1 AND o.state='staging' LIMIT 1`, [request.deliveryId]);
    if (!staging.rowCount) return null;
    const result = await client.query<{ available_at: Date }>(`UPDATE attachment_extraction_jobs SET status='pending',attempts=0,
      available_at=now(),completed_at=NULL,last_error_code=NULL WHERE delivery_id=$1 RETURNING available_at`, [request.deliveryId]);
    await client.query("UPDATE attachment_inventories SET status='pending',error_code=NULL,updated_at=now() WHERE delivery_id=$1", [request.deliveryId]);
    return { deliveryId: request.deliveryId, manifestSha256: request.expectedManifestSha256, previousAttempts: request.expectedAttempts, previousFailureAt: request.expectedFailureAt,
      operatorLabel: request.operatorLabel, scheduledAt: result.rows[0]!.available_at.toISOString() };
  });
}

/** Crash-safe cleanup: mark ready first, remove local bytes, then release only the staging reservation. */
export async function cleanupReadyAttachmentStaging(pool: Pool, staging: AttachmentStagingStore, options: { limit?: number } = {}): Promise<number> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_attachment_cleanup_limit');
  let count = 0;
  for (; count < limit; count++) {
    const found = await transaction(pool, async client => {
      const { rows } = await client.query<{ id: string; sha256: string; size_bytes: string }>(`SELECT id,sha256,size_bytes FROM attachment_objects
        WHERE state='ready' AND stage_released_at IS NULL ORDER BY ready_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = rows[0]; if (!row) return false;
      await staging.remove(row.id, row.sha256);
      await client.query('UPDATE attachment_capacity SET staging_bytes=staging_bytes-$1 WHERE singleton', [row.size_bytes]);
      await client.query('UPDATE attachment_objects SET stage_released_at=now() WHERE id=$1', [row.id]);
      return true;
    });
    if (!found) break;
  }
  return count;
}
