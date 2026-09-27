import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHeaders, verifyDeliveryHeaders, type DeliveryMetadata } from '@dreampost/protocol';
import { migrate, seedMailbox } from '../src/database.js';
import { FileBlobStore } from '../src/blob-store.js';
import { ingest } from '../src/ingestion.js';
import { runOneParseJob } from '../src/parser.js';
import { getReaderData, readerSummary, READER_PARSER_VERSION, scheduleReaderReparse } from '../src/reader-data.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const key = { id: 'reader-test', secret: 'reader-fixture-ingestion-secret-at-least-32-bytes' };
const raw = Buffer.from('From: Sender <sender@example.test>\r\nTo: reader@example.test\r\nReply-To: reply@example.test\r\nCc: copy@example.test\r\nSubject: Actual HTML\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello</p><script>untrusted()</script>');

describe.skipIf(!databaseUrl)('reader data and safe legacy reparsing', () => {
  const schema = `reader_data_${randomUUID().replaceAll('-', '')}`;
  const mailboxId = randomUUID();
  let admin: pg.Pool;
  let pool: pg.Pool;
  let directory: string;
  let blobs: FileBlobStore;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    directory = await mkdtemp(join(tmpdir(), 'dreampost-reader-'));
    blobs = new FileBlobStore(directory);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE mailboxes,principals CASCADE');
    await seedMailbox(pool, { id: mailboxId, address: 'reader@example.test', name: 'Reader fixture' });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  async function deliver(message = raw) {
    const metadata: DeliveryMetadata = { version: 1, deliveryId: randomUUID(), mailboxId, envelopeFrom: 'bounce@example.test', envelopeTo: 'reader@example.test', receivedAt: '2026-09-26T10:11:12.000Z', rawSize: message.length };
    const verified = await verifyDeliveryHeaders(await createDeliveryHeaders(metadata, message, key), { [key.id]: key.secret });
    return { metadata, ack: await ingest(pool, blobs, verified, message) };
  }

  it('stores internal HTML and parsed reader headers atomically without changing raw receipt bytes or ownership', async () => {
    const { metadata, ack } = await deliver();
    expect(await runOneParseJob(pool, blobs)).toBe(true);
    const data = await getReaderData(pool, metadata.deliveryId);
    expect(data?.headers.replyTo).toBe('reply@example.test');
    expect(data?.headers.cc).toBe('copy@example.test');
    expect(data?.htmlSource).toContain('<script>untrusted()</script>');
    expect(readerSummary(data, metadata)).toMatchObject({ hasHtml: true, envelopeFrom: 'bounce@example.test', envelopeTo: 'reader@example.test' });
    expect(await blobs.get(ack.sha256)).toEqual(raw);
    expect((await pool.query('SELECT mailbox_id,sha256,parse_status FROM deliveries')).rows).toEqual([{ mailbox_id: mailboxId, sha256: ack.sha256, parse_status: 'parsed' }]);
    expect((await pool.query('SELECT status FROM durable_jobs')).rows).toEqual([{ status: 'done' }]);
  });

  it('requeues old completed jobs without clearing previous reader data and preserves it through a failed attempt', async () => {
    const { metadata, ack } = await deliver();
    await pool.query("UPDATE deliveries SET parse_status = 'parsed',plain_text = 'Legacy cached text'");
    await pool.query("UPDATE durable_jobs SET status = 'done',attempts = 3,completed_at = now()");
    expect(await scheduleReaderReparse(pool)).toBe(1);
    expect(await scheduleReaderReparse(pool)).toBe(0);
    expect((await pool.query('SELECT plain_text FROM deliveries')).rows[0].plain_text).toBe('Legacy cached text');
    const failing = { put: blobs.put.bind(blobs), get: async () => { throw new Error('Test storage outage'); } };
    expect(await runOneParseJob(pool, failing)).toBe(true);
    expect((await pool.query('SELECT plain_text FROM deliveries')).rows[0].plain_text).toBe('Legacy cached text');
    await pool.query('UPDATE durable_jobs SET available_at = now()');
    expect(await runOneParseJob(pool, blobs)).toBe(true);
    expect((await getReaderData(pool, metadata.deliveryId))?.htmlSource).toContain('<p>Hello</p>');
    expect(await scheduleReaderReparse(pool)).toBe(0);
    expect((await pool.query('SELECT count(*) FROM deliveries')).rows[0].count).toBe('1');
    expect((await pool.query('SELECT count(*) FROM durable_jobs')).rows[0].count).toBe('1');
    expect(await blobs.get(ack.sha256)).toEqual(raw);
  });


  it('advances bounded backfill past permanent failures without resetting their current-version retry budgets', async () => {
    const failures = new Set<string>();
    const reads = new Map<string, number>();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const { metadata, ack } = await deliver(Buffer.concat([raw, Buffer.from(`\n<!-- Backfill fixture ${index} -->`)]));
      ids.push(metadata.deliveryId);
      if (index < 3) failures.add(ack.sha256);
      await pool.query("UPDATE deliveries SET stored_at = '2026-09-01T00:00:00Z'::timestamptz + make_interval(secs => $2) WHERE id = $1", [metadata.deliveryId, index]);
    }
    await pool.query("UPDATE durable_jobs SET status = 'failed',attempts = 5,last_error_code = 'legacy_failure'");
    const store = { put: blobs.put.bind(blobs), get: async (digest: string) => {
      reads.set(digest, (reads.get(digest) ?? 0) + 1);
      if (failures.has(digest)) throw new Error('Permanent fixture read failure');
      return blobs.get(digest);
    } };
    async function drainBatch() {
      for (let count = 0; count < 20; count++) {
        await pool.query("UPDATE durable_jobs SET available_at = now() WHERE status = 'pending'");
        if (!await runOneParseJob(pool, store)) return;
      }
      throw new Error('Backfill did not finish within the bounded fixture');
    }
    expect(await scheduleReaderReparse(pool, { limit: 2 })).toBe(2);
    expect((await pool.query('SELECT DISTINCT parser_version_attempted FROM durable_jobs')).rows).toEqual([{ parser_version_attempted: 0 }]);
    await drainBatch();
    expect((await pool.query("SELECT count(*) FROM durable_jobs WHERE status = 'failed' AND parser_version_attempted = $1", [READER_PARSER_VERSION])).rows[0].count).toBe('2');
    expect(await scheduleReaderReparse(pool, { limit: 2 })).toBe(2);
    await drainBatch();
    expect(await scheduleReaderReparse(pool, { limit: 2 })).toBe(0);
    expect(await scheduleReaderReparse(pool, { limit: 2 })).toBe(0);
    expect((await pool.query('SELECT status,attempts,parser_version_attempted FROM durable_jobs ORDER BY delivery_id')).rows)
      .toEqual(expect.arrayContaining([
        { status: 'done', attempts: 1, parser_version_attempted: READER_PARSER_VERSION },
        ...Array.from({ length: 3 }, () => ({ status: 'failed', attempts: 5, parser_version_attempted: READER_PARSER_VERSION })),
      ]));
    for (const digest of failures) expect(reads.get(digest)).toBe(5);
    expect(await getReaderData(pool, ids[3]!)).not.toBeNull();
    expect((await pool.query('SELECT count(*) FROM message_reader_data')).rows[0].count).toBe('1');
  });

  it('skips active parse locks and deleted messages during bounded backfill', async () => {
    await deliver();
    await pool.query("UPDATE durable_jobs SET status = 'done'");
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM durable_jobs FOR UPDATE');
      expect(await scheduleReaderReparse(pool)).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await pool.query('UPDATE deliveries SET deleted_at = now()');
    expect(await scheduleReaderReparse(pool)).toBe(0);
    await expect(scheduleReaderReparse(pool, { limit: 0 })).rejects.toThrow('between 1 and 1000');
  });
});
