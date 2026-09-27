import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { migrate, seedMailbox } from '../src/database.js';
import { createOutboundDependencies } from '../src/outbound-integration.js';
import { parseMimeIsolated, storeReaderData } from '../src/reader-data.js';
import type { AuthService } from '../src/auth/service.js';
import type { AddressService } from '../src/addresses/service.js';
import type { ApiConfig } from '../src/config.js';
import type { SentCopyInput } from '../src/outbound/types.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
describe.skipIf(!databaseUrl)('outbound immutable-source and prepared Sent integration', () => {
  const schema = `outbound_source_${randomUUID().replaceAll('-', '')}`;
  const actorId = randomUUID(), mailboxId = randomUUID(), messageId = randomUUID();
  const raw = Buffer.from('From: Sender <sender@example.test>\r\nTo: owner@example.test\r\nSubject: Immutable source\r\nMessage-ID: <immutable@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal text.\r\n');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  let admin: pg.Pool, pool: pg.Pool;
  const get = vi.fn(async (_sha: string) => raw);
  const auth = { resolvePrincipal: vi.fn(async () => ({ principalId: actorId, permissions: new Set(['mailbox.use']) })) } as unknown as AuthService;
  const config = { downloads: undefined } as ApiConfig;
  const dependencies = () => createOutboundDependencies(config, pool, auth, {} as AddressService, { get, put: async () => {} });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }); await migrate(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
  beforeEach(async () => {
    get.mockReset().mockResolvedValue(raw);
    await pool.query('TRUNCATE mailboxes,principals CASCADE');
    await seedMailbox(pool, { id: mailboxId, address: 'owner@example.test', name: 'Synthetic source mailbox' });
    await pool.query('INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled) VALUES($1,$2,$4,$3,1,true)', [actorId, 'https://sso.example.test', 'owner', actorId]);
    await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])", [mailboxId, actorId]);
    await pool.query("INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,plain_text) VALUES($1,$2,$3,$4,$5,now(),'Original text.')", [messageId, mailboxId, { envelopeTo: 'owner@example.test' }, sha256, raw.length]);
    const client = await pool.connect(); try { await storeReaderData(client, messageId, (await parseMimeIsolated(raw)).reader); } finally { client.release(); }
  });
  it('uses persisted compatible metadata across parser upgrades without parsing or reading blobs in a transaction', async () => {
    const deps = dependencies(), client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const before = await deps.loadSource(client, actorId, mailboxId, messageId); await client.query('COMMIT');
      await pool.query('UPDATE message_reader_data SET parser_version=3 WHERE delivery_id=$1', [messageId]);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const after = await deps.loadSource(client, actorId, mailboxId, messageId); await client.query('COMMIT');
      expect(after.sourceSha256).toBe(before.sourceSha256); expect(after.sourceSha256).toBe(sha256);
      expect(after.contentVersion).not.toBe(before.contentVersion); expect(after.text).toBe('Original text.');
      expect(get).not.toHaveBeenCalled();
      await pool.query('UPDATE message_reader_data SET parser_version=1 WHERE delivery_id=$1', [messageId]);
      await expect(deps.loadSource(client, actorId, mailboxId, messageId)).rejects.toMatchObject({ code: 'source_preparing' });
      expect(get).not.toHaveBeenCalled();
      await pool.query('UPDATE mailbox_memberships SET revoked_at=now() WHERE principal_id=$1', [actorId]);
      await expect(deps.loadSource(client, actorId, mailboxId, messageId)).rejects.toMatchObject({ code: 'source_not_found' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('persists exactly one Sent copy from prevalidated parsing without doing blob IO under locks', async () => {
    const deps = dependencies(), snapshot = { submissionId: randomUUID(), mailboxId, rawSha256: sha256, rawSize: raw.length,
      date: new Date().toISOString(), from: { name: '', address: 'owner@example.test' }, providerMessageId: 'synthetic-provider' } as SentCopyInput;
    const prepared = await deps.prepareSent(snapshot); expect(get).toHaveBeenCalledTimes(1);
    get.mockRejectedValue(new Error('Blob IO is forbidden in the commit transaction'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await deps.persistSent(client, snapshot, prepared)).toBe(snapshot.submissionId);
      expect(await deps.persistSent(client, snapshot, prepared)).toBe(snapshot.submissionId);
      await client.query('COMMIT');
      expect(get).toHaveBeenCalledTimes(1);
      expect((await pool.query('SELECT direction,plain_text FROM deliveries WHERE id=$1', [snapshot.submissionId])).rows[0]).toMatchObject({ direction: 'outbound', plain_text: prepared.parsed.text });
      await expect(deps.persistSent(client, snapshot, { ...prepared, rawSha256: '0'.repeat(64) })).rejects.toThrow('sent_copy_preparation_mismatch');
      get.mockResolvedValue(Buffer.from(raw.toString().replace('Original', 'Modified')));
      await expect(deps.prepareSent(snapshot)).rejects.toThrow('sent_copy_source_mismatch');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
