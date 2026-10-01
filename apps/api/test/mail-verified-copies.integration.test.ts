import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/database.js';
import { fingerprintMessageContent } from '../src/mail/content-fingerprint.js';
import { recordVerifiedOutboundRfcMessageId } from '../src/outbound/message-id.js';
import { backfillVerifiedCopies, indexMessageThread, reconcileVerifiedCopies, storeMailContentFingerprint } from '../src/mail/threading.js';

const databaseUrl=process.env['TEST_DATABASE_URL'];
const wire='<wire.copy@example.test>', local='<local.copy@example.test>', self='self@example.test', alias='alias@example.test';
const token=(value:string)=>value.slice(1,-1), hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function mime(id:string,body='Original complete message',extra='') { return Buffer.from(`From: Sender <sender@example.test>\r\nTo: ${self}\r\nSubject: Self copy\r\nDate: Tue, 01 Oct 2024 12:00:00 +0000\r\nMessage-ID: ${id}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n${extra}\r\n${body}\r\n`); }

describe.skipIf(!databaseUrl)('verified self copies in isolated PostgreSQL',()=>{
  const schema=`verified_copies_${randomUUID().replaceAll('-','')}`;
  const mailbox=randomUUID(), foreignMailbox=randomUUID(), actor=randomUUID();
  let admin:pg.Pool,pool:pg.Pool;
  const allocations=new Map<string,string>();
  async function transaction<T>(fn:(client:PoolClient)=>Promise<T>) { const client=await pool.connect();try {await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();} }
  beforeAll(async()=>{admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:4});await migrate(pool);});
  beforeEach(async()=>{
    await pool.query('TRUNCATE mailboxes,principals CASCADE');allocations.clear();
    await pool.query("INSERT INTO principals(id,issuer,subject,app_role,access_enabled) VALUES($1::uuid,'synthetic',$1::text,1,true)",[actor]);
    await pool.query("INSERT INTO mailboxes(id,address,name) VALUES($1,'mailbox@example.test','Mailbox'),($2,'foreign@example.test','Foreign')",[mailbox,foreignMailbox]);
    for(const [address,box] of [[self,mailbox],[alias,mailbox],['foreign@example.test',foreignMailbox]]){
      const allocation=randomUUID();allocations.set(address!,allocation);
      await pool.query("INSERT INTO address_registry(address,domain,state) VALUES($1,'example.test','allocated')",[address]);
      await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source) VALUES($1,$2,$3,'manual')",[allocation,address,box]);
      await pool.query(`INSERT INTO address_policy_history(operation_id,address,allocation_id,mailbox_id,previous_revision,revision,receive_enabled,sha256,payload)
        VALUES($1,$2,$3,$4,0,1,true,$5,'{}')`,[randomUUID(),address,allocation,box,'b'.repeat(64)]);
    }
  });
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}});
  async function put(options:{outbound?:boolean;id?:string;box?:string;own?:string;recipient?:string;body?:string;extra?:string;v1?:boolean;missingFingerprint?:boolean;recipientStatus?:string;outboxState?:string;wire?:string|null;recipientAddresses?:string[];references?:string[];rawMetadata?:object}={}){
    const id=options.id??randomUUID(),box=options.box??mailbox,own=options.own??(options.outbound?local:wire),recipient=options.recipient??self;
    const raw=mime(own,options.body,(options.extra??(options.outbound?'':'Received: synthetic transit\r\n'))+(options.references?.length?`References: ${options.references.join(' ')}\r\n`:''));
    const sha=hash(raw), fingerprint=fingerprintMessageContent(raw);
    return transaction(async client=>{
      await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[box]);
      if(options.outbound){
        const draft=randomUUID();await client.query("INSERT INTO outbound_drafts(id,mailbox_id,author_principal_id,mode,state) VALUES($1,$2,$3,'new','queued')",[draft,box,actor]);
        await client.query(`INSERT INTO outbound_submissions(id,draft_id,draft_version,mailbox_id,author_principal_id,state,snapshot,raw_sha256,raw_size,queue_deadline,rfc_message_id)
          VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,now()+interval '1 hour',$9)`,[id,draft,box,actor,options.outboxState??'accepted',{envelopeRecipients:options.recipientAddresses??[self,alias,'foreign@example.test'],messageIdHeader:own},sha,raw.length,options.wire===undefined?wire:options.wire]);
        for(const address of options.recipientAddresses??[self,alias,'foreign@example.test'])await client.query('INSERT INTO outbound_recipients(submission_id,address,status) VALUES($1,$2,$3)',[id,address,address===recipient?(options.recipientStatus??'accepted'):'accepted']);
      }
      const metadata=options.rawMetadata??(options.outbound?{kind:'outbound',submissionId:id}:{version:options.v1?1:2,deliveryId:id,mailboxId:box,envelopeFrom:'sender@example.test',envelopeTo:recipient,allocationId:allocations.get(recipient.toLowerCase()),routeRevision:1,policyDigest:'b'.repeat(64),rawSize:raw.length,receivedAt:new Date().toISOString()});
      await client.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,direction,parse_status)
        VALUES($1,$2,$3,$4,$5,now(),$6,'parsed')`,[id,box,metadata,sha,raw.length,options.outbound?'outbound':'inbound']);
      if(!options.missingFingerprint)await storeMailContentFingerprint(client,{deliveryId:id,mailboxId:box,version:1,sha256:fingerprint?.sha256??null,rawSha256:sha,rawSize:raw.length});
      const threadId=await indexMessageThread(client,{mailboxId:box,messageId:id,messageIdHeader:own,references:options.references,parserVersion:2});
      return{id,box,threadId,sha,raw,fingerprint};
    });
  }
  const state=async(id:string)=>(await pool.query('SELECT thread_id,folder,filing_version FROM mail_message_state WHERE message_id=$1',[id])).rows[0];
  const key=async()=>(await pool.query('SELECT thread_id,claim_message_id,ambiguous,ambiguity_unproven FROM mail_thread_keys WHERE mailbox_id=$1 AND token=$2',[mailbox,token(wire)])).rows[0];
  const relation=async(id:string)=>(await pool.query('SELECT * FROM mail_verified_copies WHERE inbound_message_id=$1',[id])).rows[0];
  const reconcile=(id:string)=>transaction(client=>reconcileVerifiedCopies(client,{mailboxId:mailbox,messageId:id}));

  it.each(['sent-first','inbound-first'])('groups complete self copies in %s order without changing raw, filing or flags',async order=>{
    let incoming:Awaited<ReturnType<typeof put>>,sent:Awaited<ReturnType<typeof put>>;
    if(order==='sent-first'){sent=await put({outbound:true});incoming=await put();}
    else {incoming=await put();await pool.query("UPDATE mail_message_state SET folder='archive',filing_version=7 WHERE message_id=$1",[incoming.id]);await pool.query('INSERT INTO principal_message_flags(mailbox_id,message_id,principal_id,is_read,is_starred,flags_version) VALUES($1,$2,$3,true,true,3)',[mailbox,incoming.id,actor]);sent=await put({outbound:true});}
    expect((await state(incoming.id)).thread_id).toBe((await state(sent.id)).thread_id);
    expect(await relation(incoming.id)).toMatchObject({sent_message_id:sent.id,fingerprint_version:1,inbound_raw_sha256:incoming.sha,sent_raw_sha256:sent.sha});
    expect(incoming.sha).not.toBe(sent.sha);expect(incoming.fingerprint).toEqual(sent.fingerprint);
    if(order==='inbound-first') {expect(await state(incoming.id)).toMatchObject({folder:'archive',filing_version:'7'});expect((await pool.query('SELECT is_read,is_starred,flags_version FROM principal_message_flags WHERE message_id=$1',[incoming.id])).rows[0]).toEqual({is_read:true,is_starred:true,flags_version:'3'});}
    else expect(await state(incoming.id)).toMatchObject({folder:'inbox',filing_version:'1'});
    expect(await state(sent.id)).toMatchObject({folder:'archive',filing_version:'1'});
    expect(await key()).toMatchObject({claim_message_id:sent.id,ambiguous:false});
    const reply=await put({own:'<future-reply@example.test>',body:'A genuine different reply',references:[wire]});
    expect((await state(reply.id)).thread_id).toBe((await state(sent.id)).thread_id);expect(await relation(reply.id)).toBeUndefined();
    expect((await pool.query('SELECT count(*) AS n FROM deliveries')).rows[0].n).toBe('3');
  });

  it('captures legacy writer claims in database triggers and preserves them after reparse or row deletion',async()=>{
    const genuine=await put(),competitor=await put({own:'<old-parser@example.test>',body:'Different full content'});
    // Simulate the pre-014 writer: it never calls recordThreadIdentityClaim.
    await pool.query('UPDATE mail_thread_headers SET message_id_header=$2 WHERE message_id=$1',[competitor.id,token(wire)]);
    await pool.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2',[mailbox,token(wire)]);
    await pool.query('UPDATE mail_thread_headers SET message_id_header=$2 WHERE message_id=$1',[competitor.id,'reparsed@example.test']);
    await pool.query('DELETE FROM mail_thread_headers WHERE message_id=$1',[competitor.id]);
    const sent=await put({outbound:true});
    expect(await relation(genuine.id)).toMatchObject({sent_message_id:sent.id});expect(await key()).toMatchObject({ambiguous:true});
    const history=(await pool.query('SELECT token FROM mail_thread_identity_claims WHERE mailbox_id=$1 AND message_id=$2 ORDER BY token',[mailbox,competitor.id])).rows.map(row=>row.token);
    expect(history).toEqual(['old-parser@example.test','reparsed@example.test',token(wire)]);
    await pool.query('INSERT INTO mail_thread_keys(mailbox_id,token,thread_id,claim_message_id) VALUES($1,$2,$3,$4)',[mailbox,'key-only@example.test',competitor.threadId,competitor.id]);
    await pool.query('UPDATE mail_thread_keys SET claim_message_id=$3 WHERE mailbox_id=$1 AND token=$2',[mailbox,'key-only@example.test',genuine.id]);
    await pool.query('DELETE FROM mail_thread_keys WHERE mailbox_id=$1 AND token=$2',[mailbox,'key-only@example.test']);
    expect((await pool.query('SELECT count(*) AS n FROM mail_thread_identity_claims WHERE mailbox_id=$1 AND token=$2',[mailbox,'key-only@example.test'])).rows[0].n).toBe('2');
    await expect(pool.query('DELETE FROM mail_thread_identity_claims WHERE mailbox_id=$1 AND token=$2',[mailbox,token(wire)])).rejects.toThrow('mail_identity_claim_append_only');
    await expect(pool.query('UPDATE mail_thread_identity_claims SET first_seen_at=now() WHERE mailbox_id=$1',[mailbox])).rejects.toThrow('mail_identity_claim_append_only');
  });

  it('groups an inbound-first copy immediately when verified provider identity is repaired later',async()=>{
    const incoming=await put(),sent=await put({outbound:true,wire:null});
    expect(await relation(incoming.id)).toBeUndefined();
    await pool.query('UPDATE outbound_submissions SET provider_message_id=$2 WHERE id=$1',[sent.id,wire]);
    const result=await transaction(client=>recordVerifiedOutboundRfcMessageId(client,{mailboxId:mailbox,submissionId:sent.id,
      expectedRawSha256:sent.sha,expectedRawSize:sent.raw.length,expectedProviderMessageId:wire,rfcMessageId:wire,operatorLabel:'Synthetic late receipt verification'}));
    expect(result).toMatchObject({recorded:true,status:'unchanged'});
    expect(await relation(incoming.id)).toMatchObject({sent_message_id:sent.id});
    expect((await state(incoming.id)).thread_id).toBe((await state(sent.id)).thread_id);expect(await key()).toMatchObject({ambiguous:false,claim_message_id:sent.id});
  });

  it('counts distinct Sent submissions rather than duplicate case-folded recipient join rows',async()=>{
    const sent=await put({outbound:true,recipientAddresses:[self,self.toUpperCase(),alias]});
    const incoming=await put();expect(await relation(incoming.id)).toMatchObject({sent_message_id:sent.id});
  });

  it('filters sent-side candidates by complete fingerprint before the 100-row scan bound',async()=>{
    for(let index=0;index<101;index++)await put({id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,body:`Different forged content ${index}`});
    const genuine=await put({id:'ffffffff-ffff-4fff-8fff-ffffffffffff'}),sent=await put({outbound:true});
    expect(await relation(genuine.id)).toMatchObject({sent_message_id:sent.id});expect(await key()).toMatchObject({ambiguous:true});
  },20000);

  it('recovers a closed reply thread created while multiple early copies temporarily made the wire ID ambiguous',async()=>{
    const first=await put({id:'00000000-0000-4000-8000-000000000101'}),second=await put({id:'00000000-0000-4000-8000-000000000102',recipient:alias});
    await pool.query(`UPDATE mail_thread_headers SET warnings=warnings || '["keep_this_warning"]'::jsonb WHERE message_id=$1`,[second.id]);
    const reply=await put({own:'<isolated-early-reply@example.test>',body:'Early reply',references:[wire]});
    const child=await put({own:'<isolated-early-child@example.test>',body:'Early child',references:[wire,'<isolated-early-reply@example.test>']});
    expect(reply.threadId).not.toBe(first.threadId);expect(reply.threadId).not.toBe(second.threadId);
    const sent=await put({outbound:true}),target=(await state(sent.id)).thread_id;
    for(const item of [first,second,reply,child])expect((await state(item.id)).thread_id).toBe(target);
    expect((await pool.query('SELECT warnings FROM mail_thread_headers WHERE message_id=$1',[second.id])).rows[0].warnings).toEqual(['keep_this_warning']);
    expect(await relation(reply.id)).toBeUndefined();expect(await relation(child.id)).toBeUndefined();
    expect(await key()).toMatchObject({ambiguous:false,claim_message_id:sent.id});
  });

  it.each(['foreign-reference','unresolved-ancestor','missing-headers'])('leaves a detached reply with %s outside the canonical copy conversation',async defect=>{
    if(defect==='foreign-reference')await put({own:'<separate-root@example.test>',body:'Separate root'});
    const first=await put(),second=await put({recipient:alias});
    const refs=defect==='foreign-reference'?['<separate-root@example.test>',wire]:defect==='unresolved-ancestor'?['<unresolved-root@example.test>',wire]:[wire];
    const reply=await put({own:'<unsafe-detached@example.test>',body:'Unproven branch',references:refs});
    if(defect==='missing-headers')await pool.query('DELETE FROM mail_thread_headers WHERE message_id=$1',[reply.id]);
    const sent=await put({outbound:true}),target=(await state(sent.id)).thread_id;
    for(const item of [first,second])expect((await state(item.id)).thread_id).toBe(target);
    expect((await state(reply.id)).thread_id).toBe(reply.threadId);expect(reply.threadId).not.toBe(target);
  });

  it('clears only proved wire warnings and preserves a duplicate local Sent identity warning',async()=>{
    await put({own:local,body:'Unrelated local-ID collision'});
    const incoming=await put(),sent=await put({outbound:true});
    await pool.query(`UPDATE mail_thread_headers SET warnings=warnings || '["provider_message_id_conflict","other_warning"]'::jsonb WHERE message_id=$1`,[sent.id]);
    await reconcile(sent.id);
    expect(await relation(incoming.id)).toMatchObject({sent_message_id:sent.id});
    expect((await pool.query('SELECT warnings FROM mail_thread_headers WHERE message_id=$1',[sent.id])).rows[0].warnings).toEqual(['duplicate_message_id','other_warning']);
  });

  it('supports Bcc/alias envelope evidence without using visible To or current alias ownership',async()=>{
    const sent=await put({outbound:true});
    await pool.query('UPDATE address_allocations SET ended_at=now() WHERE id=$1',[allocations.get(alias)]);
    const incoming=await put({recipient:alias});
    expect(await relation(incoming.id)).toMatchObject({sent_message_id:sent.id,envelope_recipient:alias});
    expect((await state(incoming.id)).thread_id).toBe((await state(sent.id)).thread_id);
    expect(incoming.raw.toString()).not.toContain(alias);
  });

  it('uses admission history after alias reassignment and still refuses the new mailbox',async()=>{
    const sent=await put({outbound:true});const oldAllocation=allocations.get(alias)!;
    await pool.query('UPDATE address_allocations SET ended_at=now() WHERE id=$1',[oldAllocation]);
    const reassigned=randomUUID();await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source) VALUES($1,$2,$3,'reassigned')",[reassigned,alias,foreignMailbox]);
    await pool.query(`INSERT INTO address_policy_history(operation_id,address,allocation_id,mailbox_id,previous_revision,revision,receive_enabled,sha256,payload)
      VALUES($1,$2,$3,$4,1,2,true,$5,'{}')`,[randomUUID(),alias,reassigned,foreignMailbox,'c'.repeat(64)]);
    const oldAccepted=await put({recipient:alias.toUpperCase()});
    expect(await relation(oldAccepted.id)).toMatchObject({sent_message_id:sent.id,allocation_id:oldAllocation});
    const newlyReceived=await put({box:foreignMailbox,recipient:alias,rawMetadata:{version:2,mailboxId:foreignMailbox,envelopeTo:alias,allocationId:reassigned,routeRevision:2,policyDigest:'c'.repeat(64)}});
    expect(await relation(newlyReceived.id)).toBeUndefined();
    expect((await state(newlyReceived.id)).thread_id).not.toBe((await state(sent.id)).thread_id);
  });

  it.each(['changed-body','changed-header','v1','missing-fingerprint','failed-recipient','wrong-admission','other-mailbox'])('refuses unsafe correlation: %s',async failure=>{
    const sent=await put({outbound:true,...(failure==='failed-recipient'?{outboxState:'partial',recipientStatus:'failed'}:{})});
    const incoming=await put({
      ...(failure==='changed-body'?{body:'Attacker changed message'}:{}),
      ...(failure==='changed-header'?{extra:'Reply-To: attacker@example.test\r\n'}:{}),
      ...(failure==='v1'?{v1:true}:{}),...(failure==='missing-fingerprint'?{missingFingerprint:true}:{}),
      ...(failure==='wrong-admission'?{rawMetadata:{version:2,mailboxId:mailbox,envelopeTo:self,allocationId:randomUUID(),routeRevision:1,policyDigest:'b'.repeat(64)}}:{}),
      ...(failure==='other-mailbox'?{box:foreignMailbox,recipient:'foreign@example.test'}:{})});
    expect(await relation(incoming.id)).toBeUndefined();expect((await state(incoming.id)).thread_id).not.toBe((await state(sent.id)).thread_id);
  });

  it('preserves unknown competing claims even when deleted or later reparsed to another ID',async()=>{
    const attacker=await put({body:'Forged same-ID body'});await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1',[attacker.id]);
    const genuine=await put();const sent=await put({outbound:true});
    expect(await relation(genuine.id)).toMatchObject({sent_message_id:sent.id});expect(await relation(attacker.id)).toBeUndefined();
    expect(await key()).toMatchObject({ambiguous:true});
    await pool.query('UPDATE deliveries SET deleted_at=NULL WHERE id=$1',[attacker.id]);
    await transaction(client=>indexMessageThread(client,{mailboxId:mailbox,messageId:attacker.id,messageIdHeader:'<changed-parser-id@example.test>',parserVersion:3}));
    await reconcile(sent.id);expect(await key()).toMatchObject({ambiguous:true});
    expect((await pool.query('SELECT 1 FROM mail_thread_identity_claims WHERE mailbox_id=$1 AND token=$2 AND message_id=$3',[mailbox,token(wire),attacker.id])).rowCount).toBe(1);
  });

  it('moves only the verified copy out of a poisoned placeholder without merging unrelated members',async()=>{
    const unrelated=await put({own:'<unrelated@example.test>',body:'Unrelated'});
    const bridge=await put({own:'<bridge@example.test>',body:'Bridge',references:['<unrelated@example.test>',wire]});
    const incoming=await put();expect(incoming.threadId).toBe(unrelated.threadId);
    const sent=await put({outbound:true});
    expect((await state(incoming.id)).thread_id).toBe((await state(sent.id)).thread_id);
    expect((await state(unrelated.id)).thread_id).toBe(unrelated.threadId);expect((await state(bridge.id)).thread_id).toBe(unrelated.threadId);
    expect((await state(sent.id)).thread_id).not.toBe(unrelated.threadId);
  });

  it('moves a closed early-copy branch including prior replies and tombstones when Sent persists later',async()=>{
    const incoming=await put();const replyOwn='<early-reply@example.test>';
    const reply=await put({own:replyOwn,body:'Reply before Sent persistence',references:[wire]});
    const child=await put({own:'<early-child@example.test>',body:'Child before Sent persistence',references:[wire,replyOwn]});
    await pool.query("UPDATE mail_message_state SET folder='archive',filing_version=8 WHERE message_id=$1",[reply.id]);
    await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1',[child.id]);
    const sent=await put({outbound:true});const target=(await state(sent.id)).thread_id;
    for(const item of [incoming,reply,child])expect((await state(item.id)).thread_id).toBe(target);
    expect(await state(reply.id)).toMatchObject({folder:'archive',filing_version:'8'});
    expect((await pool.query('SELECT deleted_at,sha256 FROM deliveries WHERE id=$1',[child.id])).rows[0]).toMatchObject({sha256:child.sha,deleted_at:expect.any(Date)});
    expect(await relation(reply.id)).toBeUndefined();expect(await relation(child.id)).toBeUndefined();
    expect((await pool.query('SELECT 1 FROM mail_message_state WHERE mailbox_id=$1 AND thread_id=$2',[mailbox,incoming.threadId])).rowCount).toBe(0);
    const sequence=(await pool.query('SELECT change_sequence FROM mailboxes WHERE id=$1',[mailbox])).rows[0].change_sequence;
    await reconcile(sent.id);expect((await pool.query('SELECT change_sequence FROM mailboxes WHERE id=$1',[mailbox])).rows[0].change_sequence).toBe(sequence);
  });

  it.each(['foreign-reference','missing-headers','unresolved-ancestor','third-wire-claim','ambiguous-child'])('moves only the exact copy if its early branch has %s',async defect=>{
    const incoming=await put();
    let foreign:Awaited<ReturnType<typeof put>>|undefined;
    if(defect==='foreign-reference')foreign=await put({own:'<foreign-root@example.test>',body:'Foreign root'});
    const refs=defect==='foreign-reference'?['<foreign-root@example.test>',wire]:defect==='unresolved-ancestor'?['<missing-root@example.test>',wire]:[wire];
    const reply=await put({own:'<prior-reply@example.test>',body:'Prior reply',references:refs});
    if(defect==='missing-headers')await pool.query('DELETE FROM mail_thread_headers WHERE message_id=$1',[reply.id]);
    if(defect==='third-wire-claim')await put({body:'Unrelated same-wire-ID claim'});
    if(defect==='ambiguous-child')await pool.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2',[mailbox,'prior-reply@example.test']);
    const sent=await put({outbound:true});const target=(await state(sent.id)).thread_id;
    expect((await state(incoming.id)).thread_id).toBe(target);expect((await state(reply.id)).thread_id).toBe(incoming.threadId);
    expect(target).not.toBe(incoming.threadId);if(foreign)expect((await state(foreign.id)).thread_id).toBe(foreign.threadId);
    expect(await relation(reply.id)).toBeUndefined();
  });

  it('fails closed when a candidate branch exceeds its 100-member proof budget',async()=>{
    const incoming=await put();let last:Awaited<ReturnType<typeof put>>|undefined;
    for(let i=0;i<100;i++)last=await put({own:`<budget-${i}@example.test>`,body:`Reply ${i}`,references:[wire]});
    const sent=await put({outbound:true});expect((await state(incoming.id)).thread_id).toBe((await state(sent.id)).thread_id);
    expect((await state(last!.id)).thread_id).toBe(incoming.threadId);
    expect((await pool.query('SELECT count(*) AS n FROM mail_message_state WHERE mailbox_id=$1 AND thread_id=$2',[mailbox,incoming.threadId])).rows[0].n).toBe('100');
  },20000);

  it('does not guess between two accepted Sent identities with the same wire ID',async()=>{
    await put({outbound:true});await put({outbound:true,own:'<second-sent@example.test>'});
    const incoming=await put();expect(await relation(incoming.id)).toBeUndefined();expect(await key()).toMatchObject({ambiguous:true});
  });

  it('retains legacy unproven ambiguity while still grouping verified content',async()=>{
    const incoming=await put();await pool.query('UPDATE mail_thread_keys SET ambiguous=true,ambiguity_unproven=true WHERE mailbox_id=$1 AND token=$2',[mailbox,token(wire)]);
    const sent=await put({outbound:true});expect(await relation(incoming.id)).toMatchObject({sent_message_id:sent.id});
    expect((await state(incoming.id)).thread_id).toBe((await state(sent.id)).thread_id);expect(await key()).toMatchObject({ambiguous:true,ambiguity_unproven:true});
  });

  it('binds fingerprint storage to the full immutable raw tuple and rejects replacement evidence',async()=>{
    const incoming=await put();
    await expect(transaction(client=>storeMailContentFingerprint(client,{deliveryId:incoming.id,mailboxId:mailbox,version:1,sha256:incoming.fingerprint!.sha256,rawSha256:'f'.repeat(64),rawSize:incoming.raw.length}))).rejects.toThrow('mail_fingerprint_identity_conflict');
    await expect(transaction(client=>storeMailContentFingerprint(client,{deliveryId:incoming.id,mailboxId:mailbox,version:1,sha256:'f'.repeat(64),rawSha256:incoming.sha,rawSize:incoming.raw.length}))).rejects.toThrow('mail_fingerprint_identity_conflict');
  });

  it('is idempotent across reparse, concurrent reconciliation and bounded backfill pages',async()=>{
    const sent=await put({outbound:true});const incoming=await put();const before=(await pool.query('SELECT change_sequence FROM mailboxes WHERE id=$1',[mailbox])).rows[0].change_sequence;
    await Promise.all([reconcile(sent.id),reconcile(incoming.id)]);
    await transaction(client=>indexMessageThread(client,{mailboxId:mailbox,messageId:incoming.id,messageIdHeader:wire,parserVersion:3}));
    const page=await backfillVerifiedCopies(pool,{limit:1});expect(page.processed).toBe(1);expect(page.nextCursor).not.toBeNull();expect(await backfillVerifiedCopies(pool,{limit:1,afterDeliveryId:page.nextCursor!})).toMatchObject({processed:1,nextCursor:null});
    expect((await pool.query('SELECT change_sequence FROM mailboxes WHERE id=$1',[mailbox])).rows[0].change_sequence).toBe(before);
    expect((await pool.query('SELECT count(*) AS n FROM mail_verified_copies')).rows[0].n).toBe('1');
  });

  it('caps one logical group at Sent plus 99 inbound copies and leaves overflow ordinary',async()=>{
    const sent=await put({outbound:true});let overflow:Awaited<ReturnType<typeof put>>|undefined;
    for(let i=0;i<100;i++)overflow=await put({extra:`Received: synthetic transit ${i}\r\n`});
    expect((await pool.query('SELECT count(*) AS n FROM mail_verified_copies WHERE sent_message_id=$1',[sent.id])).rows[0].n).toBe('99');
    expect(await relation(overflow!.id)).toBeUndefined();expect((await state(overflow!.id)).thread_id).not.toBe((await state(sent.id)).thread_id);
    expect(await key()).toMatchObject({ambiguous:true});
  },20000);
});
