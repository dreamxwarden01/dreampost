import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg,{type PoolClient} from 'pg';
import Fastify from 'fastify';
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {hashRoutePolicy,type Draft,type MailTransport,type RoutePolicy} from '@dreampost/protocol';
import {migrate} from '../src/database.js';
import {AddressService} from '../src/addresses/service.js';
import type {Actor} from '../src/auth/service.js';
import {FileBlobStore} from '../src/blob-store.js';
import {ApiError} from '../src/errors.js';
import {OutboundService} from '../src/outbound/service.js';
import {runOneOutboundJob,recoverUnknownOutbound} from '../src/outbound/dispatcher.js';
import {registerOutboundRoutes,getOutboundMutationActivity} from '../src/outbound/routes.js';
import {releaseTerminalDraftStaging} from '../src/outbound/staging.js';
import {loadOutboundConfig} from '../src/outbound/config.js';
import {ProviderRejection} from '../src/outbound/provider.js';
import {digest} from '../src/outbound/validation.js';
import type {OutboundDependencies,ReplySource} from '../src/outbound/types.js';
const databaseUrl=process.env['TEST_DATABASE_URL'];
const config=loadOutboundConfig({OUTBOUND_PROVIDER:'cloudflare',OUTBOUND_CF_ACCOUNT_ID:'a'.repeat(32),OUTBOUND_CF_API_TOKEN:'synthetic-outbound-provider-test-token'});

