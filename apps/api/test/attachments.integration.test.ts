import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHeaders, verifyDeliveryHeaders, createAttachmentUploadResponseHeaders, type DeliveryMetadata } from '@dreampost/protocol';
import { migrate, seedMailbox } from '../src/database.js';
import { FileBlobStore } from '../src/blob-store.js';
import { ingest } from '../src/ingestion.js';
import { FileAttachmentStagingStore } from '../src/attachments/storage.js';
import { extractAttachmentsIsolated } from '../src/attachments/extractor.js';
import { claimAttachmentUpload, cleanupReadyAttachmentStaging, completeAttachmentUpload, enqueueAttachmentExtraction, getAttachment,
  listAttachments, repairMissingAttachmentStaging, retryFailedAttachmentStaging, retryAttachmentUpload, runOneAttachmentExtractionJob, scheduleAttachmentBackfill } from '../src/attachments/service.js';
import type { AttachmentStagingStore, UploadTask } from '../src/attachments/types.js';
import { runOneAttachmentUpload } from '../src/downloads/upload.js';
import type { DownloadConfig } from '../src/downloads/config.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const key = { id: 'attachment-test', secret: 'attachment-fixture-ingestion-secret-at-least-32-bytes' };
const budget = { stageMaxBytes: 256 * 1024 * 1024, storageMaxBytes: 5 * 1024 * 1024 * 1024 };
function mime(parts: Buffer[]) { return Buffer.from('From: sender@example.test\r\nTo: attachments@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n'
  + '--fixture\r\nContent-Type: text/plain\r\n\r\nMail body\r\n' + parts.map(bytes => '--fixture\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="document.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + bytes.toString('base64') + '\r\n').join('') + '--fixture--\r\n'); }

describe.skipIf(!databaseUrl)('attachment manifests, durable work and physical budgets', () => {
  const schema = `attachments_${randomUUID().replaceAll('-', '')}`, mailboxId = randomUUID();
  let admin: pg.Pool, pool: pg.Pool, directory: string, raw: FileBlobStore, staging: FileAttachmentStagingStore;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 }); await migrate(pool);
    directory = await mkdtemp(join(tmpdir(), 'dreampost-attachments-')); raw = new FileBlobStore(join(directory, 'raw')); staging = new FileAttachmentStagingStore(join(directory, 'stage'));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE mailboxes,principals,attachment_objects CASCADE'); await pool.query('UPDATE attachment_capacity SET staging_bytes=0,storage_bytes=0');
    await seedMailbox(pool, { id: mailboxId, address: 'attachments@example.test', name: 'Attachment fixture' });
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); if (pool) await pool.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
  async function deliver(parts: Buffer[] = [Buffer.from('%PDF-1.7\nFixture')], enqueue = true) {
    const bytes = mime(parts);
    const metadata: DeliveryMetadata = { version: 1, deliveryId: randomUUID(), mailboxId, envelopeFrom: 'sender@example.test', envelopeTo: 'attachments@example.test', receivedAt: new Date().toISOString(), rawSize: bytes.length };
    const verified = await verifyDeliveryHeaders(await createDeliveryHeaders(metadata, bytes, key), { [key.id]: key.secret });
    const ack = await ingest(pool, raw, verified, bytes);
    if (enqueue) await enqueueAttachmentExtraction(pool, metadata.deliveryId);
    return { id: metadata.deliveryId, bytes, ack };
  }
  async function requeue(id: string) { await pool.query("UPDATE attachment_extraction_jobs SET status='pending',lease_id=NULL,lease_until=NULL,available_at=now(),attempts=0 WHERE delivery_id=$1", [id]); }
  async function failureAt(id: string): Promise<string> {
    const result = await pool.query<{ failed_at: string }>(`SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS failed_at FROM attachment_extraction_jobs WHERE delivery_id=$1`, [id]);
    return result.rows[0]!.failed_at;
  }
  async function ready(task: UploadTask) { expect(await completeAttachmentUpload(pool, task, { objectKey: task.objectKey, sha256: task.sha256, sizeBytes: task.sizeBytes })).toBe(true); }

  const downloadConfig: DownloadConfig = { origin: 'https://download.example.test', previewOrigin: 'https://preview.example-isolated.test',
    key: { id: 'uploads', secret: 'synthetic-upload-key-at-least-32-characters' }, stagingPath: '/unused', sessionTtlSeconds: 3600,
    maxPreviewBytes: 20 * 1024 * 1024, ...budget, maxSessions: 16, maxPendingSessions: 4, allowInsecureLocal: false };
  it.each([409, 422, 503])('keeps unsigned HTTP %i upload failures retryable', async status => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect(await runOneAttachmentUpload(pool, staging, downloadConfig, async () => new Response('Synthetic upstream failure', { status }))).toBe(true);
    expect((await pool.query('SELECT status,last_error_code FROM attachment_upload_jobs')).rows[0]).toEqual({ status: 'pending', last_error_code: `upload_http_${status}` });
    expect((await listAttachments(pool, mail.id)).items[0]?.state).toBe('queued');
  });
  it('marks ready only after an authenticated matching upload acknowledgment', async () => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const item = (await listAttachments(pool, mail.id)).items[0]!;
    const ack = { version: 1 as const, status: 'stored' as const, attachmentId: item.id, sha256: item.sha256, sizeBytes: item.sizeBytes, objectKey: `attachments/${item.id}/${item.sha256}` };
    await runOneAttachmentUpload(pool, staging, downloadConfig, async () => Response.json(ack));
    expect((await getAttachment(pool, mail.id, item.id))?.state).toBe('queued');
    await pool.query('UPDATE attachment_upload_jobs SET available_at=now()');
    await runOneAttachmentUpload(pool, staging, downloadConfig, async (_input, init) => new Response(JSON.stringify(ack), {
      headers: await createAttachmentUploadResponseHeaders(ack, downloadConfig.key, { requestNonce: new Headers(init?.headers).get('x-dreampost-download-nonce')! }),
    }));
    expect((await getAttachment(pool, mail.id, item.id))?.state).toBe('ready');
  });
  it('queues raw-backed repair when the upload client discovers missing staged bytes', async () => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const item = (await listAttachments(pool, mail.id)).items[0]!;
    await staging.remove(item.id, item.sha256);
    await runOneAttachmentUpload(pool, staging, downloadConfig, async () => { throw new Error('No upload should occur before repair'); });
    expect((await getAttachment(pool, mail.id, item.id))?.state).toBe('staging');
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect((await getAttachment(pool, mail.id, item.id))?.state).toBe('queued');
    expect(await staging.get(item.id, item.sha256)).toHaveLength(item.sizeBytes);
  });

  it('extracts immutable UUIDv7 identities and distinct duplicate parts without changing raw mail or ownership', async () => {
    const bytes = Buffer.from('%PDF-1.7\nDuplicate'), mail = await deliver([bytes, bytes, Buffer.alloc(0)]);
    expect(await runOneAttachmentExtractionJob(pool, raw, staging, budget)).toBe(true);
    const inventory = await listAttachments(pool, mail.id);
    expect(inventory.status).toBe('complete'); expect(inventory.items).toHaveLength(3);
    expect(new Set(inventory.items.map(item => item.id)).size).toBe(3);
    for (const item of inventory.items) expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
    expect(inventory.items.map(item => item.state)).toEqual(['queued', 'queued', 'queued']);
    expect(inventory.items.map(item => item.mimeType)).toEqual(['application/pdf', 'application/pdf', 'application/octet-stream']);
    expect(await raw.get(mail.ack.sha256)).toEqual(mail.bytes);
    await requeue(mail.id); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect((await listAttachments(pool, mail.id)).items.map(item => item.id)).toEqual(inventory.items.map(item => item.id));
    expect((await pool.query('SELECT count(*) FROM attachment_upload_jobs')).rows[0].count).toBe('3');
    expect((await pool.query('SELECT staging_bytes,storage_bytes FROM attachment_capacity')).rows[0]).toEqual({ staging_bytes: String(bytes.length * 2), storage_bytes: String(bytes.length * 2) });
  });

  it('retains a ready immutable object on tuple drift and rejects changed manifest metadata in PostgreSQL', async () => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const task = (await claimAttachmentUpload(pool))!; await ready(task);
    await requeue(mail.id);
    await runOneAttachmentExtractionJob(pool, raw, staging, budget, { extract: async bytes => { const value = await extractAttachmentsIsolated(bytes); value.parts[0]!.filename = 'changed.pdf'; return value; } });
    expect((await listAttachments(pool, mail.id)).status).toBe('drift');
    expect(await getAttachment(pool, mail.id, task.attachmentId)).toMatchObject({ state: 'ready', filename: 'document.pdf', sha256: task.sha256 });
    await expect(pool.query("UPDATE attachment_inventories SET manifest='[]' WHERE delivery_id=$1", [mail.id])).rejects.toThrow('attachment_manifest_immutable');
    await expect(pool.query("UPDATE message_attachments SET filename='overwrite.pdf' WHERE delivery_id=$1", [mail.id])).rejects.toThrow('attachment_association_immutable');
    await expect(pool.query("UPDATE attachment_objects SET sha256=repeat('0',64) WHERE id=$1", [task.attachmentId])).rejects.toThrow('attachment_identity_immutable');
  });

  it('accepts compatible extractor options without rewriting original manifest provenance or identities', async () => {
    const mail = await deliver([Buffer.from('first'), Buffer.from('second')]); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const before = (await listAttachments(pool, mail.id)).items.map(item => item.id);
    const proof = (await pool.query('SELECT extractor_version,options_sha256,manifest_sha256,manifest FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows;
    await requeue(mail.id);
    await runOneAttachmentExtractionJob(pool, raw, staging, budget, { extract: async bytes => {
      const result = await extractAttachmentsIsolated(bytes); result.optionsSha256 = 'f'.repeat(64); return result;
    } });
    expect((await listAttachments(pool, mail.id)).status).toBe('complete');
    expect((await listAttachments(pool, mail.id)).items.map(item => item.id)).toEqual(before);
    expect((await pool.query('SELECT extractor_version,options_sha256,manifest_sha256,manifest FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows).toEqual(proof);
  });

  it('rejects changed MIME metadata and ordered correspondence even when a newer extractor supplies them', async () => {
    const mail = await deliver([Buffer.from('first'), Buffer.from('second')]); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const before = (await listAttachments(pool, mail.id)).items.map(item => item.id);
    for (const change of ['mime', 'disposition', 'filename', 'cid', 'order']) {
      await requeue(mail.id);
      await runOneAttachmentExtractionJob(pool, raw, staging, budget, { extract: async bytes => {
        const result = await extractAttachmentsIsolated(bytes); result.extractorVersion = 2; result.optionsSha256 = 'f'.repeat(64);
        if (change === 'mime') result.parts[0]!.mimeType = 'text/plain';
        else if (change === 'disposition') result.parts[0]!.disposition = 'inline';
        else if (change === 'filename') result.parts[0]!.filename = 'changed.pdf';
        else if (change === 'cid') result.parts[0]!.contentId = '<new@example.test>';
        else { result.parts.reverse(); result.parts.forEach((part, ordinal) => { part.ordinal = ordinal; }); }
        return result;
      } });
      expect((await listAttachments(pool, mail.id)).status).toBe('drift');
      expect((await listAttachments(pool, mail.id)).items.map(item => item.id)).toEqual(before);
    }
  });

  it('repairs missing queued staging after an extractor upgrade using the full original manifest and reservations', async () => {
    const mail = await deliver([Buffer.from('%PDF-1.7\nFirst'), Buffer.from('%PDF-1.7\nSecond')]);
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const completed = (await claimAttachmentUpload(pool))!; await ready(completed);
    const missing = (await claimAttachmentUpload(pool))!;
    const ids = (await listAttachments(pool, mail.id)).items.map(item => item.id);
    const proof = (await pool.query('SELECT extractor_version,options_sha256,manifest_sha256,manifest FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows;
    const capacity = (await pool.query('SELECT * FROM attachment_capacity')).rows;
    await staging.remove(missing.attachmentId, missing.sha256);
    expect(await repairMissingAttachmentStaging(pool, missing)).toBe(true);
    expect(await retryAttachmentUpload(pool, missing, 'attachment_staging_missing')).toBe(true);
    await runOneAttachmentExtractionJob(pool, raw, staging, budget, { extract: async bytes => {
      const result = await extractAttachmentsIsolated(bytes); result.extractorVersion = 2; result.optionsSha256 = 'f'.repeat(64); return result;
    } });
    expect(await staging.get(missing.attachmentId, missing.sha256)).toHaveLength(missing.sizeBytes);
    expect((await listAttachments(pool, mail.id)).status).toBe('complete');
    expect((await getAttachment(pool, mail.id, completed.attachmentId))?.state).toBe('ready');
    await pool.query("UPDATE attachment_upload_jobs SET available_at=now() WHERE status='pending'");
    const upload = (await claimAttachmentUpload(pool))!; expect(upload.attachmentId).toBe(missing.attachmentId); await ready(upload);
    expect((await listAttachments(pool, mail.id)).items.map(item => item.state)).toEqual(['ready', 'ready']);
    expect((await listAttachments(pool, mail.id)).items.map(item => item.id)).toEqual(ids);
    expect((await pool.query('SELECT extractor_version,options_sha256,manifest_sha256,manifest FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows).toEqual(proof);
    expect((await pool.query('SELECT * FROM attachment_capacity')).rows).toEqual(capacity);
    expect(await raw.get(mail.ack.sha256)).toEqual(mail.bytes);
  });

  it('backfills only missing manifests and skips established or actively locked inventories', async () => {
    const complete = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    // Simulate a job from a previous extractor version without modifying its immutable manifest.
    await pool.query('UPDATE attachment_extraction_jobs SET extractor_version_attempted=0 WHERE delivery_id=$1', [complete.id]);
    const unknown = await deliver([], false);
    await enqueueAttachmentExtraction(pool, unknown.id);
    await pool.query("UPDATE attachment_extraction_jobs SET status='failed',extractor_version_attempted=0 WHERE delivery_id=$1", [unknown.id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT 1 FROM attachment_extraction_jobs WHERE delivery_id=$1 FOR UPDATE', [unknown.id]);
      expect(await scheduleAttachmentBackfill(pool)).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await scheduleAttachmentBackfill(pool)).toBe(1);
    expect((await pool.query('SELECT status FROM attachment_extraction_jobs WHERE delivery_id=$1', [complete.id])).rows[0].status).toBe('done');
    expect((await listAttachments(pool, complete.id)).status).toBe('complete');
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect(await scheduleAttachmentBackfill(pool)).toBe(0);
  });

  it('commits reservations before local I/O and resumes the same IDs after a staging failure', async () => {
    const mail = await deliver();
    const failing: AttachmentStagingStore = { get: staging.get.bind(staging), remove: staging.remove.bind(staging), put: async () => { throw new Error('fixture disk outage'); } };
    await runOneAttachmentExtractionJob(pool, raw, failing, budget);
    const before = (await listAttachments(pool, mail.id)).items;
    expect(before).toHaveLength(1); expect(before[0]!.state).toBe('staging');
    expect((await listAttachments(pool, mail.id)).status).toBe('pending');
    expect((await pool.query('SELECT count(*) FROM attachment_upload_jobs')).rows[0].count).toBe('0');
    const reservation = (await pool.query('SELECT staging_bytes,storage_bytes FROM attachment_capacity')).rows;
    await pool.query('UPDATE attachment_extraction_jobs SET available_at=now()');
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect((await listAttachments(pool, mail.id)).items[0]).toMatchObject({ id: before[0]!.id, state: 'queued' });
    expect((await pool.query('SELECT staging_bytes,storage_bytes FROM attachment_capacity')).rows).toEqual(reservation);
  });


  it('retries an exhausted staging I/O failure by exact operator CAS without changing ready identities or reservations', async () => {
    const first = Buffer.from('%PDF-1.7\nAlready staged'), second = Buffer.from('%PDF-1.7\nRecoverable write');
    const secondDigest = createHash('sha256').update(second).digest('hex');
    const mail = await deliver([first, second]);
    const failing: AttachmentStagingStore = { get: staging.get.bind(staging), remove: staging.remove.bind(staging), put: async (id, sha256, bytes) => {
      if (sha256 === secondDigest) throw Object.assign(new Error('Synthetic filesystem I/O failure'), { code: 'EIO' });
      await staging.put(id, sha256, bytes);
    } };
    for (let attempt = 0; attempt < 5; attempt++) {
      await pool.query("UPDATE attachment_extraction_jobs SET available_at=now() WHERE status='pending'");
      expect(await runOneAttachmentExtractionJob(pool, raw, failing, budget)).toBe(true);
    }
    expect((await pool.query('SELECT status,attempts,last_error_code FROM attachment_extraction_jobs')).rows[0])
      .toEqual({ status: 'failed', attempts: 5, last_error_code: 'attachment_staging_io_unavailable' });
    const alreadyStaged = (await claimAttachmentUpload(pool))!; await ready(alreadyStaged);
    const before = (await listAttachments(pool, mail.id)).items.map(item => item.id);
    const proof = (await pool.query('SELECT extractor_version,options_sha256,manifest_sha256,manifest FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows[0];
    const capacity = (await pool.query('SELECT * FROM attachment_capacity')).rows;
    const request = { deliveryId: mail.id, expectedManifestSha256: proof.manifest_sha256 as string, expectedAttempts: 5, expectedFailureAt: await failureAt(mail.id), operatorLabel: 'local-maintenance-fixture' };
    expect(await retryFailedAttachmentStaging(pool, { ...request, expectedAttempts: 6 })).toBeNull();
    expect(await retryFailedAttachmentStaging(pool, { ...request, expectedManifestSha256: '0'.repeat(64) })).toBeNull();
    expect(await scheduleAttachmentBackfill(pool)).toBe(0);
    const results = await Promise.all([retryFailedAttachmentStaging(pool, request), retryFailedAttachmentStaging(pool, request)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ deliveryId: mail.id, manifestSha256: proof.manifest_sha256, previousAttempts: 5, operatorLabel: request.operatorLabel });
    expect((await getAttachment(pool, mail.id, alreadyStaged.attachmentId))?.state).toBe('ready');
    expect((await pool.query('SELECT status,attempts FROM attachment_extraction_jobs')).rows[0]).toEqual({ status: 'pending', attempts: 0 });
    // A later exhausted cycle has the same count and manifest but must not accept the old operator request.
    for (let attempt = 0; attempt < 5; attempt++) {
      await pool.query("UPDATE attachment_extraction_jobs SET available_at=now() WHERE status='pending'");
      await runOneAttachmentExtractionJob(pool, raw, failing, budget);
    }
    const newerFailureAt = await failureAt(mail.id);
    expect(newerFailureAt).not.toBe(request.expectedFailureAt);
    expect(await retryFailedAttachmentStaging(pool, request)).toBeNull();
    expect(await retryFailedAttachmentStaging(pool, { ...request, expectedFailureAt: newerFailureAt })).not.toBeNull();
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const upload = (await claimAttachmentUpload(pool))!; await ready(upload);
    const after = await listAttachments(pool, mail.id);
    expect(after.status).toBe('complete'); expect(after.items.map(item => item.state)).toEqual(['ready', 'ready']);
    expect(after.items.map(item => item.id)).toEqual(before);
    expect((await pool.query('SELECT extractor_version,options_sha256,manifest_sha256,manifest FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows[0]).toEqual(proof);
    expect((await pool.query('SELECT * FROM attachment_capacity')).rows).toEqual(capacity);
    expect(await raw.get(mail.ack.sha256)).toEqual(mail.bytes);
    expect(await retryFailedAttachmentStaging(pool, request)).toBeNull();
  });

  it('refuses operator retry for drift, corruption, raw/parser failures and active extraction leases', async () => {
    const mail = await deliver();
    const failing: AttachmentStagingStore = { get: staging.get.bind(staging), remove: staging.remove.bind(staging), put: async () => {
      throw Object.assign(new Error('Synthetic filesystem permission failure'), { code: 'EACCES' });
    } };
    for (let attempt = 0; attempt < 5; attempt++) {
      await pool.query("UPDATE attachment_extraction_jobs SET available_at=now() WHERE status='pending'");
      await runOneAttachmentExtractionJob(pool, raw, failing, budget);
    }
    const proof = (await pool.query('SELECT manifest_sha256 FROM attachment_inventories WHERE delivery_id=$1', [mail.id])).rows[0];
    const request = { deliveryId: mail.id, expectedManifestSha256: proof.manifest_sha256 as string, expectedAttempts: 5, expectedFailureAt: await failureAt(mail.id), operatorLabel: 'local-maintenance-fixture' };
    for (const code of ['attachment_inventory_drift', 'attachment_digest_mismatch', 'attachment_storage_unavailable', 'attachment_mime_parse_failed', 'attachment_resource_limit']) {
      await pool.query('UPDATE attachment_extraction_jobs SET last_error_code=$1', [code]);
      await pool.query('UPDATE attachment_inventories SET status=$1,error_code=$2', [code === 'attachment_inventory_drift' ? 'drift' : 'unavailable', code]);
      expect(await retryFailedAttachmentStaging(pool, request)).toBeNull();
    }
    await pool.query("UPDATE attachment_inventories SET status='unavailable',error_code='attachment_staging_io_unavailable'");
    await pool.query("UPDATE attachment_extraction_jobs SET status='inflight',lease_id=$1,lease_until=now()+interval '1 minute',last_error_code='attachment_staging_io_unavailable'", [randomUUID()]);
    expect(await retryFailedAttachmentStaging(pool, request)).toBeNull();
    expect((await pool.query('SELECT status,attempts FROM attachment_extraction_jobs')).rows[0]).toEqual({ status: 'inflight', attempts: 5 });
  });

  it('serializes concurrent physical reservations and pauses extraction without losing accepted mail', async () => {
    const part = Buffer.from('12345678'), first = await deliver([part]), second = await deliver([part]);
    const limits = { stageMaxBytes: part.length, storageMaxBytes: part.length };
    await Promise.all([runOneAttachmentExtractionJob(pool, raw, staging, limits), runOneAttachmentExtractionJob(pool, raw, staging, limits)]);
    expect((await pool.query('SELECT status FROM attachment_extraction_jobs ORDER BY status')).rows).toEqual([{ status: 'done' }, { status: 'waiting_budget' }]);
    expect((await pool.query('SELECT staging_bytes,storage_bytes FROM attachment_capacity')).rows[0]).toEqual({ staging_bytes: '8', storage_bytes: '8' });
    expect(await raw.get(first.ack.sha256)).toEqual(first.bytes); expect(await raw.get(second.ack.sha256)).toEqual(second.bytes);
    await pool.query('UPDATE attachment_extraction_jobs SET available_at=now()');
    await runOneAttachmentExtractionJob(pool, raw, staging, { stageMaxBytes: 16, storageMaxBytes: 16 });
    expect((await pool.query("SELECT count(*) FROM attachment_extraction_jobs WHERE status='done'")).rows[0].count).toBe('2');
  });


  it('pauses on real filesystem headroom and resumes without duplicating its committed reservations', async () => {
    const mail = await deliver();
    const pressured = new FileAttachmentStagingStore(join(directory, 'stage'), { minimumFreeBytes: Number.MAX_SAFE_INTEGER });
    await runOneAttachmentExtractionJob(pool, raw, pressured, budget);
    expect((await pool.query('SELECT status,attempts,last_error_code FROM attachment_extraction_jobs')).rows[0])
      .toEqual({ status: 'waiting_budget', attempts: 0, last_error_code: 'attachment_staging_disk_pressure' });
    expect((await listAttachments(pool, mail.id)).status).toBe('pending');
    const before = (await listAttachments(pool, mail.id)).items[0]!, capacity = (await pool.query('SELECT * FROM attachment_capacity')).rows;
    await pool.query('UPDATE attachment_extraction_jobs SET available_at=now()');
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect((await listAttachments(pool, mail.id)).items[0]).toMatchObject({ id: before.id, state: 'queued' });
    expect((await pool.query('SELECT * FROM attachment_capacity')).rows).toEqual(capacity);
  });

  it('repairs missing queued bytes from the same manifest, preserves active leases, and never allocates replacement IDs', async () => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const task = (await claimAttachmentUpload(pool))!, capacity = (await pool.query('SELECT * FROM attachment_capacity')).rows;
    await staging.remove(task.attachmentId, task.sha256);
    await pool.query("UPDATE attachment_extraction_jobs SET status='inflight',lease_id=$1,lease_until=now()+interval '60 seconds'", [randomUUID()]);
    expect(await repairMissingAttachmentStaging(pool, task)).toBe(false);
    expect((await getAttachment(pool, mail.id, task.attachmentId))?.state).toBe('queued');
    await pool.query("UPDATE attachment_extraction_jobs SET status='done',lease_id=NULL,lease_until=NULL");
    expect(await repairMissingAttachmentStaging(pool, task)).toBe(true);
    expect(await retryAttachmentUpload(pool, task, 'attachment_staging_missing')).toBe(true);
    expect((await getAttachment(pool, mail.id, task.attachmentId))?.state).toBe('staging');
    await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect(await staging.get(task.attachmentId, task.sha256)).toHaveLength(task.sizeBytes);
    expect((await getAttachment(pool, mail.id, task.attachmentId))?.state).toBe('queued');
    expect((await pool.query('SELECT * FROM attachment_capacity')).rows).toEqual(capacity);
    expect((await pool.query('SELECT count(*) FROM attachment_objects')).rows[0].count).toBe('1');
  });

  it('retains original correspondence but exposes only a bounded safe download basename', async () => {
    const mail = await deliver();
    const original = '../folder/' + 'a'.repeat(1500) + '\r\nInjected';
    await runOneAttachmentExtractionJob(pool, raw, staging, budget, { extract: async bytes => { const value = await extractAttachmentsIsolated(bytes); value.parts[0]!.filename = original; return value; } });
    const item = (await listAttachments(pool, mail.id)).items[0]!;
    expect(Buffer.byteLength(item.filename)).toBeLessThanOrEqual(240);
    expect(item.filename).not.toMatch(/[\r\n\\/]/);
    expect((await pool.query('SELECT filename FROM message_attachments')).rows[0].filename).toBe(original);
  });

  it('requires a matching remote receipt and fences stale upload leases before releasing staging capacity', async () => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const task = (await claimAttachmentUpload(pool))!;
    await expect(completeAttachmentUpload(pool, task, { objectKey: task.objectKey, sha256: '0'.repeat(64), sizeBytes: task.sizeBytes })).rejects.toThrow('attachment_upload_receipt_mismatch');
    await pool.query("UPDATE attachment_upload_jobs SET lease_until=now()-interval '1 second'");
    const replacement = (await claimAttachmentUpload(pool))!;
    expect(await completeAttachmentUpload(pool, task, task)).toBe(false);
    await ready(replacement);
    const unavailableCleanup: AttachmentStagingStore = { put: staging.put.bind(staging), get: staging.get.bind(staging), remove: async () => { throw new Error('fixture cleanup outage'); } };
    await expect(cleanupReadyAttachmentStaging(pool, unavailableCleanup)).rejects.toThrow('fixture cleanup outage');
    expect(await getAttachment(pool, mail.id, task.attachmentId)).toMatchObject({ state: 'ready' });
    expect(Number((await pool.query('SELECT staging_bytes FROM attachment_capacity')).rows[0].staging_bytes)).toBe(task.sizeBytes);
    expect(await cleanupReadyAttachmentStaging(pool, staging)).toBe(1);
    expect(await cleanupReadyAttachmentStaging(pool, staging)).toBe(0);
    expect((await pool.query('SELECT staging_bytes,storage_bytes FROM attachment_capacity')).rows[0]).toEqual({ staging_bytes: '0', storage_bytes: String(task.sizeBytes) });
    await expect(staging.get(task.attachmentId, task.sha256)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await raw.get(mail.ack.sha256)).toEqual(mail.bytes);
  });

  it('surfaces blocked upload state while retries preserve object identity and queued bytes', async () => {
    const mail = await deliver(); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const task = (await claimAttachmentUpload(pool))!;
    expect(await retryAttachmentUpload(pool, task, 'remote_temporarily_unavailable')).toBe(true);
    await pool.query('UPDATE attachment_upload_jobs SET available_at=now()');
    const retry = (await claimAttachmentUpload(pool))!;
    expect(retry.attachmentId).toBe(task.attachmentId); expect(retry.attempts).toBe(2);
    expect(await retryAttachmentUpload(pool, retry, 'immutable_remote_conflict', { blocked: true })).toBe(true);
    expect((await listAttachments(pool, mail.id)).items[0]!.state).toBe('failed');
    expect(await claimAttachmentUpload(pool)).toBeNull();
    expect(await staging.get(task.attachmentId, task.sha256)).toHaveLength(task.sizeBytes);
  });

  it('publishes no partial inventory on MIME limits and bounded backfill moves past failed current-version jobs', async () => {
    const bad = await deliver(Array.from({ length: 101 }, () => Buffer.from('x')), false), good = await deliver([], false);
    await pool.query("UPDATE deliveries SET stored_at='2026-01-01' WHERE id=$1", [bad.id]);
    expect(await scheduleAttachmentBackfill(pool, { limit: 1 })).toBe(1); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect(await listAttachments(pool, bad.id)).toEqual({ status: 'unavailable', errorCode: 'attachment_count_limit', items: [] });
    expect(await scheduleAttachmentBackfill(pool, { limit: 1 })).toBe(1); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    expect(await listAttachments(pool, good.id)).toEqual({ status: 'complete', errorCode: null, items: [] });
    expect(await scheduleAttachmentBackfill(pool, { limit: 1 })).toBe(0);
    expect((await pool.query('SELECT count(*) FROM attachment_objects')).rows[0].count).toBe('0');
  });

  it('denies deleted/wrong-message/disabled-mailbox reads without deleting retained remote objects', async () => {
    const first = await deliver(), second = await deliver([]); await runOneAttachmentExtractionJob(pool, raw, staging, budget); await runOneAttachmentExtractionJob(pool, raw, staging, budget);
    const task = (await claimAttachmentUpload(pool))!; await ready(task);
    expect(await getAttachment(pool, second.id, task.attachmentId)).toBeNull();
    await pool.query('UPDATE mailboxes SET enabled=false WHERE id=$1', [mailboxId]);
    expect(await getAttachment(pool, first.id, task.attachmentId)).toBeNull();
    await pool.query('UPDATE mailboxes SET enabled=true WHERE id=$1', [mailboxId]);
    await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1', [first.id]);
    expect(await getAttachment(pool, first.id, task.attachmentId)).toBeNull();
    expect((await listAttachments(pool, first.id)).items).toEqual([]);
    expect((await pool.query('SELECT state FROM attachment_objects')).rows[0].state).toBe('ready');
  });
});
