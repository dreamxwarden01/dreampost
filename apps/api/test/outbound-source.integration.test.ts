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
import { backfillMailContentFingerprints } from '../src/mail/fingerprint-backfill.js';
import { recordVerifiedOutboundRfcMessageId } from '../src/outbound/message-id.js';
import { ensureSentCopy } from '../src/outbound/dispatcher.js';
import { OutboundService } from '../src/outbound/service.js';
import { loadOutboundConfig } from '../src/outbound/config.js';

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
  async function acceptedSent(wire:string|null=null,persist=true) {
    const deps=dependencies(), id=randomUUID(), draftId=randomUUID();
    const snapshot={submissionId:id,mailboxId,rawSha256:sha256,rawSize:raw.length,date:new Date().toISOString(),from:{name:'',address:'owner@example.test'},providerMessageId:'<verified-provider@example.test>',rfcMessageId:wire} as SentCopyInput;
    await pool.query("INSERT INTO outbound_drafts(id,mailbox_id,author_principal_id,state,mode) VALUES($1,$2,$3,'queued','new')",[draftId,mailboxId,actorId]);
    await pool.query(`INSERT INTO outbound_submissions(id,draft_id,draft_version,mailbox_id,author_principal_id,state,snapshot,raw_sha256,raw_size,provider_message_id,rfc_message_id,queue_deadline)
      VALUES($1,$2,1,$3,$4,'accepted',$5,$6,$7,$8,$9,now()+interval '1 day')`,[id,draftId,mailboxId,actorId,snapshot,sha256,raw.length,snapshot.providerMessageId,wire]);
    const prepared=await deps.prepareSent(snapshot),client=await pool.connect();
    try{if(persist){await client.query('BEGIN');await deps.persistSent(client,snapshot,prepared);await client.query('COMMIT');}}finally{client.release();}
    return {deps,snapshot,prepared};
  }
  it('runs real Sent-copy recovery through canonical persistence and alias indexing without any provider call',async()=>{
    const wire='<Sent.Job@example.test>',{deps,snapshot}=await acceptedSent(wire,false);
    await pool.query("UPDATE outbound_submissions SET sent_copy_state='pending' WHERE id=$1",[snapshot.submissionId]);
    const before=(await pool.query('SELECT snapshot,raw_sha256,raw_size FROM outbound_submissions WHERE id=$1',[snapshot.submissionId])).rows[0];
    const send=vi.fn(async()=>{throw new Error('Sent recovery must never send');});
    deps.transport={capabilities:{maxMessageBytes:5*1024*1024,maxRecipients:50,supportsIdempotencyKey:false},send};
    const persist=vi.spyOn(deps,'persistSent'),service=new OutboundService(pool,loadOutboundConfig({}),deps);
    expect(await ensureSentCopy(service)).toBe(true);expect(await ensureSentCopy(service)).toBe(false);
    expect(send).not.toHaveBeenCalled();expect(persist).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT state,sent_copy_state,sent_message_id,rfc_message_id FROM outbound_submissions WHERE id=$1',[snapshot.submissionId])).rows[0])
      .toEqual({state:'accepted',sent_copy_state:'done',sent_message_id:snapshot.submissionId,rfc_message_id:wire});
    const keys=(await pool.query('SELECT token,thread_id,claim_message_id FROM mail_thread_keys WHERE mailbox_id=$1 ORDER BY token',[mailboxId])).rows;
    expect(keys.map(row=>row.token)).toEqual(['Sent.Job@example.test','immutable@example.test']);
    expect(new Set(keys.map(row=>row.thread_id)).size).toBe(1);expect(keys.every(row=>row.claim_message_id===snapshot.submissionId)).toBe(true);
    expect((await pool.query('SELECT snapshot,raw_sha256,raw_size FROM outbound_submissions WHERE id=$1',[snapshot.submissionId])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT sha256,raw_size FROM deliveries WHERE id=$1',[snapshot.submissionId])).rows[0]).toEqual({sha256,raw_size:raw.length});
    expect((await pool.query('SELECT headers FROM message_reader_data WHERE delivery_id=$1',[snapshot.submissionId])).rows[0].headers.messageId).toBe('<immutable@example.test>');
    expect((await pool.query('SELECT message_id_header FROM mail_thread_headers WHERE message_id=$1',[snapshot.submissionId])).rows[0].message_id_header).toBe('immutable@example.test');
  });
  it('uses verified wire identity for Sent follow-ups while original MIME and reader headers stay unchanged',async()=>{
    const wire='<Provider.Case@example.test>',{deps,snapshot,prepared}=await acceptedSent(wire),client=await pool.connect();
    try{
      const source=await deps.loadSource(client,actorId,mailboxId,snapshot.submissionId);
      expect(source.messageIdHeader).toBe(wire);expect(source.sourceSha256).toBe(sha256);
      const reader=(await pool.query('SELECT headers FROM message_reader_data WHERE delivery_id=$1',[snapshot.submissionId])).rows[0];
      expect(reader.headers.messageId).toBe('<immutable@example.test>');
      expect((await pool.query('SELECT message_id_header FROM mail_thread_headers WHERE message_id=$1',[snapshot.submissionId])).rows[0].message_id_header).toBe('immutable@example.test');
      await client.query('BEGIN');await deps.persistSent(client,snapshot,prepared);await client.query('COMMIT');
      expect((await pool.query('SELECT count(*) FROM deliveries WHERE id=$1',[snapshot.submissionId])).rows[0].count).toBe('1');
      expect((await pool.query('SELECT sha256,raw_size FROM deliveries WHERE id=$1',[snapshot.submissionId])).rows[0]).toEqual({sha256,raw_size:raw.length});
      await pool.query('UPDATE mailbox_memberships SET revoked_at=now() WHERE principal_id=$1',[actorId]);
      await expect(deps.loadSource(client,actorId,mailboxId,snapshot.submissionId)).rejects.toMatchObject({code:'source_not_found'});
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('does not promote old bracketed receipts or forged incoming metadata to reply identity',async()=>{
    const {deps,snapshot}=await acceptedSent(),client=await pool.connect();
    try{
      expect((await deps.loadSource(client,actorId,mailboxId,snapshot.submissionId)).messageIdHeader).toBe('<immutable@example.test>');
      await pool.query(`UPDATE deliveries SET metadata=metadata || $2::jsonb WHERE id=$1`,[messageId,JSON.stringify({kind:'outbound',submissionId:messageId,rfcMessageId:'<forged@example.test>',providerMessageId:'<forged@example.test>'})]);
      expect((await deps.loadSource(client,actorId,mailboxId,messageId)).messageIdHeader).toBe('<immutable@example.test>');
    }finally{client.release();}
  });
  it('repairs one independently verified accepted identity idempotently with exact binding checks',async()=>{
    const {deps,snapshot}=await acceptedSent(),client=await pool.connect();
    const input={mailboxId,submissionId:snapshot.submissionId,expectedRawSha256:sha256,expectedRawSize:raw.length,expectedProviderMessageId:snapshot.providerMessageId!,rfcMessageId:'<verified-provider@example.test>',operatorLabel:'Synthetic verified receipt repair'};
    try{
      for(const wrong of [{expectedRawSha256:'0'.repeat(64)},{expectedRawSize:raw.length+1},{expectedProviderMessageId:'other-receipt'},{mailboxId:randomUUID()}]){
        await client.query('BEGIN');await expect(recordVerifiedOutboundRfcMessageId(client,{...input,...wrong})).rejects.toThrow('outbound_message_id_repair_binding_mismatch');await client.query('ROLLBACK');
      }
      await client.query('BEGIN');expect(await recordVerifiedOutboundRfcMessageId(client,input)).toMatchObject({recorded:true,status:'linked'});await client.query('COMMIT');
      await client.query('BEGIN');expect(await recordVerifiedOutboundRfcMessageId(client,input)).toMatchObject({recorded:false,status:'unchanged'});await client.query('COMMIT');
      expect((await deps.loadSource(client,actorId,mailboxId,snapshot.submissionId)).messageIdHeader).toBe(input.rfcMessageId);
      expect((await pool.query("SELECT count(*) FROM mailbox_changes WHERE kind='message.provider_identity_recorded'")).rows[0].count).toBe('1');
      await client.query('BEGIN');await expect(recordVerifiedOutboundRfcMessageId(client,{...input,rfcMessageId:'<different@example.test>'})).rejects.toThrow('outbound_rfc_message_id_conflict');await client.query('ROLLBACK');
      await expect(pool.query('UPDATE outbound_submissions SET rfc_message_id=NULL WHERE id=$1',[snapshot.submissionId])).rejects.toThrow('outbound_rfc_message_id_immutable');
      expect((await pool.query('SELECT headers FROM message_reader_data WHERE delivery_id=$1',[snapshot.submissionId])).rows[0].headers.messageId).toBe('<immutable@example.test>');
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('backfills existing raw evidence in bounded pages, without rewriting reader data or repeating completed work',async()=>{
    const extra=randomUUID();
    await pool.query("INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,plain_text,parse_status) VALUES($1,$2,'{}',$3,$4,now(),'Original text.','parsed')",[extra,mailboxId,sha256,raw.length]);
    await pool.query("UPDATE deliveries SET parse_status='parsed' WHERE id=$1",[messageId]);
    for(const id of [messageId,extra])await pool.query(`INSERT INTO mail_thread_headers(message_id,mailbox_id,parser_version,message_id_header) VALUES($1,$2,2,'immutable@example.test')`,[id,mailboxId]);
    const blobs={get,put:async()=>{}};
    const first=await backfillMailContentFingerprints(pool,blobs,{limit:1,mailboxId});
    expect(first.processed).toBe(1);expect(first.nextCursor).toBeTruthy();
    const second=await backfillMailContentFingerprints(pool,blobs,{limit:1,afterDeliveryId:first.nextCursor!,mailboxId});
    expect(second.processed).toBe(1);expect(second.nextCursor).toBeNull();
    expect(await backfillMailContentFingerprints(pool,blobs,{mailboxId})).toMatchObject({processed:0,linked:0,moved:0});
    expect(get).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT sha256,raw_size FROM deliveries ORDER BY id')).rows).toEqual([{sha256,raw_size:raw.length},{sha256,raw_size:raw.length}]);
    expect((await pool.query('SELECT headers FROM message_reader_data WHERE delivery_id=$1',[messageId])).rows[0].headers.messageId).toBe('<immutable@example.test>');
  });
  it('rejects changed raw bytes and rechecks tombstones after unlocked backfill hashing',async()=>{
    await pool.query("UPDATE deliveries SET parse_status='parsed' WHERE id=$1",[messageId]);
    await pool.query(`INSERT INTO mail_thread_headers(message_id,mailbox_id,parser_version,message_id_header) VALUES($1,$2,2,'immutable@example.test')`,[messageId,mailboxId]);
    get.mockResolvedValue(Buffer.from('different bytes'));
    expect(await backfillMailContentFingerprints(pool,{get,put:async()=>{}},{mailboxId})).toMatchObject({processed:0,failures:[{deliveryId:messageId,code:'fingerprint_raw_identity_mismatch'}]});
    expect((await pool.query('SELECT count(*) AS n FROM mail_content_fingerprints')).rows[0].n).toBe('0');
    get.mockImplementation(async()=>{await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1',[messageId]);return raw;});
    expect(await backfillMailContentFingerprints(pool,{get,put:async()=>{}},{mailboxId})).toMatchObject({processed:0});
    expect((await pool.query('SELECT count(*) AS n FROM mail_content_fingerprints')).rows[0].n).toBe('0');
  });
  it('continues a backfill past an unavailable blob and returns per-row recovery evidence',async()=>{
    const ids=[randomUUID(),randomUUID()].sort(),otherSha=createHash('sha256').update('unavailable').digest('hex');
    for(const [index,id]of ids.entries()){
      await pool.query("INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,parse_status) VALUES($1,$2,'{}',$3,$4,now(),'parsed')",[id,mailboxId,index?sha256:otherSha,raw.length]);
      await pool.query("INSERT INTO mail_thread_headers(message_id,mailbox_id,parser_version,message_id_header) VALUES($1,$2,2,'backfill@example.test')",[id,mailboxId]);
    }
    const result=await backfillMailContentFingerprints(pool,{get:async sha=>{if(sha===otherSha)throw new Error('missing');return raw;},put:async()=>{}},{mailboxId,limit:2});
    expect(result).toMatchObject({processed:1,nextCursor:null,failures:[{deliveryId:ids[0],code:'fingerprint_raw_unavailable'}]});
    expect((await pool.query('SELECT delivery_id FROM mail_content_fingerprints ORDER BY delivery_id')).rows).toEqual([{delivery_id:ids[1]}]);
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