describe.skipIf(!databaseUrl)('durable drafts and outgoing submission state',()=>{
 const schema=`outbound_${randomUUID().replaceAll('-','')}`,alice=randomUUID(),bob=randomUUID();
 let admin:pg.Pool,pool:pg.Pool,directory:string,blobs:FileBlobStore,addresses:AddressService,service:OutboundService,deps:OutboundDependencies,mailboxId:string,allocationId:string;
 let calls:Array<{recipients:string[];mime:Uint8Array}>,sources:Map<string,ReplySource>,sourceParts:Map<string,Uint8Array>,sentFail:boolean,clock:number;
 const resolve=async(id:string,client?:PoolClient,options?:{readOnly?:boolean}):Promise<Actor>=>{const db=client??pool;const row=(await db.query(`SELECT * FROM principals WHERE id=$1${client&&!options?.readOnly?' FOR UPDATE':''}`,[id])).rows[0];if(!row?.access_enabled)throw new ApiError(403,'application_access_denied');const permissions=new Set<string>((await db.query('SELECT permission FROM auth_role_permissions WHERE role_id=$1',[row.app_role])).rows.map(r=>r.permission));for(const r of(await db.query('SELECT permission,effect FROM auth_user_permission_overrides WHERE principal_id=$1',[id])).rows){if(r.effect==='deny')permissions.delete(r.permission);else permissions.add(r.permission);}return{principalId:id,issuer:'https://sso.example.test',subject:id,username:row.username,roleId:row.app_role,permissions};};
 beforeAll(async()=>{admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,connectionTimeoutMillis:5000});await migrate(pool);directory=await mkdtemp(join(tmpdir(),'dreampost-outbound-'));blobs=new FileBlobStore(directory);});
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}if(directory)await rm(directory,{recursive:true,force:true});});
 beforeEach(async()=>{
  await pool.query('TRUNCATE mailboxes,principals,attachment_objects CASCADE');sources=new Map();sourceParts=new Map();calls=[];sentFail=false;clock=Date.now();
  for(const[id,name]of[[alice,'alice'],[bob,'bob']])await pool.query('INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled) VALUES($1,$2,$4,$3,1,true)',[id,'https://sso.example.test',name,id]);
  addresses=new AddressService(pool,{defaultDomain:'example.test',managedDomains:['example.test']},resolve);await addresses.provisionFirstMailbox(alice);
  const allocation=(await addresses.listForActor(alice)).addresses[0]!;mailboxId=allocation.mailboxId;allocationId=allocation.allocationId;await acknowledge();
  const transport:MailTransport={capabilities:{maxMessageBytes:5*1024*1024,maxRecipients:50,supportsIdempotencyKey:false},send:async input=>{calls.push({recipients:input.recipients,mime:input.mime});return{providerMessageId:'provider-fixture',recipients:input.recipients.map(address=>({address,status:'accepted' as const,code:'cf_queued'}))};}};
  deps={resolvePrincipal:resolve,listSendingIdentities:id=>addresses.listSendingIdentities(id),selfAddresses:async()=>['alice@example.test','old-alice@example.test'],blobs,transport,now:()=>clock,
   loadSource:async(client,actorId,box,id)=>{const visible=await client.query(`SELECT 1 FROM deliveries d JOIN mailbox_memberships mm ON mm.mailbox_id=d.mailbox_id WHERE d.id=$1 AND d.mailbox_id=$2 AND d.deleted_at IS NULL AND mm.principal_id=$3 AND mm.revoked_at IS NULL AND 'read'=ANY(mm.permissions)`,[id,box,actorId]);const source=sources.get(id);if(!visible.rowCount||!source)throw new ApiError(404,'source_not_found');return structuredClone(source);},
   copyAttachment:async(_actor,_box,messageId,attachmentId)=>{const source=sources.get(messageId)!,item=source.attachments.find(a=>a.id===attachmentId)!,bytes=sourceParts.get(attachmentId)!;return{bytes,...item,sourceContentVersion:source.contentVersion,sourceSha256:source.sourceSha256};},
   withSenderAdmission:(input,work)=>addresses.withSenderAdmission(input,work),
   prepareSent:async snapshot=>({rawSha256:snapshot.rawSha256,rawSize:snapshot.rawSize,parsed:{} as any,contentFingerprint:null}),
   persistSent:async(client,s)=>{if(sentFail)throw new Error('Synthetic Sent index outage');await client.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,direction,parse_status,subject) VALUES($1,$2,$3,$4,$5,$6,'outbound','parsed',$7) ON CONFLICT(id) DO NOTHING`,[s.submissionId,s.mailboxId,{kind:'outbound',submissionId:s.submissionId},s.rawSha256,s.rawSize,s.date,s.subject]);return s.submissionId;}};
  service=new OutboundService(pool,config,deps);
 });
 async function acknowledge(){const policy=(await pool.query<{payload:RoutePolicy}>('SELECT payload FROM address_policy_history ORDER BY created_at DESC LIMIT 1')).rows[0]!.payload;await addresses.acknowledgePolicy({version:1,operationId:policy.operationId,address:policy.address,revision:policy.revision,sha256:await hashRoutePolicy(policy),status:'applied'});}
 async function create(){return service.createDraft(alice,mailboxId,{mode:'new',fromAllocationId:allocationId,mutationKey:randomUUID()});}
 async function editable(recipients=['recipient@external.test']){const draft=await create();return service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),to:recipients.map(address=>({name:'',address})),subject:'Synthetic test',bodyText:'Only new content'});}
 async function submit(draft:Draft,extra:Record<string,unknown>={}){return service.submit(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),...extra});}
 async function source(extra:Partial<ReplySource>={},withPart=false){const id=randomUUID();await pool.query('INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at) VALUES($1,$2,$3,$4,1,now())',[id,mailboxId,{},'a'.repeat(64)]);const value:ReplySource={messageId:id,mailboxId,direction:'inbound',contentVersion:'a'.repeat(64)+':2',sourceSha256:'a'.repeat(64),from:[{name:'Sender',address:'sender@external.test'}],replyTo:[{name:'Reply',address:'reply@external.test'}],to:[{name:'',address:'old-alice@example.test'},{name:'',address:'person@external.test'}],cc:[{name:'',address:'copy@external.test'}],subject:'Original',sentAt:'2026-09-27T10:00:00Z',text:'Original quote',messageIdHeader:'<parent@external.test>',inReplyTo:[],references:[],envelopeTo:'alice@example.test',attachments:[],...extra};
  if(withPart){const attachmentId=randomUUID(),bytes=Buffer.from('%PDF-1.7\nOpaque fixture'),sha256=digest(bytes);await pool.query("INSERT INTO attachment_objects(id,sha256,size_bytes,object_key,state,preview_kind,media_type) VALUES($1,$2,$3,$4,'queued','pdf','application/pdf')",[attachmentId,sha256,bytes.length,`attachments/${attachmentId}/${sha256}`]);value.attachments=[{id:attachmentId,filename:'source.pdf',mimeType:'application/pdf',sizeBytes:bytes.length,sha256}];sourceParts.set(attachmentId,bytes);}
  sources.set(id,value);return value;
 }


 it.each(['partial','unknown'] as const)('records provider RFC identity only when %s outcomes contain an accepted recipient',async(outcome)=>{
  const wire='<Outcome.Case@example.test>';
  deps.transport!.send=async input=>{calls.push({recipients:input.recipients,mime:input.mime});return{providerMessageId:wire,rfcMessageId:wire,
    recipients:input.recipients.map((address,index)=>({address,status:outcome==='unknown'?'unknown' as const:index===0?'accepted' as const:'failed' as const}))};};
  const submission=await submit(await editable(['first@external.test','second@external.test']));
  await runOneOutboundJob(service);
  expect((await pool.query('SELECT state,rfc_message_id,provider_message_id,sent_copy_state FROM outbound_submissions WHERE id=$1',[submission.id])).rows[0])
   .toEqual({state:outcome,rfc_message_id:outcome==='partial'?wire:null,provider_message_id:wire,sent_copy_state:outcome==='partial'?'pending':'none'});
  await runOneOutboundJob(service);await runOneOutboundJob(service);expect(calls).toHaveLength(1);
  expect((await service.getSubmission(alice,mailboxId,submission.id)).state).toBe(outcome);
 });
 it('persists only explicit accepted RFC identity before retryable Sent work, without changing frozen raw MIME',async()=>{
  const wire='<Provider.Case@example.test>';
  deps.transport!.send=async input=>{calls.push({recipients:input.recipients,mime:input.mime});return{providerMessageId:wire,rfcMessageId:wire,recipients:input.recipients.map(address=>({address,status:'accepted' as const}))};};
  const draft=await editable(),submission=await submit(draft);const before=(await pool.query('SELECT snapshot,raw_sha256,raw_size FROM outbound_submissions WHERE id=$1',[submission.id])).rows[0];
  const persist=vi.spyOn(deps,'persistSent');sentFail=true;
  await runOneOutboundJob(service);
  expect((await pool.query('SELECT rfc_message_id,state,sent_copy_state FROM outbound_submissions WHERE id=$1',[submission.id])).rows[0]).toEqual({rfc_message_id:wire,state:'accepted',sent_copy_state:'pending'});
  await runOneOutboundJob(service);expect(persist.mock.calls[0]![1].rfcMessageId).toBe(wire);expect(calls).toHaveLength(1);
  expect((await pool.query('SELECT snapshot,raw_sha256,raw_size FROM outbound_submissions WHERE id=$1',[submission.id])).rows[0]).toEqual(before);
  const raw=await blobs.get(before.raw_sha256);expect(raw.toString()).toContain(`Message-ID: ${before.snapshot.messageIdHeader}`);expect(raw.toString()).not.toContain(wire);
  deps.transport!.send=async input=>({providerMessageId:wire,recipients:input.recipients.map(address=>({address,status:'accepted' as const}))});
  const opaque=await submit(await editable());await runOneOutboundJob(service);
  expect((await pool.query('SELECT rfc_message_id,state FROM outbound_submissions WHERE id=$1',[opaque.id])).rows[0]).toEqual({rfc_message_id:null,state:'accepted'});
 });
 it('sanitizes inherited header presentation at code-point boundaries and preserves unsupported address chips through autosave',async()=>{
  const longAddress='\u540d'.repeat(250)+'@external.test';
  const original=await source({subject:'\t'+ '\u{1f642}'.repeat(310),cc:[{name:'Long\t'+ '\u{1f642}'.repeat(180),address:longAddress}]});
  let draft=await service.createDraft(alice,mailboxId,{mode:'reply_all',sourceMessageId:original.messageId,mutationKey:randomUUID()});
  expect(Buffer.byteLength(draft.subject)).toBeLessThanOrEqual(998);expect(draft.subject).not.toMatch(/[\x00-\x1f\x7f\ud800-\udfff]/u);
  expect(Buffer.byteLength(draft.cc[1]!.name)).toBeLessThanOrEqual(512);expect(draft.cc[1]!.address).toBe(longAddress);
  expect(draft.warnings).toEqual(expect.arrayContaining(['seeded_subject_adjusted','seeded_recipient_name_adjusted','recipient_review_required']));
  draft=await service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),to:draft.to,cc:draft.cc,bcc:draft.bcc,subject:draft.subject,bodyText:'This body must save',includeQuote:true,fromAllocationId:draft.fromAllocationId});
  expect(draft.bodyText).toBe('This body must save');expect(draft.cc[1]!.address).toBe(longAddress);
  await expect(submit(draft)).rejects.toMatchObject({code:'invalid_recipient_address'});
  await expect(service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),subject:'bad\tvalue'})).rejects.toMatchObject({code:'invalid_subject'});
 });
 it('reclaims superseded patch receipts before the shared receipt cap while preserving create and send replay',async()=>{
  const createKey=randomUUID();let draft=await service.createDraft(alice,mailboxId,{mode:'new',fromAllocationId:allocationId,mutationKey:createKey});
  const first={expectedVersion:draft.version,mutationKey:randomUUID(),to:[{name:'',address:'recipient@external.test'}],bodyText:'First'};
  draft=await service.patchDraft(alice,mailboxId,draft.id,first);
  await pool.query(`INSERT INTO outbound_mutations(mailbox_id,author_principal_id,mutation_key,request_sha256,response,action,target_id)
    SELECT $1,$2,gen_random_uuid(),repeat('0',64),'{"kind":"draft"}'::jsonb,'patch',$3 FROM generate_series(1,20000-(SELECT count(*)::integer FROM outbound_mutations WHERE author_principal_id=$2))`,[mailboxId,alice,draft.id]);
  for(let i=0;i<30;i++)draft=await service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),bodyText:`Saved ${i}`});
  expect((await pool.query('SELECT action,count(*) FROM outbound_mutations GROUP BY action ORDER BY action')).rows).toEqual([{action:'create',count:'1'},{action:'patch',count:'1'}]);
  await expect(service.patchDraft(alice,mailboxId,draft.id,first)).rejects.toMatchObject({code:'draft_version_conflict'});
  const send={expectedVersion:draft.version,mutationKey:randomUUID()},queued=await service.submit(alice,mailboxId,draft.id,send);
  expect((await service.submit(alice,mailboxId,draft.id,send)).id).toBe(queued.id);
  expect((await pool.query('SELECT count(*) FROM outbound_mutations WHERE mutation_key=$1',[createKey])).rows[0].count).toBe('1');
 });
 it('keeps replies and copied files usable after a parser-version change but rejects changed raw identity or source tuples',async()=>{
  const original=await source({},true);
  const reply=await service.createDraft(alice,mailboxId,{mode:'reply',sourceMessageId:original.messageId,mutationKey:randomUUID()});
  let forward=await service.createDraft(alice,mailboxId,{mode:'forward',sourceMessageId:original.messageId,mutationKey:randomUUID()});
  forward=await service.patchDraft(alice,mailboxId,forward.id,{expectedVersion:forward.version,mutationKey:randomUUID(),to:[{name:'',address:'forward@external.test'}]});
  // Legacy quotes without the new field still bind to the raw-sha prefix, never parser policy.
  await pool.query("UPDATE outbound_drafts SET quote=quote-'sourceSha256' WHERE id=$1",[reply.id]);
  sources.set(original.messageId,{...original,contentVersion:original.sourceSha256+':3:new-policy'});
  expect((await submit(reply)).state).toBe('queued');expect((await submit(forward)).state).toBe('queued');
  expect((await service.duplicateDraft(alice,mailboxId,forward.id,{mutationKey:randomUUID()})).attachments[0]!.sha256).toBe(original.attachments[0]!.sha256);
  sources.set(original.messageId,{...original,sourceSha256:'b'.repeat(64)});
  await expect(service.duplicateDraft(alice,mailboxId,forward.id,{mutationKey:randomUUID()})).rejects.toMatchObject({code:'source_message_changed'});
  sources.set(original.messageId,{...original,attachments:original.attachments.map(item=>({...item,filename:'changed.pdf'}))});
  await expect(service.duplicateDraft(alice,mailboxId,forward.id,{mutationKey:randomUUID()})).rejects.toMatchObject({code:'source_attachment_changed'});
 });
 it('reads private drafts and outbox without waiting for exclusive principal, mailbox, draft or submission locks',async()=>{
  const draft=await editable(),queued=await submit(draft),blocker=await pool.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM principals WHERE id=$1 FOR UPDATE',[alice]);await blocker.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[mailboxId]);await blocker.query('SELECT id FROM outbound_drafts WHERE id=$1 FOR UPDATE',[draft.id]);await blocker.query('SELECT id FROM outbound_submissions WHERE id=$1 FOR UPDATE',[queued.id]);
   const reads=Promise.all([service.getDraft(alice,mailboxId,draft.id),service.listDrafts(alice,mailboxId),service.getSubmission(alice,mailboxId,queued.id),service.listOutbox(alice,mailboxId)]);
   await expect(Promise.race([reads,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Read waited for exclusive locks')),750))])).resolves.toHaveLength(4);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
 });
 it('does not hold hot write locks while restoring released draft MIME and rechecks an intervening draft change',async()=>{
  let draft=await editable();draft=await service.addAttachment(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),filename:'restore.bin'},Buffer.from('Restored bytes'));
  await submit(draft);await runOneOutboundJob(service);await runOneOutboundJob(service);await releaseTerminalDraftStaging(service);
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;}),real=blobs.get.bind(blobs);
  const spy=vi.spyOn(blobs,'get').mockImplementation(async sha=>{started();await gate;return real(sha);});
  const pending=service.duplicateDraft(alice,mailboxId,draft.id,{mutationKey:randomUUID()});
  try{await ready;const check=await pool.connect();try{await check.query('BEGIN');await check.query("SET LOCAL lock_timeout='500ms'");await check.query('UPDATE principals SET username=username WHERE id=$1',[alice]);await check.query('UPDATE mailboxes SET name=name WHERE id=$1',[mailboxId]);await check.query('UPDATE outbound_drafts SET version=version+1 WHERE id=$1',[draft.id]);await check.query('COMMIT');}finally{check.release();}
   expect((await service.listOutbox(alice,mailboxId))).toHaveLength(1);release();await expect(pending).rejects.toMatchObject({code:'draft_version_conflict'});
  }finally{release();spy.mockRestore();}
 });
 it('prepares Sent MIME outside mailbox locks and never retries the provider during delayed preparation',async()=>{
  const queued=await submit(await editable());await runOneOutboundJob(service);
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;}),real=deps.prepareSent;
  deps.prepareSent=async input=>{started();await gate;return real(input);};const pending=runOneOutboundJob(service);
  try{await ready;const check=await pool.connect();try{await check.query('BEGIN');await check.query("SET LOCAL lock_timeout='500ms'");await check.query('UPDATE mailboxes SET name=name WHERE id=$1',[mailboxId]);await check.query('COMMIT');}finally{check.release();}
   expect((await service.getSubmission(alice,mailboxId,queued.id)).sentCopyState).toBe('pending');release();await pending;
   expect((await service.getSubmission(alice,mailboxId,queued.id)).sentCopyState).toBe('done');expect(calls).toHaveLength(1);
  }finally{release();deps.prepareSent=real;}
 });
 it('derives ordinary upload MIME types from bytes and ignores misleading filenames or client type claims',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=','base64');
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.statusCode:500).send({error:error instanceof ApiError?error.code:'fixture_error'}));registerOutboundRoutes(app,service,async(_request,options)=>resolve(alice,options.client,{readOnly:options.readOnly}));
  try{let draft=await editable();for(const [filename,bytes,type]of [['photo.bin',png,'image/png'],['document.bin',Buffer.from('%PDF-1.7\nOpaque fixture'),'application/pdf'],['pretend.png',Buffer.from('<svg>not a raster</svg>'),'application/octet-stream']] as const){
    const response=await app.inject({method:'POST',url:`/api/mailboxes/${mailboxId}/drafts/${draft.id}/attachments`,headers:{'content-type':'application/octet-stream','x-draft-version':String(draft.version),'x-mutation-key':randomUUID(),'x-attachment-filename':filename,'x-attachment-type':'image/png'},payload:bytes});expect(response.statusCode).toBe(200);draft=response.json().draft;expect(draft.attachments.at(-1)!.mimeType).toBe(type);
   }await submit(draft);await runOneOutboundJob(service);const mime=Buffer.from(calls[0]!.mime).toString();expect(mime).toContain('Content-Type: image/png');expect(mime).toContain('Content-Type: application/pdf');expect(mime).toContain('Content-Type: application/octet-stream');
  }finally{await app.close();}
 });
 it('keeps action and resource identity authoritative when hashing untrusted mutation inputs',async()=>{
  let draft=await editable();draft=await service.addAttachment(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),filename:'first.bin'},Buffer.from('First'));draft=await service.addAttachment(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),filename:'second.bin'},Buffer.from('Second'));
  const key=randomUUID(),first=draft.attachments[0]!.id,second=draft.attachments[1]!.id,input={expectedVersion:draft.version,mutationKey:key,action:'patch',id:randomUUID(),attachmentId:first};
  await service.removeAttachment(alice,mailboxId,draft.id,first,input);
  await expect(service.removeAttachment(alice,mailboxId,draft.id,second,input)).rejects.toMatchObject({code:'mutation_key_conflict'});
  expect((await pool.query('SELECT action,target_id FROM outbound_mutations WHERE mutation_key=$1',[key])).rows[0]).toEqual({action:'remove_attachment',target_id:draft.id});
 });

 it('releases published staging after durable Sent copy and rebuilds an exact new owned draft from frozen MIME',async()=>{
  const part=Buffer.from('Recoverable owned bytes'),tight=new OutboundService(pool,{...config,maxDraftStorageBytes:part.length},deps);
  let draft=await editable();draft=await tight.addAttachment(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),filename:'recover.bin'},part);
  const oldPart=draft.attachments[0]!,sub=await tight.submit(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID()});
  await runOneOutboundJob(tight);await runOneOutboundJob(tight);await runOneOutboundJob(tight);
  expect((await tight.getSubmission(alice,mailboxId,sub.id)).sentCopyState).toBe('done');
  expect((await pool.query('SELECT bytes,released_at FROM outbound_draft_attachments WHERE id=$1',[oldPart.id])).rows[0].bytes).toBeNull();
  const copy=await tight.duplicateDraft(alice,mailboxId,draft.id,{mutationKey:randomUUID()});expect(copy.attachments[0]!.id).not.toBe(oldPart.id);expect(copy.attachments[0]!.sha256).toBe(oldPart.sha256);
  expect((await pool.query('SELECT bytes FROM outbound_draft_attachments WHERE id=$1',[copy.attachments[0]!.id])).rows[0].bytes).toEqual(part);
  expect(Number((await pool.query('SELECT COALESCE(sum(size_bytes),0) AS total FROM outbound_draft_attachments WHERE bytes IS NOT NULL')).rows[0].total)).toBe(part.length);
  expect(calls).toHaveLength(1);
 });
 it('warns when duplicating a still-queued intent and retains all unknown recovery bytes',async()=>{
  let draft=await editable();draft=await service.addAttachment(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),filename:'retain.bin'},Buffer.from('Unknown recovery bytes'));
  const sub=await submit(draft),copy=await service.duplicateDraft(alice,mailboxId,draft.id,{mutationKey:randomUUID()});expect(copy.warnings).toContain('duplicate_delivery_possible');
  deps.transport!.send=async()=>{throw new Error('Lost provider response');};await runOneOutboundJob(service);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('unknown');
  expect(await releaseTerminalDraftStaging(service)).toBe(false);expect((await pool.query('SELECT bytes FROM outbound_draft_attachments WHERE draft_id=$1',[draft.id])).rows[0].bytes).not.toBeNull();
 });
 it('keeps published staging and accepted status intact if the immutable MIME cannot be verified for cleanup',async()=>{
  let draft=await editable();draft=await service.addAttachment(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),filename:'safe.bin'},Buffer.from('Keep on cleanup failure'));
  const sub=await submit(draft);await runOneOutboundJob(service);await runOneOutboundJob(service);
  const spy=vi.spyOn(blobs,'get').mockResolvedValueOnce(Buffer.from('mismatched frozen MIME'));
  try{expect(await releaseTerminalDraftStaging(service)).toBe(true);}finally{spy.mockRestore();}
  expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('accepted');expect((await pool.query('SELECT bytes FROM outbound_draft_attachments WHERE draft_id=$1',[draft.id])).rows[0].bytes).not.toBeNull();
 });
 it('preserves unsupported Reply-all recipients as editable chips instead of silently dropping them',async()=>{
  const original=await source({cc:[{name:'International',address:'\u540d@external.test'}]});const draft=await service.createDraft(alice,mailboxId,{mode:'reply_all',sourceMessageId:original.messageId,mutationKey:randomUUID()});
  expect(draft.cc.some(a=>a.address==='\u540d@external.test')).toBe(true);expect(draft.warnings).toContain('recipient_review_required');await expect(submit(draft)).rejects.toMatchObject({code:'invalid_recipient_address'});
 });
 it('refuses a full mutation-receipt budget before writing compiled MIME',async()=>{
  const draft=await editable();
  await pool.query(`INSERT INTO outbound_mutations(mailbox_id,author_principal_id,mutation_key,request_sha256,response)
    SELECT $1,$2,gen_random_uuid(),repeat('0',64),'{"kind":"discard"}'::jsonb FROM generate_series(1,20000-(SELECT count(*)::integer FROM outbound_mutations WHERE author_principal_id=$2))`,[mailboxId,alice]);
  const put=vi.spyOn(blobs,'put');try{await expect(submit(draft)).rejects.toMatchObject({code:'mutation_receipt_limit'});expect(put).not.toHaveBeenCalled();}finally{put.mockRestore();}
  expect((await service.getDraft(alice,mailboxId,draft.id)).state).toBe('editing');expect((await pool.query('SELECT count(*) FROM outbound_submissions')).rows[0].count).toBe('0');
 });

 it('bounds large-quote autosave receipts and lists only projected draft/outbox summaries',async()=>{
  const original=await source({text:'Large context '.repeat(12000)});let draft=await service.createDraft(alice,mailboxId,{mode:'reply',sourceMessageId:original.messageId,mutationKey:randomUUID()});
  const oldInput={expectedVersion:draft.version,mutationKey:randomUUID(),bodyText:'First edit'};
  draft=await service.patchDraft(alice,mailboxId,draft.id,oldInput);
  for(let i=0;i<20;i++)draft=await service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),bodyText:`Edit ${i}`});
  const receipts=(await pool.query('SELECT max(octet_length(response::text)) AS largest,sum(octet_length(response::text)) AS total FROM outbound_mutations')).rows[0];expect(Number(receipts.largest)).toBeLessThan(200);expect(Number(receipts.total)).toBeLessThan(5000);
  await expect(service.patchDraft(alice,mailboxId,draft.id,oldInput)).rejects.toMatchObject({code:'draft_version_conflict'});
  const listed=await service.listDrafts(alice,mailboxId);expect(listed[0]).toMatchObject({id:draft.id,attachmentCount:0,recipientCount:1});expect(listed[0]).not.toHaveProperty('bodyText');expect(listed[0]).not.toHaveProperty('quote');
  const input={expectedVersion:draft.version,mutationKey:randomUUID()},sub=await service.submit(alice,mailboxId,draft.id,input);await runOneOutboundJob(service);
  expect((await service.submit(alice,mailboxId,draft.id,input)).state).toBe('accepted');
  const outbox=await service.listOutbox(alice,mailboxId);expect(JSON.stringify(outbox)).not.toContain('Large context');expect(outbox[0]!.id).toBe(sub.id);
  await pool.query("UPDATE outbound_mutations SET expires_at=now()-interval '1 second' WHERE mutation_key=$1",[input.mutationKey]);
  await expect(service.submit(alice,mailboxId,draft.id,input)).rejects.toMatchObject({code:'draft_version_conflict'});expect((await pool.query('SELECT count(*) FROM outbound_submissions')).rows[0].count).toBe('1');
 });
 it('normalizes internationalized self domains but preserves reassigned and foreign case-sensitive recipients',async()=>{
  deps.selfAddresses=async()=>['alice@xn--bcher-kva.example'];const original=await source({to:[{name:'Self',address:'ALICE@b\u00fccher.example'},{name:'Upper',address:'Case@foreign.test'},{name:'Lower',address:'case@foreign.test'},{name:'New owner',address:'former@example.test'}],cc:[],envelopeTo:'alice@xn--bcher-kva.example'});
  const draft=await service.createDraft(alice,mailboxId,{mode:'reply_all',sourceMessageId:original.messageId,mutationKey:randomUUID()});expect(draft.cc.map(a=>a.address)).toEqual(['Case@foreign.test','case@foreign.test','former@example.test']);expect(draft.warnings).not.toContain('reply_all_not_visible');
 });
 it('does not publish MIME when the final draft CAS loses to an autosave',async()=>{
  const draft=await editable(),put=vi.spyOn(blobs,'put'),real=deps.withSenderAdmission;
  deps.withSenderAdmission=async(input,work)=>{await service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),bodyText:'Newer unsent words'});return real(input,work);};
  try{await expect(submit(draft)).rejects.toMatchObject({code:'draft_version_conflict'});expect(put).not.toHaveBeenCalled();expect((await pool.query('SELECT count(*) FROM outbound_submissions')).rows[0].count).toBe('0');}finally{put.mockRestore();}
 });
 it('serializes per-author attachment budget reservations across independent drafts',async()=>{
  const a=await create(),b=await create(),small=new OutboundService(pool,{...config,maxDraftStorageBytes:5},deps);
  const results=await Promise.allSettled([small.addAttachment(alice,mailboxId,a.id,{expectedVersion:a.version,mutationKey:randomUUID(),filename:'a.bin'},Buffer.from('abc')),small.addAttachment(alice,mailboxId,b.id,{expectedVersion:b.version,mutationKey:randomUUID(),filename:'b.bin'},Buffer.from('def'))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await pool.query('SELECT sum(size_bytes) AS total FROM outbound_draft_attachments')).rows[0].total).toBe('3');
 });
 it('does not resend after provider acceptance followed by a local outcome commit failure',async()=>{
  const sub=await submit(await editable());await pool.query("ALTER TABLE outbound_attempts ADD CONSTRAINT fixture_refuse_result CHECK(state<>'completed')");
  try{await expect(runOneOutboundJob(service)).rejects.toThrow();}finally{await pool.query('ALTER TABLE outbound_attempts DROP CONSTRAINT fixture_refuse_result');}
  expect(calls).toHaveLength(1);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('dispatching');
  await pool.query("UPDATE outbound_attempts SET expires_at=now()-interval '1 second'");clock=Date.now();await runOneOutboundJob(service);expect(calls).toHaveLength(1);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('unknown');
 });
 it('holds pre-body mutation capacity through active handler aborts and releases exactly once',async()=>{
  const original=await source({},true),a=await create(),b=await create();let release!:()=>void,started=0,parses=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});const real=deps.copyAttachment;deps.copyAttachment=async(...args)=>{started++;await gate;return real(...args);};
  const app=Fastify(),requests:any[]=[];
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.statusCode:400).send({error:error instanceof ApiError?error.code:'invalid_request'}));
  app.addHook('preParsing',async()=>{parses++;});app.addHook('preHandler',async request=>{requests.push(request);});
  registerOutboundRoutes(app,service,async(_request,options)=>resolve(alice,options.client,{readOnly:options.readOnly}));
  const copy=(draft:Draft)=>app.inject({method:'POST',url:`/api/mailboxes/${mailboxId}/drafts/${draft.id}/attachments/copy`,payload:{expectedVersion:draft.version,mutationKey:randomUUID(),sourceMailboxId:mailboxId,sourceMessageId:original.messageId,sourceAttachmentId:original.attachments[0]!.id}});
  try{
    const first=copy(a),second=copy(b);const running=Promise.all([first,second]);
    for(let i=0;started<2&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));expect(started).toBe(2);expect(getOutboundMutationActivity().active).toBe(2);
    requests[0].raw.emit('aborted');expect(getOutboundMutationActivity().active).toBe(2);
    const rejected=await app.inject({method:'POST',url:`/api/mailboxes/${mailboxId}/drafts`,headers:{'content-type':'application/json'},payload:'{bad json'});expect(rejected.statusCode).toBe(429);expect(rejected.headers['retry-after']).toBe('1');expect(parses).toBe(2);
    release();expect((await running).map(result=>result.statusCode)).toEqual([200,200]);expect(getOutboundMutationActivity().active).toBe(0);
    await app.inject({method:'POST',url:`/api/mailboxes/${mailboxId}/drafts`,headers:{'content-type':'application/json'},payload:'{bad json'});expect(getOutboundMutationActivity().active).toBe(0);
  }finally{release();await app.close();}
 });

 it('owns drafts by author, stores incomplete recipients, and atomically refuses stale or missing versions',async()=>{
  const draft=await create();const key=randomUUID(),input={expectedVersion:draft.version,mutationKey:key,to:[{name:'',address:'unfinished@'}]};const updated=await service.patchDraft(alice,mailboxId,draft.id,input);expect(updated.to[0]!.address).toBe('unfinished@');expect(await service.patchDraft(alice,mailboxId,draft.id,input)).toEqual(updated);
  await expect(service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:1,mutationKey:randomUUID(),bodyText:'stale'})).rejects.toMatchObject({statusCode:409});await expect(service.patchDraft(alice,mailboxId,draft.id,{mutationKey:randomUUID(),bodyText:'missing version'})).rejects.toMatchObject({statusCode:400});await expect(submit(updated)).rejects.toMatchObject({code:'invalid_recipient_address'});
  await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read','send_as'])",[mailboxId,bob]);await expect(service.getDraft(bob,mailboxId,draft.id)).rejects.toMatchObject({statusCode:404});
 });
 it('builds blank replies with historical self exclusion, specific-person targeting and Sent follow-up recipients',async()=>{
  const original=await source();const reply=await service.createDraft(alice,mailboxId,{mode:'reply_all',sourceMessageId:original.messageId,mutationKey:randomUUID()});expect(reply.bodyText).toBe('');expect(reply.quote?.text).toBe('Original quote');expect(reply.to.map(a=>a.address)).toEqual(['reply@external.test']);expect(reply.cc.map(a=>a.address)).toEqual(['person@external.test','copy@external.test']);expect(reply.bcc).toEqual([]);
  const person=await service.createDraft(alice,mailboxId,{mode:'reply_person',sourceMessageId:original.messageId,replyPerson:{name:'One',address:'one@external.test'},mutationKey:randomUUID()});expect(person.to.map(a=>a.address)).toEqual(['one@external.test']);expect(person.cc).toEqual([]);
  sources.set(original.messageId,{...original,direction:'outbound',from:[{name:'',address:'alice@example.test'}],to:[{name:'',address:'original-to@external.test'}]});const followup=await service.createDraft(alice,mailboxId,{mode:'reply',sourceMessageId:original.messageId,mutationKey:randomUUID()});expect(followup.to[0]!.address).toBe('original-to@external.test');
 });
 it('requires an explicit not-visible warning acknowledgement before Reply all sends',async()=>{
  const original=await source({to:[{name:'',address:'list@external.test'}],cc:[]});const draft=await service.createDraft(alice,mailboxId,{mode:'reply_all',sourceMessageId:original.messageId,mutationKey:randomUUID()});expect(draft.warnings).toContain('reply_all_not_visible');await expect(submit(draft)).rejects.toMatchObject({code:'reply_all_confirmation_required'});expect((await submit(draft,{acknowledgeNotVisible:true})).state).toBe('queued');
 });
 it('atomically copies ordinary forward attachments and refuses unready or changed sources',async()=>{
  const original=await source({},true);const key=randomUUID();const forward=await service.createDraft(alice,mailboxId,{mode:'forward',sourceMessageId:original.messageId,mutationKey:key});expect(forward.attachments).toHaveLength(1);expect(forward.attachments[0]!.id).not.toBe(original.attachments[0]!.id);expect(forward.bodyText).toBe('');expect(await service.createDraft(alice,mailboxId,{mode:'forward',sourceMessageId:original.messageId,mutationKey:key})).toEqual(forward);
  sources.set(original.messageId,{...original,attachmentsReady:false});await expect(service.createDraft(alice,mailboxId,{mode:'forward',sourceMessageId:original.messageId,mutationKey:randomUUID()})).rejects.toMatchObject({code:'source_attachments_preparing'});
  await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1',[original.messageId]);await expect(submit(await service.patchDraft(alice,mailboxId,forward.id,{expectedVersion:forward.version,mutationKey:randomUUID(),to:[{name:'',address:'forward@external.test'}]}))).rejects.toMatchObject({statusCode:404});
 });
 it('idempotently uploads private bytes, rejects quota races and prevents edits after freezing',async()=>{
  const draft=await editable(),key=randomUUID(),part=Buffer.from('Attachment bytes'),input={expectedVersion:draft.version,mutationKey:key,filename:'file.txt'};const attached=await service.addAttachment(alice,mailboxId,draft.id,input,part);expect(await service.addAttachment(alice,mailboxId,draft.id,input,part)).toEqual(attached);expect((await pool.query('SELECT count(*) FROM outbound_draft_attachments')).rows[0].count).toBe('1');
  await expect(service.addAttachment(alice,mailboxId,draft.id,input,Buffer.from('other'))).rejects.toMatchObject({code:'mutation_key_conflict'});const sub=await submit(attached);await expect(service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:attached.version,mutationKey:randomUUID(),bodyText:'late'})).rejects.toMatchObject({statusCode:409});expect(sub.state).toBe('queued');
 });
 it('deduplicates concurrent Send requests and provider workers without exposing Bcc in MIME',async()=>{
  let draft=await editable();draft=await service.patchDraft(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID(),bcc:[{name:'Hidden',address:'hidden@external.test'}]});const input={expectedVersion:draft.version,mutationKey:randomUUID()};const submitted=await Promise.all([service.submit(alice,mailboxId,draft.id,input),service.submit(alice,mailboxId,draft.id,input)]);expect(submitted[0]!.id).toBe(submitted[1]!.id);await Promise.all([runOneOutboundJob(service),runOneOutboundJob(service)]);expect(calls).toHaveLength(1);expect(calls[0]!.recipients).toContain('hidden@external.test');expect(Buffer.from(calls[0]!.mime).toString()).not.toContain('hidden@external.test');
 });
 it.each(['local@example.test','outside@external.test'])('rechecks send authority for %s and never resurrects a paused snapshot',async recipient=>{
  const sub=await submit(await editable([recipient]));await addresses.setPause(alice,allocationId,'owner',true);await runOneOutboundJob(service);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('blocked');expect(calls).toHaveLength(0);await addresses.setPause(alice,allocationId,'owner',false);await acknowledge();await runOneOutboundJob(service);expect(calls).toHaveLength(0);
 });
 it('blocks revoked mail.send, mailbox send_as and current address grant at dispatch',async()=>{
  for(const kind of ['permission','membership','grant']){
   const sub=await submit(await editable());if(kind==='permission')await pool.query("INSERT INTO auth_user_permission_overrides(principal_id,permission,effect) VALUES($1,'mail.send','deny')",[alice]);if(kind==='membership')await pool.query("UPDATE mailbox_memberships SET permissions=ARRAY['read'] WHERE principal_id=$1",[alice]);if(kind==='grant')await pool.query('UPDATE address_send_grants SET revoked_at=now() WHERE allocation_id=$1',[allocationId]);
   await runOneOutboundJob(service);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('blocked');expect(calls).toHaveLength(0);
   await pool.query('DELETE FROM auth_user_permission_overrides');await pool.query("UPDATE mailbox_memberships SET permissions=ARRAY['read','send_as'] WHERE principal_id=$1",[alice]);await pool.query('UPDATE address_send_grants SET revoked_at=NULL WHERE allocation_id=$1',[allocationId]);
  }
 });
 it('stores uncertain outcomes without retry, and explicit duplicate makes a new editable intent only',async()=>{
  const draft=await editable(),sub=await submit(draft);deps.transport!.send=async input=>{calls.push({recipients:input.recipients,mime:input.mime});throw new Error('Response was lost after provider acceptance');};await runOneOutboundJob(service);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('unknown');await runOneOutboundJob(service);expect(calls).toHaveLength(1);const duplicate=await service.duplicateDraft(alice,mailboxId,draft.id,{mutationKey:randomUUID()});expect(duplicate.id).not.toBe(draft.id);expect(duplicate.state).toBe('editing');expect(duplicate.warnings).toContain('duplicate_delivery_possible');await expect(submit(duplicate)).rejects.toMatchObject({code:'duplicate_confirmation_required'});expect(calls).toHaveLength(1);
 });
 it('recovers a committed dispatch marker after a crash with zero provider calls, never replaying it',async()=>{
  const sub=await submit(await editable());const real=deps.withSenderAdmission;deps.withSenderAdmission=async(input,work)=>{const result=await real(input,work);if(result&&typeof result==='object'&&'attemptId'in result)throw new Error('Crash after commit');return result;};await runOneOutboundJob(service);expect(calls).toHaveLength(0);await pool.query("UPDATE outbound_attempts SET expires_at=now()-interval '1 second'");clock=Date.now();expect(await recoverUnknownOutbound(service)).toBe(1);deps.withSenderAdmission=real;await runOneOutboundJob(service);expect(calls).toHaveLength(0);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('unknown');
 });
 it('expires delayed admission starts without calling the provider',async()=>{
  const sub=await submit(await editable());const real=deps.withSenderAdmission;deps.withSenderAdmission=async(input,work)=>{const result=await real(input,work);if(result&&typeof result==='object'&&'attemptId'in result)clock+=5000;return result;};await runOneOutboundJob(service);expect(calls).toHaveLength(0);expect((await service.getSubmission(alice,mailboxId,sub.id)).errorCode).toBe('dispatch_start_expired');
 });
 it('allows revocation after committed admission without holding mailbox locks over provider I/O',async()=>{
  const sub=await submit(await editable());deps.transport!.send=async input=>{await addresses.setPause(alice,allocationId,'owner',true);calls.push({recipients:input.recipients,mime:input.mime});return{recipients:input.recipients.map(address=>({address,status:'accepted' as const}))};};await runOneOutboundJob(service);expect(calls).toHaveLength(1);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('accepted');
 });
 it('persists provider acceptance before retrying Sent copy, with no second external send',async()=>{
  const sub=await submit(await editable());sentFail=true;await runOneOutboundJob(service);await runOneOutboundJob(service);const pending=await service.getSubmission(alice,mailboxId,sub.id);expect(pending.state).toBe('accepted');expect(pending.sentCopyState).toBe('pending');expect(calls).toHaveLength(1);sentFail=false;await pool.query('UPDATE outbound_submissions SET available_at=now()');await runOneOutboundJob(service);expect((await service.getSubmission(alice,mailboxId,sub.id)).sentCopyState).toBe('done');expect(calls).toHaveLength(1);expect((await pool.query("SELECT direction,metadata->>'kind' AS kind FROM deliveries")).rows).toEqual([{direction:'outbound',kind:'outbound'}]);
 });
 it('retries only a definite provider rejection and rechecks authority for the next attempt',async()=>{
  const sub=await submit(await editable());let n=0;deps.transport!.send=async()=>{n++;throw new ProviderRejection('provider_throttled',true,1);};await runOneOutboundJob(service);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('queued');await pool.query('UPDATE outbound_submissions SET available_at=now()');await addresses.setReceiveOnly(alice,allocationId,true).catch(async()=>{await pool.query('UPDATE address_allocations SET receive_only=true,send_generation=send_generation+1 WHERE id=$1',[allocationId]);});await runOneOutboundJob(service);expect(n).toBe(1);expect((await service.getSubmission(alice,mailboxId,sub.id)).state).toBe('blocked');
 });
 it('cancels only pending versions and rejects raw unconfigured sending without freezing a draft',async()=>{
  const sub=await submit(await editable());await service.cancel(alice,mailboxId,sub.id,{expectedVersion:sub.version,mutationKey:randomUUID()});await runOneOutboundJob(service);expect(calls).toHaveLength(0);const draft=await editable();const disabled=new OutboundService(pool,{...config,enabled:false},deps);await expect(disabled.submit(alice,mailboxId,draft.id,{expectedVersion:draft.version,mutationKey:randomUUID()})).rejects.toMatchObject({code:'outbound_not_configured'});expect((await service.getDraft(alice,mailboxId,draft.id)).state).toBe('editing');
 });
 it('rechecks the HTTP source session after upload parsing and during source-copy work',async()=>{
  let alive=true,logoutBeforeHandler=false;const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.statusCode:500).send({error:error instanceof ApiError?error.code:'fixture_error'}));app.addHook('preHandler',async()=>{if(logoutBeforeHandler)alive=false;});
  registerOutboundRoutes(app,service,async(_request,options)=>{if(!alive)throw new ApiError(401,'authentication_required');return resolve(alice,options.client,{readOnly:options.readOnly});});
  try{const draft=await editable();logoutBeforeHandler=true;const result=await app.inject({method:'POST',url:`/api/mailboxes/${mailboxId}/drafts/${draft.id}/attachments`,headers:{'content-type':'application/octet-stream','x-draft-version':String(draft.version),'x-mutation-key':randomUUID(),'x-attachment-filename':'test.bin'},payload:Buffer.from('bytes')});expect(result.statusCode).toBe(401);expect((await service.getDraft(alice,mailboxId,draft.id)).attachments).toEqual([]);
   alive=true;logoutBeforeHandler=false;const original=await source({},true),real=deps.copyAttachment;deps.copyAttachment=async(...args)=>{const copied=await real(...args);alive=false;return copied;};const copied=await app.inject({method:'POST',url:`/api/mailboxes/${mailboxId}/drafts/${draft.id}/attachments/copy`,payload:{expectedVersion:draft.version,mutationKey:randomUUID(),sourceMailboxId:mailboxId,sourceMessageId:original.messageId,sourceAttachmentId:original.attachments[0]!.id}});expect(copied.statusCode).toBe(401);expect((await service.getDraft(alice,mailboxId,draft.id)).attachments).toEqual([]);
  }finally{await app.close();}
 });
});
