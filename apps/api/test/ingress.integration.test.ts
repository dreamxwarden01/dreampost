import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHeaders, INGEST_PATH, MAX_INBOUND_BYTES, sha256Hex, type DeliveryMetadata } from '@dreampost/protocol';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { FileBlobStore, type RawBlobStore } from '../src/blob-store.js';
import { migrate, seedMailbox } from '../src/database.js';
import { runOneParseJob } from '../src/parser.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const mailboxId = '11111111-1111-4111-8111-111111111111';
const otherMailboxId = '22222222-2222-4222-8222-222222222222';
const token = 'development-test-view-token-32-characters';
const key = { id: 'test-key', secret: 'test-ingestion-secret-at-least-32-bytes' };
const raw = Buffer.from('From: Sender <sender@example.test>\r\nTo: reader@example.test\r\nSubject: Original\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA real message.\r\n');

function metadata(body = raw, overrides: Partial<DeliveryMetadata> = {}): DeliveryMetadata {
  return {
    version: 1, deliveryId: randomUUID(), mailboxId, envelopeFrom: 'sender@example.test',
    envelopeTo: 'reader@example.test', receivedAt: '2026-09-25T12:00:00.000Z', rawSize: body.length, ...overrides,
  };
}

// Opt in explicitly: each run creates and drops its own schema, never shared tables.
describe.skipIf(!databaseUrl)('inbound API with real PostgreSQL', () => {
  const schema = `dreampost_test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let directory: string;
  let config: ApiConfig;
  let app: ReturnType<typeof buildApp>;
  let store: FileBlobStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await migrate(pool);
    await migrate(pool);
  });

  beforeEach(async () => {
    if (app) await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    await pool.query('TRUNCATE TABLE mailboxes, principals CASCADE');
    await seedMailbox(pool, { id: mailboxId, address: 'reader@example.test', name: 'Development inbox' });
    await seedMailbox(pool, { id: otherMailboxId, address: 'other@example.test', name: 'Other inbox' });
    directory = await mkdtemp(join(tmpdir(), 'dreampost-api-'));
    config = {
      databaseUrl: databaseUrl!, mailStorePath: directory, ingestKeys: { [key.id]: key.secret },
      devViewToken: token, devMailboxId: mailboxId, host: '127.0.0.1', port: 3001,
      publicBaseUrl: 'http://localhost:3001',
    };
    store = new FileBlobStore(directory);
    app = buildApp(config, pool, { blobs: store });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function push(body = raw, meta = metadata(body)) {
    const headers = await createDeliveryHeaders(meta, body, key);
    return app.inject({ method: 'POST', url: INGEST_PATH, headers, payload: body });
  }
  const readHeaders = () => ({ authorization: `Bearer ${token}` });

  it('acknowledges exact bytes only after a delivery, parse job, and ordered change commit', async () => {
    const meta = metadata();
    const response = await push(raw, meta);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1, deliveryId: meta.deliveryId, sha256: await sha256Hex(raw), status: 'stored' });
    expect(await store.get(response.json().sha256)).toEqual(raw);
    expect((await pool.query('SELECT parse_status FROM deliveries')).rows).toEqual([{ parse_status: 'pending' }]);
    expect((await pool.query('SELECT kind, status FROM durable_jobs')).rows).toEqual([{ kind: 'parse', status: 'pending' }]);
    expect((await pool.query('SELECT sequence, kind FROM mailbox_changes')).rows).toEqual([{ sequence: '1', kind: 'message.received' }]);
  });

  it('returns identical acknowledgments across simultaneous attempts and after an API restart', async () => {
    const meta = metadata();
    const responses = await Promise.all(Array.from({ length: 5 }, () => push(raw, meta)));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => response.body === responses[0]!.body)).toBe(true);
    await app.close();
    app = buildApp(config, pool, { blobs: new FileBlobStore(directory) });
    expect((await push(raw, meta)).body).toBe(responses[0]!.body);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('1');
    expect((await pool.query('SELECT count(*) AS count FROM durable_jobs')).rows[0].count).toBe('1');
    expect((await pool.query('SELECT change_sequence FROM mailboxes WHERE id = $1', [mailboxId])).rows[0].change_sequence).toBe('1');
  });

  it('rejects a reused delivery ID with different bytes or routing', async () => {
    const meta = metadata();
    expect((await push(raw, meta)).statusCode).toBe(200);
    const different = Buffer.from(raw.toString().replace('A real message.', 'A fake message.'));
    expect((await push(different, { ...meta, rawSize: different.length })).statusCode).toBe(409);
    expect((await push(raw, { ...meta, mailboxId: otherMailboxId, envelopeTo: 'other@example.test' })).statusCode).toBe(409);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('1');
  });

  it('rejects unauthorized headers before body parsing and rejects stale signatures', async () => {
    const unauthenticated = await app.inject({ method: 'POST', url: INGEST_PATH,
      headers: { 'content-type': 'invalid/type', 'content-length': String(MAX_INBOUND_BYTES + 1) }, payload: 'x' });
    expect(unauthenticated.statusCode).toBe(401);
    const headers = await createDeliveryHeaders(metadata(), raw, key, { nowMs: Date.now() - 600_000 });
    expect((await app.inject({ method: 'POST', url: INGEST_PATH, headers, payload: raw })).statusCode).toBe(401);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
  });

  it('rejects signed metadata with modified body bytes before persistence', async () => {
    const headers = await createDeliveryHeaders(metadata(), raw, key);
    const modified = Buffer.from(raw);
    modified[modified.length - 3] = 88;
    expect((await app.inject({ method: 'POST', url: INGEST_PATH, headers, payload: modified })).statusCode).toBe(400);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
  });

  it('never creates a mailbox or route from incoming metadata', async () => {
    expect((await push(raw, metadata(raw, { envelopeTo: 'unknown@example.test' }))).statusCode).toBe(422);
    expect((await push(raw, metadata(raw, { mailboxId: randomUUID() }))).statusCode).toBe(422);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) AS count FROM mailboxes')).rows[0].count).toBe('2');
  });

  it('matches recipient case insensitively but preserves original immutable envelope metadata', async () => {
    const meta = metadata(raw, { envelopeTo: 'Reader@EXAMPLE.TEST' });
    expect((await push(raw, meta)).statusCode).toBe(200);
    const stored = (await pool.query('SELECT metadata FROM deliveries WHERE id = $1', [meta.deliveryId])).rows[0];
    expect(stored.metadata.envelopeTo).toBe('Reader@EXAMPLE.TEST');
    expect((await push(raw, { ...meta, envelopeTo: 'reader@example.test' })).statusCode).toBe(409);
    expect((await push(raw, meta)).statusCode).toBe(200);
  });

  it('normalizes explicit seed addresses and rejects routes that differ only in case', async () => {
    const mixedId = randomUUID();
    await seedMailbox(pool, { id: mixedId, address: 'New.Reader@EXAMPLE.TEST', name: 'Mixed case' });
    expect((await pool.query('SELECT address FROM mailboxes WHERE id = $1', [mixedId])).rows[0].address).toBe('new.reader@example.test');
    await expect(pool.query('INSERT INTO recipient_routes (address, mailbox_id) VALUES ($1, $2)',
      ['READER@EXAMPLE.TEST', otherMailboxId])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query('INSERT INTO mailboxes (id, address, name) VALUES ($1, $2, $3)',
      [randomUUID(), 'READER@EXAMPLE.TEST', 'Ambiguous mailbox'])).rejects.toMatchObject({ code: '23505' });
  });

  it('holds no mailbox/route lock during blob persistence and rechecks revoked routing afterward', async () => {
    let reachedWrite!: () => void;
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => { reachedWrite = resolve; });
    const resume = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const pausedStore: RawBlobStore = {
      get: (digest) => store.get(digest),
      put: async (digest, bytes) => { reachedWrite(); await resume; await store.put(digest, bytes); },
    };
    await app.close();
    app = buildApp(config, pool, { blobs: pausedStore });
    const pending = push();
    await writing;
    const updater = await pool.connect();
    let response: Awaited<ReturnType<typeof push>>;
    try {
      await updater.query('BEGIN');
      await updater.query("SET LOCAL lock_timeout = '500ms'");
      await updater.query('UPDATE mailboxes SET name = $2 WHERE id = $1', [mailboxId, 'Updated while writing']);
      await updater.query('UPDATE recipient_routes SET enabled = false WHERE mailbox_id = $1', [mailboxId]);
      await updater.query('COMMIT');
    } catch (error) {
      await updater.query('ROLLBACK');
      throw error;
    } finally {
      updater.release();
      releaseWrite();
      response = await pending;
    }
    expect(response.statusCode).toBe(422);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) AS count FROM durable_jobs')).rows[0].count).toBe('0');
    expect(await store.get(await sha256Hex(raw))).toEqual(raw);
  });

  it('allows a second message to commit while the first is still writing its blob', async () => {
    const firstMeta = metadata();
    const secondMeta = metadata();
    let first = true;
    let reachedWrite!: () => void;
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => { reachedWrite = resolve; });
    const resume = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const pausedStore: RawBlobStore = {
      get: (digest) => store.get(digest),
      put: async (digest, bytes) => {
        if (first) { first = false; reachedWrite(); await resume; }
        await store.put(digest, bytes);
      },
    };
    await app.close();
    app = buildApp(config, pool, { blobs: pausedStore });
    const firstPending = push(raw, firstMeta);
    await writing;
    const lockBoundPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c lock_timeout=500`, connectionTimeoutMillis: 5000 });
    const secondApp = buildApp(config, lockBoundPool, { blobs: store });
    try {
      const response = await secondApp.inject({ method: 'POST', url: INGEST_PATH,
        headers: await createDeliveryHeaders(secondMeta, raw, key), payload: raw });
      expect(response.statusCode).toBe(200);
      expect((await pool.query('SELECT delivery_id, sequence FROM mailbox_changes')).rows).toEqual([{ delivery_id: secondMeta.deliveryId, sequence: '1' }]);
    } finally {
      await secondApp.close();
      await lockBoundPool.end();
      releaseWrite();
      expect((await firstPending).statusCode).toBe(200);
    }
    expect((await pool.query('SELECT delivery_id, sequence FROM mailbox_changes ORDER BY sequence')).rows).toEqual([
      { delivery_id: secondMeta.deliveryId, sequence: '1' }, { delivery_id: firstMeta.deliveryId, sequence: '2' },
    ]);
  });

  it('preserves duplicate acknowledgment after the original recipient route is disabled', async () => {
    const meta = metadata();
    const first = await push(raw, meta);
    await pool.query('UPDATE recipient_routes SET enabled = false WHERE mailbox_id = $1', [mailboxId]);
    expect((await push(raw, meta)).body).toBe(first.body);
    expect((await push()).statusCode).toBe(422);
  });

  it('returns no success or database records when filesystem persistence fails', async () => {
    await app.close();
    const blocker = join(directory, 'blocked');
    await writeFile(blocker, 'not a directory');
    app = buildApp({ ...config, mailStorePath: join(blocker, 'mail') }, pool);
    expect((await push()).statusCode).toBe(503);
    expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) AS count FROM durable_jobs')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) AS count FROM mailbox_changes')).rows[0].count).toBe('0');
  });

  it('rolls back a delivery if its durable job cannot commit, then accepts a retry', async () => {
    const meta = metadata();
    await pool.query("ALTER TABLE durable_jobs ADD CONSTRAINT test_reject_job CHECK (kind <> 'parse')");
    try {
      expect((await push(raw, meta)).statusCode).toBe(503);
      expect((await pool.query('SELECT count(*) AS count FROM deliveries')).rows[0].count).toBe('0');
      expect((await pool.query('SELECT count(*) AS count FROM mailbox_changes')).rows[0].count).toBe('0');
    } finally { await pool.query('ALTER TABLE durable_jobs DROP CONSTRAINT test_reject_job'); }
    expect((await push(raw, meta)).statusCode).toBe(200);
  });

  it('parses MIME in the separate durable worker and returns decoded plaintext without HTML', async () => {
    const subject = '\u4e2d\u6587 subject';
    const body = Buffer.from('From: Sender <sender@example.test>\r\nTo: reader@example.test\r\n' +
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
      'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="test"\r\n\r\n' +
      '--test\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from('Hello \u4e16\u754c!').toString('base64') + '\r\n' +
      '--test\r\nContent-Type: text/html\r\n\r\n<script>bad()</script><p>Hello</p>\r\n--test--\r\n');
    const meta = metadata(body);
    await push(body, meta);
    expect(await runOneParseJob(pool, store)).toBe(true);
    expect(await runOneParseJob(pool, store)).toBe(false);
    const response = await app.inject({ url: `/api/mailboxes/${mailboxId}/messages/${meta.deliveryId}`, headers: readHeaders() });
    expect(response.statusCode).toBe(200);
    const message = response.json().message;
    expect(message.subject).toBe(subject);
    expect(message.text.trim()).toBe('Hello \u4e16\u754c!');
    expect(message.status).toBe('parsed');
    expect(message.html).toBeUndefined();
    expect((await pool.query('SELECT sequence FROM mailbox_changes ORDER BY sequence')).rows).toEqual([{ sequence: '1' }, { sequence: '2' }]);
    const download = await app.inject({ url: `/api/mailboxes/${mailboxId}/messages/${meta.deliveryId}/raw`, headers: readHeaders() });
    expect(download.rawPayload).toEqual(body);
    expect(download.headers['content-disposition']).toContain('attachment');
  });

  it('persists parser failures and allows later retry without losing the raw message', async () => {
    const meta = metadata();
    await push(raw, meta);
    const failingStore: RawBlobStore = { put: async () => {}, get: async () => { throw new Error('simulated storage outage'); } };
    expect(await runOneParseJob(pool, failingStore)).toBe(true);
    const job = (await pool.query('SELECT status, attempts, last_error_code FROM durable_jobs')).rows[0];
    expect(job).toEqual({ status: 'pending', attempts: 1, last_error_code: 'raw_read_or_parse_failed' });
    expect(await store.get(await sha256Hex(raw))).toEqual(raw);
    await pool.query('UPDATE durable_jobs SET available_at = now()');
    expect(await runOneParseJob(pool, store)).toBe(true);
    expect((await pool.query('SELECT status FROM durable_jobs')).rows[0].status).toBe('done');
  });

  it('stops retrying unreadable MIME after five failures while preserving its durable receipt', async () => {
    const meta = metadata();
    await push(raw, meta);
    const failingStore: RawBlobStore = { put: async () => {}, get: async () => { throw new Error('unreadable'); } };
    for (let attempt = 0; attempt < 5; attempt++) {
      await pool.query('UPDATE durable_jobs SET available_at = now()');
      expect(await runOneParseJob(pool, failingStore)).toBe(true);
    }
    expect(await runOneParseJob(pool, failingStore)).toBe(false);
    expect((await pool.query('SELECT status, attempts FROM durable_jobs')).rows[0]).toEqual({ status: 'failed', attempts: 5 });
    expect((await pool.query('SELECT parse_status FROM deliveries')).rows[0].parse_status).toBe('failed');
    expect(await store.get(await sha256Hex(raw))).toEqual(raw);
    expect((await push(raw, meta)).statusCode).toBe(200);
  });

  it('serializes new mailbox changes behind an uncommitted earlier writer', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('UPDATE mailboxes SET change_sequence = change_sequence + 1 WHERE id = $1', [mailboxId]);
    const pending = push();
    try {
      expect((await pool.query('SELECT change_sequence FROM mailboxes WHERE id = $1', [mailboxId])).rows[0].change_sequence).toBe('0');
      expect((await pool.query('SELECT count(*) AS count FROM mailbox_changes')).rows[0].count).toBe('0');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await pending).statusCode).toBe(200);
    expect((await pool.query('SELECT sequence FROM mailbox_changes')).rows).toEqual([{ sequence: '1' }]);
  });

  it('requires a development token and fixed-mailbox authorization before reading a blob', async () => {
    const meta = metadata(raw, { mailboxId: otherMailboxId, envelopeTo: 'other@example.test' });
    await push(raw, meta);
    let blobReads = 0;
    const guardedStore: RawBlobStore = { put: async () => {}, get: async () => { blobReads++; throw new Error('must not read'); } };
    await app.close();
    app = buildApp(config, pool, { blobs: guardedStore });
    expect((await app.inject({ url: '/api/mailboxes' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/mailboxes', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const allowed = await app.inject({ url: '/api/mailboxes', headers: readHeaders() });
    expect(allowed.json().mailboxes).toEqual([{ id: mailboxId, address: 'reader@example.test', name: 'Development inbox' }]);
    expect(allowed.headers['cache-control']).toBe('no-store');
    for (const id of [otherMailboxId, mailboxId]) {
      const response = await app.inject({ url: `/api/mailboxes/${id}/messages/${meta.deliveryId}/raw`, headers: readHeaders() });
      expect(response.statusCode).toBe(404);
    }
    expect(blobReads).toBe(0);
  });
});
