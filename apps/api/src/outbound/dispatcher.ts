import type { PoolClient } from 'pg';
import type { OutboundResult } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
import { attachmentUuidV7 } from '../attachments/uuid.js';
import { OutboundService, type SubmissionRow } from './service.js';
import { digest, canonical } from './validation.js';
import { ProviderRejection } from './provider.js';
import { releaseTerminalDraftStaging } from './staging.js';
import type { Admission } from './types.js';
import { normalizeProviderRfcMessageId } from '../mail/threading.js';

async function transaction<T>(service:OutboundService,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await service.pool.connect();try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function recoverUnknownOutbound(service:OutboundService):Promise<number>{
  return transaction(service,async client=>{
    const result=await client.query<{id:string;current_attempt_id:string}>(`UPDATE outbound_submissions s SET state='unknown',error_code='dispatch_outcome_unknown',version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL
      FROM outbound_attempts a WHERE s.state='dispatching' AND s.current_attempt_id=a.id AND a.expires_at<=$1 RETURNING s.id,s.current_attempt_id`,[new Date(service.now())]);
    for(const row of result.rows){await client.query("UPDATE outbound_attempts SET state='unknown',completed_at=now() WHERE id=$1 AND state='dispatching'",[row.current_attempt_id]);await client.query("UPDATE outbound_recipients SET status='unknown',code='dispatch_outcome_unknown' WHERE submission_id=$1 AND status='pending'",[row.id]);}
    return result.rowCount??0;
  });
}
async function claim(service:OutboundService):Promise<SubmissionRow|null>{return transaction(service,async client=>{
  const row=(await client.query<SubmissionRow>(`SELECT * FROM outbound_submissions WHERE state='queued' AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
  if(!row)return null;row.lease_id=attachmentUuidV7();await client.query("UPDATE outbound_submissions SET lease_id=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",[row.id,row.lease_id]);return row;
});}
async function blockQueued(service:OutboundService,row:SubmissionRow,code:string){await service.pool.query("UPDATE outbound_submissions SET state='blocked',error_code=$3,version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND state='queued' AND lease_id=$2",[row.id,row.lease_id,code]);}
async function outcome(service:OutboundService,admission:Admission,result:OutboundResult|undefined,error:unknown):Promise<void>{
  await transaction(service,async client=>{
    // Any path needing both locks follows mailbox -> outbox, matching normal admission.
    await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[admission.snapshot.mailboxId]);
    const row=(await client.query<SubmissionRow>("SELECT * FROM outbound_submissions WHERE id=$1 AND current_attempt_id=$2 AND state IN ('dispatching','unknown') FOR UPDATE",[admission.snapshot.submissionId,admission.attemptId])).rows[0];if(!row)return;
    if(error instanceof ProviderRejection){
      const retry=error.retryable&&row.state==='dispatching'&&row.queue_deadline.getTime()>service.now();
      await client.query("UPDATE outbound_attempts SET state='completed',result=$2,completed_at=now() WHERE id=$1",[admission.attemptId,{rejected:true,code:error.code}]);
      await client.query(`UPDATE outbound_submissions SET state=$3,error_code=$4,available_at=$5,current_attempt_id=NULL,lease_id=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1 AND current_attempt_id=$2`,[row.id,admission.attemptId,retry?'queued':'failed',error.code,new Date(service.now()+error.retryAfterSeconds*1000)]);
      return;
    }
    const expected=new Set(admission.snapshot.envelopeRecipients),seen=new Set<string>();
    const valid=result&&Array.isArray(result.recipients)&&result.recipients.length===expected.size&&result.recipients.every(recipient=>{
      if(!expected.has(recipient.address)||seen.has(recipient.address)||!['accepted','failed','unknown'].includes(recipient.status))return false;seen.add(recipient.address);return true;
    });
    if(!valid){
      await client.query("UPDATE outbound_attempts SET state='unknown',completed_at=now() WHERE id=$1",[admission.attemptId]);
      await client.query("UPDATE outbound_submissions SET state='unknown',error_code='provider_outcome_unknown',version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1",[row.id]);
      await client.query("UPDATE outbound_recipients SET status='unknown',code='provider_outcome_unknown' WHERE submission_id=$1 AND status='pending'",[row.id]);return;
    }
    let accepted=0,unknown=0;
    for(const recipient of result.recipients){if(recipient.status==='accepted')accepted++;if(recipient.status==='unknown')unknown++;
      await client.query('UPDATE outbound_recipients SET status=$3,code=$4 WHERE submission_id=$1 AND address=$2',[row.id,recipient.address,recipient.status,recipient.code?.slice(0,128)??null]);}
    const state=accepted===expected.size?'accepted':accepted?'partial':unknown?'unknown':'failed';
    await client.query("UPDATE outbound_attempts SET state='completed',result=$2,completed_at=now() WHERE id=$1",[admission.attemptId,result]);
    await client.query(`UPDATE outbound_submissions SET state=$2,provider_message_id=$3,error_code=NULL,sent_copy_state=$4,rfc_message_id=$5,version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL,available_at=now() WHERE id=$1`,[row.id,state,result.providerMessageId??null,accepted?'pending':'none',accepted?normalizeProviderRfcMessageId(result.rfcMessageId):null]);
  });
}
export async function ensureSentCopy(service:OutboundService):Promise<boolean>{
  const candidate=(await service.pool.query<SubmissionRow>("SELECT * FROM outbound_submissions WHERE sent_copy_state='pending' AND available_at<=now() ORDER BY created_at,id LIMIT 1")).rows[0];if(!candidate)return false;
  try{
    if(!candidate.raw_sha256||candidate.raw_size===null)throw new Error('sent_source_missing');
    const prepared=await service.deps.prepareSent({...candidate.snapshot,rawSha256:candidate.raw_sha256,rawSize:candidate.raw_size,providerMessageId:candidate.provider_message_id,rfcMessageId:candidate.rfc_message_id});
    await transaction(service,async client=>{
    await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[candidate.mailbox_id]);
    const row=(await client.query<SubmissionRow>("SELECT * FROM outbound_submissions WHERE id=$1 AND sent_copy_state='pending' FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!row)return;
    if(!row.raw_sha256||row.raw_size===null)throw new Error('sent_source_missing');
    const sentMessageId=await service.deps.persistSent(client,{...row.snapshot,rawSha256:row.raw_sha256,rawSize:row.raw_size,providerMessageId:row.provider_message_id,rfcMessageId:row.rfc_message_id},prepared);
    await client.query("UPDATE outbound_submissions SET sent_copy_state='done',sent_message_id=$2,error_code=NULL,version=version+1,updated_at=now() WHERE id=$1",[row.id,sentMessageId]);
  });}catch{await service.pool.query("UPDATE outbound_submissions SET error_code='sent_copy_failed',available_at=now()+interval '30 seconds' WHERE id=$1 AND sent_copy_state='pending'",[candidate.id]);}
  return true;
}
export async function runOneOutboundJob(service:OutboundService):Promise<boolean>{
  const expired=await service.pool.query(`WITH old AS (SELECT mailbox_id,author_principal_id,mutation_key FROM outbound_mutations
    WHERE expires_at<=now() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)
    DELETE FROM outbound_mutations m USING old WHERE m.mailbox_id=old.mailbox_id AND m.author_principal_id=old.author_principal_id AND m.mutation_key=old.mutation_key`);
  const recovered=(await recoverUnknownOutbound(service))+(expired.rowCount??0);
  if(await ensureSentCopy(service))return true;
  if(await releaseTerminalDraftStaging(service))return true;
  if(!service.config.enabled||!service.deps.transport)return recovered>0;
  const row=await claim(service);if(!row)return recovered>0;
  if(row.snapshot.transportKey!==`${service.config.provider}:${service.config.accountId??''}`){await blockQueued(service,row,'outbound_route_changed');return true;}
  if(row.queue_deadline.getTime()<=service.now()){await blockQueued(service,row,'queue_expired');return true;}
  let bytes:Buffer;
  try{if(!row.raw_sha256||row.raw_size===null)throw new Error();bytes=await service.deps.blobs.get(row.raw_sha256);if(bytes.length!==row.raw_size||digest(bytes)!==row.raw_sha256)throw new Error();}
  catch{await blockQueued(service,row,'submission_bytes_unavailable');return true;}
  if(bytes.length>service.deps.transport.capabilities.maxMessageBytes||row.snapshot.envelopeRecipients.length>service.deps.transport.capabilities.maxRecipients){await blockQueued(service,row,'provider_limit_changed');return true;}
  let admission:Admission|null;
  try{admission=await service.deps.withSenderAdmission({principalId:row.author_principal_id,mailboxId:row.mailbox_id,allocationId:row.snapshot.fromAllocationId},async(client,sender)=>{
    const current=(await client.query<SubmissionRow>("SELECT * FROM outbound_submissions WHERE id=$1 AND state='queued' AND lease_id=$2 AND lease_until>now() FOR UPDATE",[row.id,row.lease_id])).rows[0];if(!current)return null;
    if(current.queue_deadline.getTime()<=service.now())throw new ApiError(409,'queue_expired');
    const s=current.snapshot;
    if(!sender.eligible||sender.mailboxId!==s.mailboxId||sender.address!==s.from.address||sender.grantId!==s.grantId||sender.sendingGeneration!==s.sendingGeneration||sender.policyRevision!==s.policyRevision||sender.policyDigest!==s.policyDigest)throw new ApiError(403,'sender_authorization_changed');
    const attemptId=attachmentUuidV7(),startDeadline=service.now()+service.config.startDeadlineMs;
    await client.query(`INSERT INTO outbound_attempts(id,submission_id,state,start_deadline,expires_at,request_sha256) VALUES($1,$2,'dispatching',$3,$4,$5)`,[attemptId,row.id,new Date(startDeadline),new Date(startDeadline+service.config.providerTimeoutMs+5000),digest(canonical({from:s.from.address,recipients:s.envelopeRecipients,sha256:current.raw_sha256}))]);
    await client.query("UPDATE outbound_submissions SET state='dispatching',current_attempt_id=$2,lease_id=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1",[row.id,attemptId]);
    return {snapshot:s,attemptId,startDeadline,rawSha256:current.raw_sha256!,rawSize:current.raw_size!};
  });}catch(error){if(error instanceof ApiError&&[401,403,404,409].includes(error.statusCode))await blockQueued(service,row,error.code);
    else await service.pool.query("UPDATE outbound_submissions SET lease_id=NULL,lease_until=NULL,available_at=now()+interval '30 seconds',error_code='admission_unavailable' WHERE id=$1 AND state='queued' AND lease_id=$2",[row.id,row.lease_id]);return true;}
  if(!admission)return true;
  if(service.now()>=admission.startDeadline){await outcome(service,admission,undefined,new ProviderRejection('dispatch_start_expired'));return true;}
  let result:OutboundResult|undefined,error:unknown;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{result=await Promise.race([service.deps.transport.send({submissionId:row.id,envelopeFrom:admission.snapshot.from.address,recipients:admission.snapshot.envelopeRecipients,mime:bytes}),
    new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('provider_deadline_exceeded')),service.config.providerTimeoutMs);})]);}
  catch(cause){error=cause;}finally{if(timer)clearTimeout(timer);}
  // If this commit fails, the durable dispatching marker remains; recovery never resends it.
  await outcome(service,admission,result,error);
  return true;
}
