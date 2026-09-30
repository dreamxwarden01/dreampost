import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/database.js';
import { getOutboundRfcMessageId, indexMessageThread, linkOutboundMessageId, normalizeProviderRfcMessageId } from '../src/mail/threading.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const localId = '<local.original@example.test>';
const wireId = '<Provider.CaseSensitive@example.test>';
const token = (value: string) => value.slice(1, -1);

describe('explicit provider RFC identity validation', () => {
  it('preserves case while refusing opaque, Unicode, commented, injected and multiple identifiers', () => {
    expect(normalizeProviderRfcMessageId(wireId)).toBe(wireId);
    for (const invalid of ['opaque-tracking-id', 'bare@example.test', '<bad..left@example.test>', '<left@bad..right>',
      '<left@example.test> <other@example.test>', '<left(comment)@example.test>', '<left@\u00e9xample.test>',
      ' <left@example.test>', '<left@example.test>\r\nX-Test: injected', '<"quoted"@example.test>']) {
      expect(normalizeProviderRfcMessageId(invalid)).toBeNull();
    }
  });
});

describe.skipIf(!databaseUrl)('trusted outbound provider aliases with isolated PostgreSQL', () => {
  const schema = `provider_alias_${randomUUID().replaceAll('-', '')}`;
  const actor = randomUUID(), mailbox = randomUUID(), otherMailbox = randomUUID();
  let admin: pg.Pool, pool: pg.Pool;
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function message(options: { id?: string; box?: string; direction?: 'inbound' | 'outbound'; own?: string;
    references?: string[]; inReplyTo?: string[]; metadata?: object; trusted?: boolean; trustedState?: string; rfc?: string | null } = {}) {
    const id = options.id ?? randomUUID(), box = options.box ?? mailbox;
    return transaction(async client => {
      await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE', [box]);
      if (options.trusted) await submission(client, id, box, { rfc: options.rfc === undefined ? wireId : options.rfc, state: options.trustedState });
      await client.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,direction,parse_status)
        VALUES($1,$2,$3,$4,20,now(),$5,'parsed')`, [id,box,options.metadata ?? (options.direction === 'outbound' ? { kind: 'outbound', submissionId: id } : {}),'a'.repeat(64),options.direction ?? 'inbound']);
      const threadId = await indexMessageThread(client, { mailboxId: box, messageId: id, messageIdHeader: options.own ?? `<${id}@example.test>`, references: options.references, inReplyTo: options.inReplyTo, parserVersion: 2 });
      return { id, box, threadId };
    });
  }
  async function submission(client: PoolClient, id: string, box: string, options: { rfc?: string | null; state?: string; sha256?: string; rawSize?: number } = {}) {
    const draft = randomUUID();
    await client.query("INSERT INTO outbound_drafts(id,mailbox_id,author_principal_id,mode,state) VALUES($1,$2,$3,'new','queued')", [draft,box,actor]);
    await client.query(`INSERT INTO outbound_submissions(id,draft_id,draft_version,mailbox_id,author_principal_id,state,snapshot,
      raw_sha256,raw_size,queue_deadline,provider_message_id,rfc_message_id)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,now()+interval '1 hour','opaque-provider-tracking-value',$9)`,
    [id,draft,box,actor,options.state ?? 'accepted',{ messageIdHeader: localId, transportKey: 'cloudflare:synthetic' },options.sha256 ?? 'a'.repeat(64),options.rawSize ?? 20,options.rfc === undefined ? wireId : options.rfc]);
  }
  const link = (id: string, box = mailbox) => transaction(client => linkOutboundMessageId(client, { mailboxId: box, messageId: id }));
  const membership = async (id: string) => (await pool.query<{ thread_id: string }>('SELECT thread_id FROM mail_message_state WHERE message_id=$1', [id])).rows[0]!.thread_id;
  const keys = async (box = mailbox) => (await pool.query('SELECT token,thread_id,claim_message_id,ambiguous FROM mail_thread_keys WHERE mailbox_id=$1 ORDER BY token', [box])).rows;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE mailboxes,principals CASCADE');
    await pool.query("INSERT INTO principals(id,issuer,subject,app_role,access_enabled) VALUES($1::uuid,'synthetic',$1::text,1,true)", [actor]);
    for (const [id, address] of [[mailbox, 'primary@example.test'], [otherMailbox, 'other@example.test']]) {
      await pool.query('INSERT INTO mailboxes(id,address,name) VALUES($1,$2,$2)', [id,address]);
    }
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });

  it('indexes both raw/local and wire IDs without rewriting immutable message/header identity', async () => {
    const sent = await message({ direction: 'outbound', own: localId, trusted: true });
    const wireReply = await message({ references: [wireId] });
    const localReply = await message({ references: [localId] });
    expect([wireReply.threadId, localReply.threadId]).toEqual([sent.threadId, sent.threadId]);
    expect((await pool.query('SELECT message_id_header FROM mail_thread_headers WHERE message_id=$1', [sent.id])).rows[0].message_id_header).toBe(token(localId));
    expect((await keys()).filter(key => key.claim_message_id === sent.id).map(key => key.token).sort()).toEqual([token(localId), token(wireId)].sort());
    expect((await pool.query('SELECT sha256,raw_size FROM deliveries WHERE id=$1', [sent.id])).rows[0]).toEqual({ sha256: 'a'.repeat(64), raw_size: 20 });
  });

  it('adopts a reply-before-Sent placeholder and emits a mailbox invalidation', async () => {
    const reply = await message({ references: [wireId] });
    const sent = await message({ direction: 'outbound', own: localId, trusted: true });
    expect(sent.threadId).toBe(reply.threadId);
    const events = (await pool.query('SELECT kind,data FROM mailbox_changes WHERE delivery_id=$1', [sent.id])).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message.threaded', data: { reason: 'provider_placeholder_adopted', threadId: reply.threadId } });
    expect(events[0].data.previousThreadId).not.toBe(reply.threadId);
    expect((await pool.query('SELECT 1 FROM mail_threads WHERE id=$1', [events[0].data.previousThreadId])).rowCount).toBe(1);
  });

  it('moves only an existing isolated Sent member into a provider placeholder containing related replies', async () => {
    const sent = await message({ direction: 'outbound', own: localId });
    const firstOwn = '<first-child@example.test>';
    const first = await message({ own: firstOwn, references: [wireId] });
    const second = await message({ references: [wireId, firstOwn] });
    await transaction(client => submission(client, sent.id, mailbox));
    expect(await link(sent.id)).toEqual({ status: 'adopted', threadId: first.threadId });
    expect(await membership(second.id)).toBe(first.threadId);
    expect(await membership(sent.id)).toBe(first.threadId);
    expect((await pool.query('SELECT count(*) AS n FROM mail_message_state WHERE thread_id=$1', [sent.threadId])).rows[0].n).toBe('0');
  });

  it.each([false, true])('refuses a bridge into an unrelated destination even when its root is deleted=%s', async deleted => {
    const unrelatedOwn = '<unrelated-root@example.test>';
    const unrelated = await message({ own: unrelatedOwn });
    const bridge = await message({ references: [unrelatedOwn, wireId] });
    if (deleted) await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1', [unrelated.id]);
    const sent = await message({ direction: 'outbound', own: localId });
    await transaction(client => submission(client, sent.id, mailbox));
    const initialKeys = await keys();
    expect(bridge.threadId).toBe(unrelated.threadId);
    expect(await link(sent.id)).toEqual({ status: 'conflict', threadId: sent.threadId });
    expect(await membership(sent.id)).toBe(sent.threadId);
    expect(await membership(bridge.id)).toBe(unrelated.threadId);
    expect(await keys()).toEqual(initialKeys);
    expect((await pool.query('SELECT 1 FROM mailbox_changes WHERE delivery_id=$1', [sent.id])).rowCount).toBe(0);
  });

  it.each(['missing-headers', 'old-parser', 'malformed-headers', 'foreign-claim', 'extra-placeholder', 'ambiguous-key', 'empty-destination'])
    ('refuses destination evidence with %s', async defect => {
      const replyOwn = '<reply@example.test>';
      const reply = await message({ own: replyOwn, references: [wireId] });
      const sent = await message({ direction: 'outbound', own: localId });
      await transaction(client => submission(client, sent.id, mailbox));
      if (defect === 'missing-headers') await pool.query('DELETE FROM mail_thread_headers WHERE message_id=$1', [reply.id]);
      if (defect === 'old-parser') await pool.query('UPDATE mail_thread_headers SET parser_version=1 WHERE message_id=$1', [reply.id]);
      if (defect === 'malformed-headers') await pool.query("UPDATE mail_thread_headers SET reference_ids='{}'::jsonb WHERE message_id=$1", [reply.id]);
      if (defect === 'foreign-claim') {
        const outsider = await message();
        await pool.query('INSERT INTO mail_thread_keys(mailbox_id,token,thread_id,claim_message_id) VALUES($1,$2,$3,$4)',
          [mailbox,'foreign-claim@example.test',reply.threadId,outsider.id]);
      }
      if (defect === 'extra-placeholder') await pool.query('INSERT INTO mail_thread_keys(mailbox_id,token,thread_id) VALUES($1,$2,$3)',
        [mailbox,'unresolved@example.test',reply.threadId]);
      if (defect === 'ambiguous-key') await pool.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2', [mailbox,token(replyOwn)]);
      if (defect === 'empty-destination') await pool.query('UPDATE mail_message_state SET thread_id=NULL WHERE message_id=$1', [reply.id]);
      const initialKeys = await keys();
      expect((await link(sent.id)).status).toBe('conflict');
      expect(await membership(sent.id)).toBe(sent.threadId);
      expect(await keys()).toEqual(initialKeys);
    });

  it('uses the same References precedence and first In-Reply-To fallback as the indexer', async () => {
    const reply = await message({ inReplyTo: [wireId] });
    const sent = await message({ direction: 'outbound', own: localId });
    await transaction(client => submission(client, sent.id, mailbox));
    // Alter indexed metadata to model incomplete/reindexed evidence without changing membership.
    await pool.query('UPDATE mail_thread_headers SET reference_ids=$2::jsonb WHERE message_id=$1',
      [reply.id,JSON.stringify(['other@example.test'])]);
    expect((await link(sent.id)).status).toBe('conflict');
    await pool.query("UPDATE mail_thread_headers SET reference_ids='[]'::jsonb,in_reply_to=$2::jsonb WHERE message_id=$1",
      [reply.id,JSON.stringify(['other@example.test', token(wireId)])]);
    expect((await link(sent.id)).status).toBe('conflict');
    await pool.query('UPDATE mail_thread_headers SET in_reply_to=$2::jsonb WHERE message_id=$1', [reply.id,JSON.stringify([token(wireId)])]);
    expect(await link(sent.id)).toEqual({ status: 'adopted', threadId: reply.threadId });
  });

  it('never merges an established Sent conversation even if the wire token is an unclaimed placeholder', async () => {
    const sent = await message({ direction: 'outbound', own: localId });
    const oldReply = await message({ references: [localId] });
    const wireReply = await message({ references: [wireId] });
    await transaction(client => submission(client, sent.id, mailbox));
    expect(await link(sent.id)).toEqual({ status: 'conflict', threadId: sent.threadId });
    expect(await membership(oldReply.id)).toBe(sent.threadId);
    expect(await membership(wireReply.id)).not.toBe(sent.threadId);
    const raw = (await pool.query('SELECT message_id_header,warnings FROM mail_thread_headers WHERE message_id=$1', [sent.id])).rows[0];
    expect(raw.message_id_header).toBe(token(localId)); expect(raw.warnings).toContain('provider_message_id_conflict');
  });

  it('counts deleted members and unrelated placeholders when proving the source is isolated', async () => {
    const sent = await message({ direction: 'outbound', own: localId });
    const deleted = await message({ references: [localId] });
    await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1', [deleted.id]);
    await message({ references: [wireId] }); await transaction(client => submission(client, sent.id, mailbox));
    expect((await link(sent.id)).status).toBe('conflict');
    await pool.query('UPDATE mail_message_state SET thread_id=NULL WHERE message_id=$1', [deleted.id]);
    // The old reply's claimed key also makes this non-isolated even when its membership is removed.
    expect((await link(sent.id)).status).toBe('conflict');
  });

  it('does not hijack another claimed identity or clear an ambiguous alias', async () => {
    const other = await message({ own: wireId });
    const sent = await message({ direction: 'outbound', own: localId });
    await transaction(client => submission(client, sent.id, mailbox));
    expect((await link(sent.id)).status).toBe('conflict');
    expect((await keys()).find(key => key.token === token(wireId))).toMatchObject({ claim_message_id: other.id, ambiguous: true, thread_id: other.threadId });
    const later = await message({ references: [wireId] });
    expect(later.threadId).not.toBe(other.threadId); expect(later.threadId).not.toBe(sent.threadId);
    await pool.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2', [mailbox,token(wireId)]);
    expect((await link(sent.id)).status).toBe('conflict');
    expect((await keys()).find(key => key.token === token(wireId)).ambiguous).toBe(true);
  });

  it.each(['inbound-first', 'sent-first'])('keeps a same-wire-ID self-copy ambiguous in %s order', async order => {
    let incoming: Awaited<ReturnType<typeof message>>, sent: Awaited<ReturnType<typeof message>>;
    if (order === 'inbound-first') {
      incoming = await message({ own: wireId });
      sent = await message({ direction: 'outbound', own: localId, trusted: true });
    } else {
      sent = await message({ direction: 'outbound', own: localId, trusted: true });
      incoming = await message({ own: wireId });
    }
    expect(incoming.threadId).not.toBe(sent.threadId);
    expect((await keys()).find(key => key.token === token(wireId))).toMatchObject({
      ambiguous: true, claim_message_id: order === 'inbound-first' ? incoming.id : sent.id,
    });
    // Duplicate IDs alone cannot establish that two immutable deliveries are copies.
    const future = await message({ references: [wireId] });
    expect(future.threadId).not.toBe(incoming.threadId);
    expect(future.threadId).not.toBe(sent.threadId);
    expect((await link(sent.id)).status).toBe('conflict');
  });

  it('ignores inbound forged metadata and opaque provider tracking values', async () => {
    const incomingId = randomUUID();
    const inbound = await message({ id: incomingId, trusted: true, metadata: { kind: 'outbound', submissionId: incomingId, rfcMessageId: wireId } });
    expect((await link(inbound.id)).status).toBe('ignored');
    const sent = await message({ direction: 'outbound', own: localId, trusted: true, rfc: null });
    expect((await link(sent.id)).status).toBe('ignored');
    expect((await keys()).some(key => key.token === token(wireId))).toBe(false);
  });

  it('refuses wrong mailbox, raw correspondence and unaccepted submission evidence', async () => {
    const sent = await message({ direction: 'outbound', own: localId });
    await transaction(client => submission(client, sent.id, mailbox, { sha256: 'b'.repeat(64) }));
    expect((await link(sent.id)).status).toBe('ignored');
    expect(await link(sent.id, otherMailbox)).toEqual({ threadId: null, status: 'ignored' });
    await expect(message({ direction: 'outbound', own: '<rejected-evidence@example.test>', trusted: true, trustedState: 'unknown', rfc: '<unused@example.test>' }))
      .rejects.toMatchObject({ constraint: 'outbound_rfc_identity_requires_acceptance' });
    const notAccepted = await message({ direction: 'outbound', own: '<queued@example.test>', trusted: true, trustedState: 'unknown', rfc: null });
    expect((await link(notAccepted.id)).status).toBe('ignored');
  });

  it('refuses singleton adoption when the source also owns an unresolved ancestor placeholder', async () => {
    const sent = await message({ direction: 'outbound', own: localId, references: ['<older-missing@example.test>'] });
    const reply = await message({ references: [wireId] });
    await transaction(client => submission(client, sent.id, mailbox));
    expect((await link(sent.id)).status).toBe('conflict');
    expect(await membership(sent.id)).not.toBe(reply.threadId);
  });

  it('rejects a mismatched persisted Sent pointer and keeps concurrent exact linking idempotent', async () => {
    const sent = await message({ direction: 'outbound', own: localId });
    await transaction(client => submission(client, sent.id, mailbox));
    const other = await message();
    await pool.query('UPDATE outbound_submissions SET sent_message_id=$2 WHERE id=$1', [sent.id,other.id]);
    expect((await link(sent.id)).status).toBe('ignored');
    await pool.query('UPDATE outbound_submissions SET sent_message_id=$2 WHERE id=$1', [sent.id,sent.id]);
    const results = await Promise.all([link(sent.id),link(sent.id)]);
    expect(results.map(result => result.status).sort()).toEqual(['linked','unchanged']);
    expect((await pool.query('SELECT count(*) AS n FROM mailbox_changes WHERE delivery_id=$1', [sent.id])).rows[0].n).toBe('1');
  });

  it('keeps aliases mailbox-scoped and case-sensitive', async () => {
    const sent = await message({ direction: 'outbound', own: localId, trusted: true });
    const lower = await message({ references: [wireId.toLowerCase()] });
    const foreign = await message({ box: otherMailbox, references: [wireId] });
    expect(lower.threadId).not.toBe(sent.threadId); expect(foreign.threadId).not.toBe(sent.threadId);
    expect(await transaction(client => getOutboundRfcMessageId(client, { mailboxId: mailbox, messageId: sent.id }))).toBe(wireId);
    expect(await transaction(client => getOutboundRfcMessageId(client, { mailboxId: otherMailbox, messageId: sent.id }))).toBeNull();
  });

  it('is idempotent across repeated linking and reparsing while preserving the original parsed ID', async () => {
    const sent = await message({ direction: 'outbound', own: localId, trusted: true });
    const initialKeys = await keys(); const initialChanges = (await pool.query('SELECT count(*) AS n FROM mailbox_changes')).rows[0].n;
    expect((await link(sent.id)).status).toBe('unchanged');
    await transaction(client => indexMessageThread(client, { mailboxId: mailbox, messageId: sent.id, messageIdHeader: localId, references: [], parserVersion: 3 }));
    expect(await keys()).toEqual(initialKeys);
    expect((await pool.query('SELECT count(*) AS n FROM mailbox_changes')).rows[0].n).toBe(initialChanges);
    expect((await pool.query('SELECT message_id_header FROM mail_thread_headers WHERE message_id=$1', [sent.id])).rows[0].message_id_header).toBe(token(localId));
  });
});
