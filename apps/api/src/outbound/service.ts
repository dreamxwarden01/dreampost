import type { Pool, PoolClient } from 'pg';
import type { Draft, DraftSummary, DraftAttachment, DraftQuote, MailAddress, OutboxSubmission, ComposeMode } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
import { attachmentUuidV7 } from '../attachments/uuid.js';
import type { OutboundConfig } from './config.js';
import type { OutboundDependencies, ReplySource, SendSnapshot } from './types.js';
import { addressList, canonical, digest, normalizedAddress, references, requireId, requireVersion, safeFilename, seedHeader, sourceIdentity, text } from './validation.js';
import { restoreDraftParts, type OwnedDraftPart } from './staging.js';
import { inferUploadMimeType } from './upload-type.mjs';
import { composeMessage } from './mime.js';

interface MutationReceipt { kind:'draft'|'submission'|'discard'; id?:string; appliedVersion?:number }
const OUTBOX_SUMMARY_COLUMNS="id,mailbox_id,author_principal_id,draft_id,version,state,jsonb_build_object('from',snapshot->'from','to',snapshot->'to','cc',snapshot->'cc','bcc',snapshot->'bcc','subject',snapshot->'subject') AS snapshot,raw_sha256,raw_size,provider_message_id,error_code,sent_copy_state,sent_message_id,created_at,updated_at,queue_deadline,lease_id,current_attempt_id";
interface DraftRow { id:string;mailbox_id:string;author_principal_id:string;version:string;state:Draft['state'];mode:ComposeMode;source_message_id:string|null;from_allocation_id:string|null;to_recipients:MailAddress[];cc_recipients:MailAddress[];bcc_recipients:MailAddress[];subject:string;body_text:string;quote:DraftQuote|null;warnings:string[];updated_at:Date }
export interface SubmissionRow { id:string;mailbox_id:string;author_principal_id:string;draft_id:string;version:string;state:OutboxSubmission['state'];snapshot:SendSnapshot;raw_sha256:string|null;raw_size:number|null;provider_message_id:string|null;rfc_message_id:string|null;error_code:string|null;sent_copy_state:OutboxSubmission['sentCopyState'];sent_message_id:string|null;created_at:Date;updated_at:Date;queue_deadline:Date;lease_id:string|null;current_attempt_id:string|null }
export class OutboundService {
  readonly now:()=>number;
  constructor(readonly pool:Pool,readonly config:OutboundConfig,readonly deps:OutboundDependencies){this.now=deps.now??Date.now;}
  async actorTransaction<T>(principalId:string,mailboxId:string,mutating:boolean,work:(client:PoolClient)=>Promise<T>):Promise<T>{
    requireId(principalId);requireId(mailboxId);const client=await this.pool.connect();
    try{await client.query(mutating?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const initial=(await client.query<{owner_principal_id:string|null}>('SELECT owner_principal_id FROM mailboxes WHERE id=$1',[mailboxId])).rows[0];
      if(!initial)throw new ApiError(404,'mailbox_not_found');
      if(mutating)await client.query('SELECT id FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[...new Set([principalId,...(initial.owner_principal_id?[initial.owner_principal_id]:[])])].sort()]);
      const actor=await this.deps.resolvePrincipal(principalId,client,{readOnly:!mutating});
      if(!actor.permissions.has('mailbox.use')||(mutating&&!actor.permissions.has('mail.send')))throw new ApiError(403,'permission_denied');
      const mailbox=await client.query(`SELECT 1 FROM mailboxes WHERE id=$1 AND enabled AND owner_principal_id IS NOT DISTINCT FROM $2::uuid${mutating?' FOR UPDATE':''}`,[mailboxId,initial.owner_principal_id]);
      if(!mailbox.rowCount)throw new ApiError(404,'mailbox_not_found');
      const member=await client.query(`SELECT 1 FROM mailbox_memberships WHERE mailbox_id=$1 AND principal_id=$2 AND revoked_at IS NULL AND 'read'=ANY(permissions) AND ($3::boolean=false OR 'send_as'=ANY(permissions))`,[mailboxId,principalId,mutating]);
      if(!member.rowCount)throw new ApiError(404,'mailbox_not_found');
      const value=await work(client);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  private async recalled<T>(client:PoolClient,principalId:string,mailboxId:string,key:unknown,request:unknown):Promise<T|null>{
    const saved=(await client.query<{request_sha256:string;response:MutationReceipt}>('SELECT request_sha256,response FROM outbound_mutations WHERE mailbox_id=$1 AND author_principal_id=$2 AND mutation_key=$3 AND expires_at>now()',[mailboxId,principalId,requireId(key)])).rows[0];
    if(!saved)return null;if(saved.request_sha256!==digest(canonical(request)))throw new ApiError(409,'mutation_key_conflict');
    const receipt=saved.response;
    if(receipt.kind==='discard')return {ok:true} as T;
    if(receipt.kind==='submission')return await this.submissionView(client,await this.outboxRow(client,principalId,mailboxId,receipt.id!,false)) as T;
    const row=(await client.query<DraftRow>('SELECT * FROM outbound_drafts WHERE id=$1 AND mailbox_id=$2 AND author_principal_id=$3',[receipt.id,mailboxId,principalId])).rows[0];
    if(!row||row.state==='discarded'||Number(row.version)!==receipt.appliedVersion)throw new ApiError(409,'mutation_replayed_draft_changed');
    return await this.draftView(client,row) as T;
  }
  private async replay<T>(client:PoolClient,principalId:string,mailboxId:string,key:unknown,request:unknown,work:()=>Promise<T>):Promise<T>{
    const mutationKey=requireId(key),hash=digest(canonical(request));
    const saved=await this.recalled<T>(client,principalId,mailboxId,key,request);if(saved!==null)return saved;
    await client.query('DELETE FROM outbound_mutations WHERE author_principal_id=$1 AND expires_at<=now()',[principalId]);
    const action=String((request as {action?:unknown}).action),target=(request as {id?:unknown}).id;
    if(!['create','duplicate','patch','discard','attach','copy_attachment','remove_attachment','send','cancel'].includes(action))throw new Error('invalid_mutation_action');
    if(action==='patch')await client.query("DELETE FROM outbound_mutations WHERE author_principal_id=$1 AND mailbox_id=$2 AND action='patch' AND target_id=$3",[principalId,mailboxId,requireId(target)]);
    const usage=(await client.query<{count:string;bytes:string}>('SELECT count(*) AS count,COALESCE(sum(octet_length(response::text)+128),0) AS bytes FROM outbound_mutations WHERE author_principal_id=$1',[principalId])).rows[0]!;
    // Reserve the schema's worst-case compact receipt before work can persist immutable MIME.
    if(Number(usage.count)>=20000||Number(usage.bytes)+512+128>16*1024*1024)throw new ApiError(429,'mutation_receipt_limit');
    const response=await work();const value=response as Record<string,unknown>;
    const receipt:MutationReceipt='bodyText' in value?{kind:'draft',id:String(value.id),appliedVersion:Number(value.version)}
      :'sentCopyState' in value?{kind:'submission',id:String(value.id)}:{kind:'discard'};
    if(Buffer.byteLength(JSON.stringify(receipt))>512)throw new Error('invalid_compact_receipt');
    await client.query('INSERT INTO outbound_mutations(mailbox_id,author_principal_id,mutation_key,request_sha256,response,action,target_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[mailboxId,principalId,mutationKey,hash,receipt,action,typeof target==='string'?requireId(target):receipt.id??null]);return response;
  }
  private async row(client:PoolClient,principalId:string,mailboxId:string,id:string,version?:unknown,lock=true):Promise<DraftRow>{
    const row=(await client.query<DraftRow>(`SELECT * FROM outbound_drafts WHERE id=$1 AND mailbox_id=$2 AND author_principal_id=$3${lock?' FOR UPDATE':''}`,[requireId(id),mailboxId,principalId])).rows[0];
    if(!row||row.state==='discarded')throw new ApiError(404,'draft_not_found');
    if(version!==undefined&&(!Number.isSafeInteger(version)||Number(row.version)!==version||row.state!=='editing'))throw new ApiError(409,'draft_version_conflict');
    return row;
  }
  async draftView(client:PoolClient,row:DraftRow):Promise<Draft>{
    const {rows}=await client.query<{id:string;filename:string;mime_type:string;size_bytes:number;sha256:string}>('SELECT id,filename,mime_type,size_bytes,sha256 FROM outbound_draft_attachments WHERE draft_id=$1 ORDER BY created_at,id',[row.id]);
    return {id:row.id,mailboxId:row.mailbox_id,authorPrincipalId:row.author_principal_id,version:Number(row.version),state:row.state,mode:row.mode,sourceMessageId:row.source_message_id,fromAllocationId:row.from_allocation_id,
      to:row.to_recipients,cc:row.cc_recipients,bcc:row.bcc_recipients,subject:row.subject,bodyText:row.body_text,quote:row.quote,warnings:row.warnings,
      attachments:rows.map(a=>({id:a.id,filename:a.filename,mimeType:a.mime_type,sizeBytes:a.size_bytes,sha256:a.sha256})),updatedAt:row.updated_at.toISOString()};
  }
  private async updated(client:PoolClient,principalId:string,mailboxId:string,id:string,lock=true):Promise<Draft>{return this.draftView(client,await this.row(client,principalId,mailboxId,id,undefined,lock));}
  private async allocation(client:PoolClient,mailboxId:string,id:unknown):Promise<string|null>{
    if(id===null)return null;const value=requireId(id);
    if(!(await client.query('SELECT 1 FROM address_allocations WHERE id=$1 AND mailbox_id=$2 AND ended_at IS NULL',[value,mailboxId])).rowCount)throw new ApiError(400,'invalid_sender_allocation');return value;
  }
  async getDraft(principalId:string,mailboxId:string,id:string){return this.actorTransaction(principalId,mailboxId,false,client=>this.updated(client,principalId,mailboxId,id,false));}
  async listDrafts(principalId:string,mailboxId:string):Promise<DraftSummary[]>{return this.actorTransaction(principalId,mailboxId,false,async client=>{
    const {rows}=await client.query<{id:string;version:string;state:Draft['state'];mode:ComposeMode;subject:string;to_recipients:MailAddress[];recipient_count:number;attachment_count:string;updated_at:Date}>(
      `SELECT d.id,d.version,d.state,d.mode,left(d.subject,200) AS subject,jsonb_path_query_array(d.to_recipients,'$[0 to 2]') AS to_recipients,
        jsonb_array_length(d.to_recipients)+jsonb_array_length(d.cc_recipients)+jsonb_array_length(d.bcc_recipients) AS recipient_count,
        (SELECT count(*) FROM outbound_draft_attachments a WHERE a.draft_id=d.id) AS attachment_count,d.updated_at
       FROM outbound_drafts d WHERE d.mailbox_id=$1 AND d.author_principal_id=$2 AND d.state='editing' ORDER BY d.updated_at DESC,d.id DESC LIMIT 100`,[mailboxId,principalId]);
    return rows.map(row=>({id:row.id,mailboxId,version:Number(row.version),state:row.state,mode:row.mode,to:row.to_recipients,recipientCount:row.recipient_count,subject:row.subject,updatedAt:row.updated_at.toISOString(),attachmentCount:Number(row.attachment_count)}));
  });}
  async createDraft(principalId:string,mailboxId:string,input:Record<string,unknown>):Promise<Draft>{
    const mode=input.mode as ComposeMode;if(!['new','reply','reply_all','reply_person','forward'].includes(mode))throw new ApiError(400,'invalid_compose_mode');
    if(Object.keys(input).some(key=>!['mode','sourceMessageId','replyPerson','fromAllocationId','mutationKey'].includes(key)))throw new ApiError(400,'invalid_draft_field');
    const forwarded:Array<{sourceId:string;contentVersion:string;sourceSha256:string;filename:string;mimeType:string;sha256:string;bytes:Uint8Array}>=[];
    const initial=await this.actorTransaction(principalId,mailboxId,false,async client=>{
      const saved=await this.recalled<Draft>(client,principalId,mailboxId,input.mutationKey,{...input,action:'create'});if(saved)return {saved};
      return {source:mode==='new'?null:await this.deps.loadSource(client,principalId,mailboxId,requireId(input.sourceMessageId))};
    });
    if(initial.saved)return initial.saved;
    const preparedSource=initial.source??null;
    if(mode==='forward'&&preparedSource){
      if(preparedSource.attachmentsReady===false)throw new ApiError(409,'source_attachments_preparing');
      if(preparedSource.attachments.length>32||preparedSource.attachments.reduce((sum,a)=>sum+a.sizeBytes,0)>this.config.maxAttachmentBytes)throw new ApiError(413,'draft_attachment_limit');
      for(const item of preparedSource.attachments){
        const copied=await this.deps.copyAttachment(principalId,mailboxId,preparedSource.messageId,item.id);
        if(sourceIdentity(copied.sourceSha256,copied.sourceContentVersion)!==sourceIdentity(preparedSource.sourceSha256,preparedSource.contentVersion)
          ||digest(copied.bytes)!==item.sha256||copied.bytes.byteLength!==item.sizeBytes||copied.filename!==item.filename||copied.mimeType!==item.mimeType)throw new ApiError(409,'source_attachment_changed');
        forwarded.push({sourceId:item.id,contentVersion:copied.sourceContentVersion,sourceSha256:copied.sourceSha256,filename:safeFilename(copied.filename),mimeType:copied.mimeType,sha256:copied.sha256,bytes:copied.bytes});
      }
    }
    const identities=await this.deps.listSendingIdentities(principalId);
    return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,{...input,action:'create'},async()=>{
      const count=(await client.query<{count:string}>("SELECT count(*) FROM outbound_drafts WHERE author_principal_id=$1 AND state='editing'",[principalId])).rows[0]!;
      if(Number(count.count)>=this.config.maxDrafts)throw new ApiError(429,'draft_limit');
      const source=preparedSource;
      if(source){
        const current=await this.deps.loadSource(client,principalId,mailboxId,source.messageId);
        if(current.mailboxId!==mailboxId||current.messageId!==input.sourceMessageId)throw new ApiError(404,'source_message_unavailable');
        if(sourceIdentity(current.sourceSha256,current.contentVersion)!==sourceIdentity(source.sourceSha256,source.contentVersion))throw new ApiError(409,'source_message_changed');
        if(mode==='forward'&&current.attachmentsReady===false)throw new ApiError(409,'source_attachments_preparing');
        if(forwarded.some(part=>!current.attachments.some(item=>item.id===part.sourceId&&item.sha256===part.sha256&&item.sizeBytes===part.bytes.byteLength&&item.filename===part.filename&&item.mimeType===part.mimeType)))throw new ApiError(409,'source_attachment_changed');
      }
      const selfKey=(address:string):string|null=>{try{return normalizedAddress(address).toLowerCase();}catch{return null;}};
      const self=new Set((await this.deps.selfAddresses(client,mailboxId,source?.messageId)).map(selfKey).filter((value):value is string=>value!==null));
      if(source?.envelopeTo){const key=selfKey(source.envelopeTo);if(key)self.add(key);}
      const own=(address:MailAddress)=>{const key=selfKey(address.address);return key!==null&&self.has(key);};
      const available=identities.filter(identity=>identity.eligible&&identity.mailboxId===mailboxId&&identity.address);
      let fromAllocationId:string|null=null;
      if(input.fromAllocationId!==undefined)fromAllocationId=await this.allocation(client,mailboxId,input.fromAllocationId);
      else if(source?.direction==='inbound')fromAllocationId=available.find(identity=>selfKey(identity.address!)===selfKey(source.envelopeTo??''))?.allocationId??null;
      else if(source?.direction==='outbound')fromAllocationId=available.find(identity=>source.from.some(address=>selfKey(address.address)===selfKey(identity.address!)))?.allocationId??null;
      else if(available.length===1)fromAllocationId=available[0]!.allocationId;
      const warnings:string[]=[];if(!fromAllocationId)warnings.push('sender_selection_required');
      let to:MailAddress[]=[],cc:MailAddress[]=[];
      if(source&&mode!=='forward'){
        const target=source.direction==='outbound'?source.to.filter(a=>!own(a)):(source.replyTo.length?source.replyTo:source.from).filter(a=>!own(a));
        if(mode==='reply_person'){const person=input.replyPerson as MailAddress|undefined;if(!person||typeof person.name!=='string'||typeof person.address!=='string')throw new ApiError(400,'invalid_recipients');to=[person];}
        else {to=target;if(mode==='reply_all'){
          cc=source.direction==='outbound'?source.cc.filter(a=>!own(a)):[...source.to,...source.cc].filter(a=>!own(a));
          if(source.direction==='inbound'&&![...source.to,...source.cc].some(own))warnings.push('reply_all_not_visible');
        }}
        const seen=new Set<string>();const dedupe=(values:MailAddress[])=>values.filter(value=>{let key:string;try{key=normalizedAddress(value.address);}catch{key=`unparsed:${value.address.trim()}`;if(!warnings.includes('recipient_review_required'))warnings.push('recipient_review_required');}if(seen.has(key))return false;seen.add(key);return true;});to=dedupe(to);cc=dedupe(cc);
      }
      const seedNames=(items:MailAddress[])=>items.map(item=>{const name=seedHeader(item.name,512);if(name!==item.name&&!warnings.includes('seeded_recipient_name_adjusted'))warnings.push('seeded_recipient_name_adjusted');return {...item,name};});
      to=seedNames(to);cc=seedNames(cc);
      const quote:DraftQuote|null=source?{sourceMessageId:source.messageId,sourceContentVersion:source.contentVersion,sourceSha256:sourceIdentity(source.sourceSha256,source.contentVersion),include:true,attribution:{from:source.from,to:source.to,cc:source.cc,subject:source.subject,sentAt:source.sentAt},text:source.text}:null;
      const seededSubject=source?(mode==='forward'?`Fwd: ${source.subject}`:/^re:/i.test(source.subject)?source.subject:`Re: ${source.subject}`):'';
      const subject=seedHeader(seededSubject,998);if(subject!==seededSubject)warnings.push('seeded_subject_adjusted');
      const id=attachmentUuidV7();
      await client.query(`INSERT INTO outbound_drafts(id,mailbox_id,author_principal_id,mode,source_message_id,from_allocation_id,to_recipients,cc_recipients,subject,quote,warnings)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,mailboxId,principalId,mode,source?.messageId??null,fromAllocationId,JSON.stringify(to),JSON.stringify(cc),subject,quote,JSON.stringify(warnings)]);
      if(forwarded.length){
        const used=(await client.query<{total:string}>('SELECT COALESCE(sum(a.size_bytes),0) AS total FROM outbound_draft_attachments a JOIN outbound_drafts d ON d.id=a.draft_id WHERE d.author_principal_id=$1 AND a.bytes IS NOT NULL',[principalId])).rows[0]!;
        if(Number(used.total)+forwarded.reduce((sum,part)=>sum+part.bytes.byteLength,0)>this.config.maxDraftStorageBytes)throw new ApiError(429,'draft_storage_limit');
        for(const part of forwarded)await client.query('INSERT INTO outbound_draft_attachments(id,draft_id,filename,mime_type,sha256,size_bytes,bytes,source_message_id,source_attachment_id,source_content_version,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[attachmentUuidV7(),id,part.filename,part.mimeType,part.sha256,part.bytes.byteLength,Buffer.from(part.bytes),source!.messageId,part.sourceId,part.contentVersion,part.sourceSha256]);
      }
      return this.updated(client,principalId,mailboxId,id);
    }));
  }

  async duplicateDraft(principalId:string,mailboxId:string,id:string,input:Record<string,unknown>):Promise<Draft>{
    if(Object.keys(input).some(key=>key!=='mutationKey'))throw new ApiError(400,'invalid_draft_field');
    const request={...input,action:'duplicate',id};
    const initial=await this.actorTransaction(principalId,mailboxId,false,async client=>{
      const saved=await this.recalled<Draft>(client,principalId,mailboxId,input.mutationKey,request);if(saved)return {saved};
      const row=await this.row(client,principalId,mailboxId,id,undefined,false);
      return {row,parts:(await client.query<OwnedDraftPart>('SELECT * FROM outbound_draft_attachments WHERE draft_id=$1 ORDER BY created_at,id',[id])).rows};
    });
    if(initial.saved)return initial.saved;
    // Immutable MIME extraction happens outside the final write transaction and its hot locks.
    const preparedParts=await restoreDraftParts(this,this.pool,id,initial.parts!);
    const senders=await this.deps.listSendingIdentities(principalId);
    return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,request,async()=>{
      const row=await this.row(client,principalId,mailboxId,id);
      if(row.version!==initial.row!.version||row.state!==initial.row!.state)throw new ApiError(409,'draft_version_conflict');
      if(row.source_message_id){const source=await this.deps.loadSource(client,principalId,mailboxId,row.source_message_id);if(row.quote&&sourceIdentity(source.sourceSha256,source.contentVersion)!==sourceIdentity(row.quote.sourceSha256,row.quote.sourceContentVersion))throw new ApiError(409,'source_message_changed');}
      const currentParts=(await client.query<Omit<OwnedDraftPart,'bytes'>>('SELECT id,filename,mime_type,sha256,size_bytes,source_message_id,source_attachment_id,source_content_version,source_sha256 FROM outbound_draft_attachments WHERE draft_id=$1 ORDER BY created_at,id',[id])).rows;
      if(canonical(currentParts)!==canonical(preparedParts.map(part=>({id:part.id,filename:part.filename,mime_type:part.mime_type,sha256:part.sha256,size_bytes:part.size_bytes,source_message_id:part.source_message_id,source_attachment_id:part.source_attachment_id,source_content_version:part.source_content_version,source_sha256:part.source_sha256}))))throw new ApiError(409,'draft_attachment_correspondence_changed');
      const parts={rows:preparedParts};
      const limits=(await client.query<{count:string}>("SELECT count(*) FROM outbound_drafts WHERE author_principal_id=$1 AND state='editing'",[principalId])).rows[0]!;
      if(Number(limits.count)>=this.config.maxDrafts)throw new ApiError(429,'draft_limit');
      const used=(await client.query<{total:string}>('SELECT COALESCE(sum(a.size_bytes),0) AS total FROM outbound_draft_attachments a JOIN outbound_drafts d ON d.id=a.draft_id WHERE d.author_principal_id=$1 AND a.bytes IS NOT NULL',[principalId])).rows[0]!;
      if(Number(used.total)+parts.rows.reduce((sum,part)=>sum+part.size_bytes,0)>this.config.maxDraftStorageBytes)throw new ApiError(429,'draft_storage_limit');
      const warnings=[...row.warnings];const prior=(await client.query<{state:string}>('SELECT state FROM outbound_submissions WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 1',[id])).rows[0];
      if(prior&&['queued','unknown','dispatching','accepted','partial'].includes(prior.state))warnings.push('duplicate_delivery_possible');
      const from=senders.some(sender=>sender.eligible&&sender.mailboxId===mailboxId&&sender.allocationId===row.from_allocation_id)?row.from_allocation_id:null;
      if(!from)warnings.push('sender_selection_required');
      const next=attachmentUuidV7();
      await client.query(`INSERT INTO outbound_drafts(id,mailbox_id,author_principal_id,mode,source_message_id,from_allocation_id,to_recipients,cc_recipients,bcc_recipients,subject,body_text,quote,warnings)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[next,mailboxId,principalId,row.mode,row.source_message_id,from,JSON.stringify(row.to_recipients),JSON.stringify(row.cc_recipients),JSON.stringify(row.bcc_recipients),row.subject,row.body_text,row.quote,JSON.stringify([...new Set(warnings)])]);
      for(const part of parts.rows){
        if(part.source_message_id){const source=await this.deps.loadSource(client,principalId,mailboxId,part.source_message_id);if(sourceIdentity(source.sourceSha256,source.contentVersion)!==sourceIdentity(part.source_sha256,part.source_content_version)||!source.attachments.some(item=>item.id===part.source_attachment_id&&item.sha256===part.sha256&&item.sizeBytes===part.size_bytes&&item.filename===part.filename&&item.mimeType===part.mime_type))throw new ApiError(409,'source_attachment_changed');}
        if(part.bytes.length!==part.size_bytes||digest(part.bytes)!==part.sha256)throw new ApiError(409,'draft_attachment_unavailable');
        await client.query(`INSERT INTO outbound_draft_attachments(id,draft_id,filename,mime_type,sha256,size_bytes,bytes,source_message_id,source_attachment_id,source_content_version,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[attachmentUuidV7(),next,part.filename,part.mime_type,part.sha256,part.size_bytes,part.bytes,part.source_message_id,part.source_attachment_id,part.source_content_version,part.source_sha256]);
      }
      return this.updated(client,principalId,mailboxId,next);
    }));
  }

  async patchDraft(principalId:string,mailboxId:string,id:string,input:Record<string,unknown>):Promise<Draft>{
    requireVersion(input.expectedVersion);
    return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,{...input,action:'patch',id},async()=>{
      const row=await this.row(client,principalId,mailboxId,id,input.expectedVersion);
      const allowed=new Set(['expectedVersion','mutationKey','fromAllocationId','to','cc','bcc','subject','bodyText','includeQuote']);if(Object.keys(input).some(key=>!allowed.has(key)))throw new ApiError(400,'invalid_draft_field');
      const from=input.fromAllocationId===undefined?row.from_allocation_id:await this.allocation(client,mailboxId,input.fromAllocationId);
      const to=input.to===undefined?row.to_recipients:addressList(input.to),cc=input.cc===undefined?row.cc_recipients:addressList(input.cc),bcc=input.bcc===undefined?row.bcc_recipients:addressList(input.bcc);
      const subject=input.subject===undefined?row.subject:text(input.subject,998,false,'invalid_subject'),body=input.bodyText===undefined?row.body_text:text(input.bodyText,this.config.maxBodyBytes,true,'invalid_body_text');
      let quote=row.quote;if(input.includeQuote!==undefined){if(typeof input.includeQuote!=='boolean'||!quote)throw new ApiError(400,'invalid_quote');quote={...quote,include:input.includeQuote};}
      const warnings=(from?row.warnings.filter(warning=>warning!=='sender_selection_required'):[...new Set([...row.warnings,'sender_selection_required'])]).filter(warning=>warning!=='recipient_review_required');
      if([...to,...cc,...bcc].some(item=>{try{normalizedAddress(item.address);return false;}catch{return true;}}))warnings.push('recipient_review_required');
      await client.query('UPDATE outbound_drafts SET from_allocation_id=$2,to_recipients=$3,cc_recipients=$4,bcc_recipients=$5,subject=$6,body_text=$7,quote=$8,warnings=$9,version=version+1,updated_at=now() WHERE id=$1',[id,from,JSON.stringify(to),JSON.stringify(cc),JSON.stringify(bcc),subject,body,quote,JSON.stringify(warnings)]);
      return this.updated(client,principalId,mailboxId,id);
    }));
  }
  async discardDraft(principalId:string,mailboxId:string,id:string,input:Record<string,unknown>):Promise<{ok:true}>{
    requireVersion(input.expectedVersion);
    return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,{...input,action:'discard',id},async()=>{
      await this.row(client,principalId,mailboxId,id,input.expectedVersion);
      if((await client.query('SELECT 1 FROM outbound_submissions WHERE draft_id=$1',[id])).rowCount)throw new ApiError(409,'draft_is_submitted');
      await client.query('DELETE FROM outbound_draft_attachments WHERE draft_id=$1',[id]);await client.query("UPDATE outbound_drafts SET state='discarded',version=version+1,updated_at=now() WHERE id=$1",[id]);return {ok:true};
    }));
  }
  async addAttachment(principalId:string,mailboxId:string,id:string,input:{expectedVersion:number;mutationKey:string;filename:string;mimeType?:string},bytes:Uint8Array,source?:{messageId:string;attachmentId:string;contentVersion:string;sourceSha256:string},mutationRequest?:unknown):Promise<Draft>{
    requireVersion(input.expectedVersion);
    if(bytes.byteLength>this.config.maxAttachmentBytes)throw new ApiError(413,'attachment_too_large');
    const filename=safeFilename(input.filename),sha256=digest(bytes),mimeType=source&&input.mimeType&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(input.mimeType)?input.mimeType:inferUploadMimeType(bytes);
    return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,mutationRequest??{...input,action:'attach',id,sha256,source:source??null},async()=>{
      await this.row(client,principalId,mailboxId,id,input.expectedVersion);
      if(source){const current=await this.deps.loadSource(client,principalId,mailboxId,source.messageId);if(sourceIdentity(current.sourceSha256,current.contentVersion)!==sourceIdentity(source.sourceSha256,source.contentVersion)||!current.attachments.some(a=>a.id===source.attachmentId&&a.sha256===sha256&&a.sizeBytes===bytes.byteLength&&a.filename===filename&&a.mimeType===mimeType))throw new ApiError(409,'source_attachment_changed');}
      const limits=(await client.query<{count:string;total:string}>(`SELECT count(*) AS count,COALESCE(sum(size_bytes),0) AS total FROM outbound_draft_attachments WHERE draft_id=$1`,[id])).rows[0]!;
      const used=(await client.query<{total:string}>('SELECT COALESCE(sum(a.size_bytes),0) AS total FROM outbound_draft_attachments a JOIN outbound_drafts d ON d.id=a.draft_id WHERE d.author_principal_id=$1 AND a.bytes IS NOT NULL',[principalId])).rows[0]!;
      if(Number(limits.count)>=32||Number(limits.total)+bytes.byteLength>this.config.maxAttachmentBytes)throw new ApiError(413,'draft_attachment_limit');
      if(Number(used.total)+bytes.byteLength>this.config.maxDraftStorageBytes)throw new ApiError(429,'draft_storage_limit');
      await client.query('INSERT INTO outbound_draft_attachments(id,draft_id,filename,mime_type,sha256,size_bytes,bytes,source_message_id,source_attachment_id,source_content_version,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[attachmentUuidV7(),id,filename,mimeType,sha256,bytes.byteLength,Buffer.from(bytes),source?.messageId??null,source?.attachmentId??null,source?.contentVersion??null,source?.sourceSha256??null]);
      await client.query('UPDATE outbound_drafts SET version=version+1,updated_at=now() WHERE id=$1',[id]);return this.updated(client,principalId,mailboxId,id);
    }));
  }
  async copyAttachment(principalId:string,mailboxId:string,id:string,input:Record<string,unknown>):Promise<Draft>{
    requireVersion(input.expectedVersion);
    if(input.sourceMailboxId!==mailboxId)throw new ApiError(400,'cross_mailbox_copy_unsupported');
    const mutationRequest={...input,action:'copy_attachment',id};
    const previous=await this.actorTransaction(principalId,mailboxId,true,async client=>{
      const saved=await this.recalled<Draft>(client,principalId,mailboxId,input.mutationKey,mutationRequest);
      if(saved)return saved;
      await this.row(client,principalId,mailboxId,id,input.expectedVersion);return null;
    });
    if(previous)return previous;
    const messageId=requireId(input.sourceMessageId),attachmentId=requireId(input.sourceAttachmentId);
    const copied=await this.deps.copyAttachment(principalId,mailboxId,messageId,attachmentId);
    if(digest(copied.bytes)!==copied.sha256)throw new ApiError(409,'source_attachment_changed');
    return this.addAttachment(principalId,mailboxId,id,{expectedVersion:Number(input.expectedVersion),mutationKey:requireId(input.mutationKey),filename:copied.filename,mimeType:copied.mimeType},copied.bytes,{messageId,attachmentId,contentVersion:copied.sourceContentVersion,sourceSha256:copied.sourceSha256},mutationRequest);
  }
  async removeAttachment(principalId:string,mailboxId:string,id:string,attachmentId:string,input:Record<string,unknown>):Promise<Draft>{
    requireVersion(input.expectedVersion);
    return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,{...input,action:'remove_attachment',id,attachmentId},async()=>{
      await this.row(client,principalId,mailboxId,id,input.expectedVersion);
      if(!(await client.query('DELETE FROM outbound_draft_attachments WHERE id=$1 AND draft_id=$2',[requireId(attachmentId),id])).rowCount)throw new ApiError(404,'attachment_not_found');
      await client.query('UPDATE outbound_drafts SET version=version+1,updated_at=now() WHERE id=$1',[id]);return this.updated(client,principalId,mailboxId,id);
    }));
  }
  async submissionView(client:PoolClient,row:SubmissionRow):Promise<OutboxSubmission>{
    const {rows}=await client.query<OutboxSubmission['recipients'][number]>('SELECT address,status,code FROM outbound_recipients WHERE submission_id=$1 ORDER BY address',[row.id]);
    return {id:row.id,mailboxId:row.mailbox_id,draftId:row.draft_id,version:Number(row.version),state:row.state,from:row.snapshot.from,to:row.snapshot.to,cc:row.snapshot.cc,bcc:row.snapshot.bcc,subject:row.snapshot.subject,errorCode:row.error_code,recipients:rows,sentCopyState:row.sent_copy_state,sentMessageId:row.sent_message_id,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
  }
  async outboxRow(client:PoolClient,principalId:string,mailboxId:string,id:string,lock=true):Promise<SubmissionRow>{
    const row=(await client.query<SubmissionRow>(`SELECT ${OUTBOX_SUMMARY_COLUMNS} FROM outbound_submissions WHERE id=$1 AND mailbox_id=$2 AND author_principal_id=$3${lock?' FOR UPDATE':''}`,[requireId(id),mailboxId,principalId])).rows[0];if(!row)throw new ApiError(404,'submission_not_found');return row;
  }
  async getSubmission(principalId:string,mailboxId:string,id:string){return this.actorTransaction(principalId,mailboxId,false,async client=>this.submissionView(client,await this.outboxRow(client,principalId,mailboxId,id,false)));}
  async listOutbox(principalId:string,mailboxId:string){return this.actorTransaction(principalId,mailboxId,false,async client=>{const {rows}=await client.query<SubmissionRow>(`SELECT ${OUTBOX_SUMMARY_COLUMNS} FROM outbound_submissions WHERE mailbox_id=$1 AND author_principal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,[mailboxId,principalId]);const result:OutboxSubmission[]=[];for(const row of rows)result.push(await this.submissionView(client,row));return result;});}
  async cancel(principalId:string,mailboxId:string,id:string,input:Record<string,unknown>){requireVersion(input.expectedVersion);return this.actorTransaction(principalId,mailboxId,true,client=>this.replay(client,principalId,mailboxId,input.mutationKey,{...input,action:'cancel',id},async()=>{
    const row=await this.outboxRow(client,principalId,mailboxId,id);if(row.state!=='queued'||Number(row.version)!==input.expectedVersion)throw new ApiError(409,'submission_cannot_cancel');
    await client.query("UPDATE outbound_submissions SET state='cancelled',version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1",[id]);return this.submissionView(client,await this.outboxRow(client,principalId,mailboxId,id));
  }));}
  async submit(principalId:string,mailboxId:string,id:string,input:Record<string,unknown>):Promise<OutboxSubmission>{
    requireVersion(input.expectedVersion);
    if(Object.keys(input).some(key=>!['expectedVersion','mutationKey','acknowledgeNotVisible','acknowledgeDuplicate'].includes(key)))throw new ApiError(400,'invalid_send_request');
    if(!this.config.enabled||!this.deps.transport)throw new ApiError(503,'outbound_not_configured');
    const preliminary=await this.actorTransaction(principalId,mailboxId,true,async client=>{
      const saved=await this.recalled<OutboxSubmission>(client,principalId,mailboxId,input.mutationKey,{...input,action:'send',id});
      if(saved)return {saved};
      const row=await this.row(client,principalId,mailboxId,id,input.expectedVersion);const draft=await this.draftView(client,row);
      text(draft.subject,998,false,'invalid_subject');text(draft.bodyText,this.config.maxBodyBytes,true,'invalid_body_text');
      if(draft.attachments.length>32||draft.attachments.reduce((sum,part)=>sum+part.sizeBytes,0)>this.config.maxAttachmentBytes)throw new ApiError(413,'draft_attachment_limit');
      return {draft,parts:(await client.query<{id:string;bytes:Buffer}>('SELECT id,bytes FROM outbound_draft_attachments WHERE draft_id=$1',[id])).rows};
    });
    if(preliminary.saved)return preliminary.saved;
    const draft=preliminary.draft!;if(!draft.fromAllocationId)throw new ApiError(400,'sender_selection_required');
    if(draft.warnings.includes('duplicate_delivery_possible')&&input.acknowledgeDuplicate!==true)throw new ApiError(409,'duplicate_confirmation_required');
    if(draft.warnings.includes('reply_all_not_visible')&&input.acknowledgeNotVisible!==true)throw new ApiError(409,'reply_all_confirmation_required');
    const normalized=(await import('./validation.js')).strictRecipients([draft.to,draft.cc,draft.bcc],Math.min(this.config.maxRecipients,this.deps.transport.capabilities.maxRecipients));
    const source=draft.sourceMessageId?await this.actorTransaction(principalId,mailboxId,false,client=>this.deps.loadSource(client,principalId,mailboxId,draft.sourceMessageId!)):null;
    const selected=(await this.deps.listSendingIdentities(principalId)).find(identity=>identity.allocationId===draft.fromAllocationId&&identity.mailboxId===mailboxId&&identity.eligible);
    if(!selected?.address||!selected.grantId||selected.sendingGeneration===undefined||selected.policyRevision===undefined||!selected.policyDigest)throw new ApiError(403,'sender_not_eligible');
    const submissionId=attachmentUuidV7(),date=new Date(this.now()).toISOString();
    const snapshot:SendSnapshot={submissionId,transportKey:`${this.config.provider}:${this.config.accountId??''}`,draftId:id,draftVersion:draft.version,mailboxId,authorPrincipalId:principalId,fromAllocationId:draft.fromAllocationId,from:{name:'',address:selected.address},grantId:selected.grantId,sendingGeneration:selected.sendingGeneration,policyRevision:selected.policyRevision,policyDigest:selected.policyDigest,
      to:normalized.lists[0]!,cc:normalized.lists[1]!,bcc:normalized.lists[2]!,envelopeRecipients:normalized.envelope,subject:draft.subject,bodyText:draft.bodyText,quote:draft.quote,mode:draft.mode,sourceMessageId:draft.sourceMessageId,
      inReplyTo:source&&draft.mode!=='forward'&&source.messageIdHeader?[source.messageIdHeader]:[],references:source&&draft.mode!=='forward'?references([...(source.references.length?source.references:source.inReplyTo.length===1?source.inReplyTo:[]),...(source.messageIdHeader?[source.messageIdHeader]:[])]):[],messageIdHeader:`<${submissionId}@${selected.address.split('@')[1]}>`,date,attachments:draft.attachments};
    if(source&&draft.quote&&sourceIdentity(source.sourceSha256,source.contentVersion)!==sourceIdentity(draft.quote.sourceSha256,draft.quote.sourceContentVersion))throw new ApiError(409,'source_message_changed');
    const mime=await composeMessage(snapshot,preliminary.parts!,Math.min(this.config.maxMessageBytes,this.deps.transport.capabilities.maxMessageBytes));const sha256=digest(mime);
    return this.deps.withSenderAdmission({principalId,mailboxId,allocationId:draft.fromAllocationId},(client,sender)=>this.replay(client,principalId,mailboxId,input.mutationKey,{...input,action:'send',id},async()=>{
      await this.row(client,principalId,mailboxId,id,input.expectedVersion);
      if(!sender.eligible||sender.mailboxId!==mailboxId||sender.address!==snapshot.from.address||sender.grantId!==snapshot.grantId||sender.sendingGeneration!==snapshot.sendingGeneration||sender.policyRevision!==snapshot.policyRevision||sender.policyDigest!==snapshot.policyDigest)throw new ApiError(409,'sender_authorization_changed');
      if(source){const current=await this.deps.loadSource(client,principalId,mailboxId,source.messageId);if(sourceIdentity(current.sourceSha256,current.contentVersion)!==sourceIdentity(source.sourceSha256,source.contentVersion))throw new ApiError(409,'source_message_changed');}
      const refs=await client.query<{source_message_id:string;source_attachment_id:string;source_content_version:string;source_sha256:string|null;sha256:string;size_bytes:number;filename:string;mime_type:string}>('SELECT source_message_id,source_attachment_id,source_content_version,source_sha256,sha256,size_bytes,filename,mime_type FROM outbound_draft_attachments WHERE draft_id=$1 AND source_message_id IS NOT NULL',[id]);
      for(const ref of refs.rows){const current=await this.deps.loadSource(client,principalId,mailboxId,ref.source_message_id);if(sourceIdentity(current.sourceSha256,current.contentVersion)!==sourceIdentity(ref.source_sha256,ref.source_content_version)||!current.attachments.some(a=>a.id===ref.source_attachment_id&&a.sha256===ref.sha256&&a.sizeBytes===ref.size_bytes&&a.filename===ref.filename&&a.mimeType===ref.mime_type))throw new ApiError(409,'source_attachment_changed');}
      // After final draft/session/source/From checks, perform only bounded local persistence here.
      await this.deps.blobs.put(sha256,mime);
      await client.query('INSERT INTO outbound_submissions(id,draft_id,draft_version,mailbox_id,author_principal_id,snapshot,raw_sha256,raw_size,queue_deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[submissionId,id,draft.version,mailboxId,principalId,snapshot,sha256,mime.length,new Date(this.now()+this.config.maxQueueAgeSeconds*1000)]);
      for(const address of snapshot.envelopeRecipients)await client.query('INSERT INTO outbound_recipients(submission_id,address) VALUES($1,$2)',[submissionId,address]);
      await client.query("UPDATE outbound_drafts SET state='queued',version=version+1,updated_at=now() WHERE id=$1",[id]);return this.submissionView(client,await this.outboxRow(client,principalId,mailboxId,submissionId));
    }));
  }
}
