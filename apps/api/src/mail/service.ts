import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MailCapabilities, MailChangesResult, MailLabel, MailLabelMutationResult, MailListResult, MailMessageState,
  MailMessageSummary, MailMutationInput, MailMutationResult } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
import { appendChange } from '../database.js';
import type { AuthorizeMailTransaction, MailListOptions, MailViewer } from './types.js';
import { initializeMessageState } from './threading.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const folders=['inbox','archive','trash','spam'] as const;
const sequence=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
function invalid():never{throw new ApiError(400,'invalid_mail_request');}
function id(v:unknown):string{if(typeof v!=='string'||!UUID.test(v))invalid();return v;}
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))invalid();return v as Record<string,unknown>;}
function exactKeys(v:Record<string,unknown>,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))invalid();}
function canonical(v:unknown):string{if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;return JSON.stringify(v);}
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function parts(v:unknown):[string,string]{if(typeof v!=='string')invalid();const p=v.split(':');if(p.length!==2||!sequence(p[0])||!sequence(p[1]))invalid();return[p[0]!,p[1]!];}
export function validateMailMutation(value:unknown):MailMutationInput{
  const v=record(value);exactKeys(v,['operationId','items','set','addLabelIds','removeLabelIds']);id(v.operationId);
  if(!Array.isArray(v.items)||v.items.length<1||v.items.length>100)invalid();
  const items=v.items.map(value=>{const item=record(value);exactKeys(item,['id','version']);id(item.id);parts(item.version);return{id:item.id as string,version:item.version as string};});
  if(new Set(items.map(item=>item.id)).size!==items.length)invalid();
  const set=v.set===undefined?undefined:record(v.set);if(set){exactKeys(set,['read','starred','folder']);for(const name of ['read','starred'])if(set[name]!==undefined&&typeof set[name]!=='boolean')invalid();if(set.folder!==undefined&&!folders.includes(set.folder as typeof folders[number]))invalid();}
  const labels=(value:unknown)=>{if(value===undefined)return undefined;if(!Array.isArray(value)||value.length>100)invalid();const result=value.map(id);if(new Set(result).size!==result.length)invalid();return result;};
  const addLabelIds=labels(v.addLabelIds),removeLabelIds=labels(v.removeLabelIds);
  if(addLabelIds?.some(label=>removeLabelIds?.includes(label)))invalid();
  if(!Object.keys(set??{}).length&&!addLabelIds?.length&&!removeLabelIds?.length)invalid();
  return{operationId:v.operationId as string,items,...(set?{set:set as MailMutationInput['set']}:{}),...(addLabelIds?{addLabelIds}:{}),...(removeLabelIds?{removeLabelIds}:{})};
}
interface StateRow{
  id:string;thread_id:string|null;folder:MailMessageState['folder'];filing_version:string;personal_version:string;
  is_read:boolean;is_starred:boolean;label_ids:string[];direction:'inbound'|'outbound';subject:string;from_header:string;to_header:string;
  received_at:Date;cursor_at:string;preview:string;parse_status:MailMessageSummary['status'];raw_size:number;
}
const projection=`SELECT d.id,d.mailbox_id,d.subject,d.from_header,d.to_header,d.received_at,
 to_char(d.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
 d.preview,d.parse_status,d.raw_size,d.direction,s.thread_id,
 COALESCE((SELECT headers->>'cc' FROM message_reader_data rd WHERE rd.delivery_id=d.id),'') AS cc_header,
 COALESCE(s.folder,CASE WHEN d.direction='outbound' THEN 'archive' ELSE 'inbox' END) AS folder,
 COALESCE(s.filing_version,1)::text AS filing_version,COALESCE(f.flags_version,0)::text AS personal_version,
 COALESCE(f.is_read,d.direction='outbound') AS is_read,COALESCE(f.is_starred,false) AS is_starred,
 ARRAY(SELECT ml.label_id::text FROM mail_message_labels ml WHERE ml.mailbox_id=d.mailbox_id AND ml.message_id=d.id ORDER BY ml.label_id) AS label_ids
 FROM deliveries d LEFT JOIN mail_message_state s ON s.message_id=d.id
 LEFT JOIN principal_message_flags f ON f.mailbox_id=d.mailbox_id AND f.message_id=d.id AND f.principal_id=$2
 WHERE d.mailbox_id=$1 AND d.deleted_at IS NULL`;
function state(row:StateRow):MailMessageState{return{id:row.id,threadId:row.thread_id,folder:row.folder,read:row.is_read,starred:row.is_starred,labelIds:row.label_ids,version:`${row.filing_version}:${row.personal_version}`};}
function summary(row:StateRow):MailMessageSummary{return{...state(row),subject:row.subject,from:row.from_header,to:row.to_header,receivedAt:row.received_at.toISOString(),preview:row.preview,status:row.parse_status,sizeBytes:row.raw_size,direction:row.direction};}
interface Cursor{v:1;filter:string;at:string;id:string;ceilingAt:string;ceilingId:string}
function readCursor(raw:string|undefined,fingerprint:string):Cursor|null{
  if(raw===undefined)return null;if(raw.length>2048)invalid();let c:Cursor;try{c=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{invalid();}
  if(!c!||c.v!==1||c.filter!==fingerprint||!UUID.test(c.id)||!UUID.test(c.ceilingId)
    ||![c.at,c.ceilingAt].every(t=>typeof t==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(t)&&Number.isFinite(Date.parse(t))))invalid();return c;
}
const encodeCursor=(c:Cursor)=>Buffer.from(JSON.stringify(c)).toString('base64url');
export class MailService{
  constructor(readonly pool:Pool){}
  private async access(client:PoolClient,viewer:MailViewer,mailboxId:string,filing=false,lock=false):Promise<MailCapabilities>{
    if(!UUID.test(mailboxId))throw new ApiError(404,'not_found');
    if(!viewer.permissions.has('mailbox.use'))throw new ApiError(403,'forbidden');
    if(viewer.principalId===null){
      if(filing)throw new ApiError(403,'development_read_only');
      const row=await client.query('SELECT 1 FROM mailboxes WHERE id=$1 AND enabled',[mailboxId]);
      if(viewer.developmentMailboxId!==mailboxId||!row.rowCount)throw new ApiError(404,'not_found');
      return{canSetPersonalFlags:false,canManageMessages:false,canManageLabels:false};
    }
    const result=await client.query<{permissions:string[]}>(`SELECT mm.permissions FROM mailbox_memberships mm JOIN mailboxes m ON m.id=mm.mailbox_id
      JOIN principals p ON p.id=mm.principal_id WHERE mm.mailbox_id=$1 AND mm.principal_id=$2 AND mm.revoked_at IS NULL
      AND 'read'=ANY(mm.permissions) AND m.enabled AND p.access_enabled${lock?' FOR SHARE OF mm':''}`,[mailboxId,viewer.principalId]);
    const membership=result.rows[0];if(!membership)throw new ApiError(404,'not_found');
    const canManage=viewer.permissions.has('mail.manage')&&membership.permissions.includes('manage_messages');
    if(filing&&!canManage)throw new ApiError(403,'message_management_denied');
    return{canSetPersonalFlags:true,canManageMessages:canManage,canManageLabels:canManage};
  }
  private async read<T>(viewer:MailViewer,mailboxId:string,fn:(client:PoolClient,capabilities:MailCapabilities)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='2500ms'");
      const capabilities=await this.access(client,viewer,mailboxId);const value=await fn(client,capabilities);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK');if((error as {code?:string}).code==='57014')throw new ApiError(503,'mail_query_timeout');throw error;}finally{client.release();}
  }
  private async transaction<T>(mailboxId:string,authorize:AuthorizeMailTransaction,filing:boolean,fn:(client:PoolClient,viewer:MailViewer)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5000ms'");
      const viewer=await authorize(client);if(!viewer.principalId)throw new ApiError(403,'development_read_only');
      if(!UUID.test(mailboxId))throw new ApiError(404,'not_found');
      await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[mailboxId]);
      await this.access(client,viewer,mailboxId,filing,true);const value=await fn(client,viewer);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  private async currentSequence(client:PoolClient,mailboxId:string):Promise<string>{return(await client.query<{change_sequence:string}>('SELECT change_sequence FROM mailboxes WHERE id=$1',[mailboxId])).rows[0]!.change_sequence;}
  private async event(client:PoolClient,mailboxId:string,messageId:string|null,kind:string,actorId:string|null):Promise<void>{
    await appendChange(client,mailboxId,messageId,kind,{actorId});
  }
  async getState(viewer:MailViewer,mailboxId:string,messageId:string):Promise<MailMessageState&{direction:'inbound'|'outbound'}>{
    return this.read(viewer,mailboxId,async client=>{id(messageId);const row=(await client.query<StateRow>(`${projection} AND d.id=$3`,[mailboxId,viewer.principalId,messageId])).rows[0];if(!row)throw new ApiError(404,'not_found');return{...state(row),direction:row.direction};});
  }
  async list(viewer:MailViewer,mailboxId:string,options:MailListOptions={}):Promise<MailListResult>{
    const view=options.view??'messages',limit=options.limit??50,folder=options.folder??'inbox';
    if(!['messages','threads'].includes(view)||!Number.isInteger(limit)||limit<1||limit>100||![...folders,'all','sent'].includes(folder))invalid();
    if(options.q!==undefined&&(typeof options.q!=='string'||Buffer.byteLength(options.q)>512||/[\x00]/.test(options.q)))invalid();
    for(const value of[options.unread,options.starred])if(value!==undefined&&typeof value!=='boolean')invalid();
    if(options.labelId!==undefined)id(options.labelId);if(options.threadId!==undefined)id(options.threadId);
    const fingerprint=hash({mailboxId,actor:viewer.principalId,view,folder,unread:options.unread??null,starred:options.starred??null,labelId:options.labelId??null,q:options.q??'',threadId:options.threadId??null});
    const cursor=readCursor(options.cursor,fingerprint);
    return this.read(viewer,mailboxId,async(client,capabilities)=>{
      let resolvedThreadId=options.threadId;
      if(resolvedThreadId){
        // Pending conversations are listed with a delivery ID until parsing assigns
        // a thread. Resolve that old locator after ACL admission in this same MVCC
        // snapshot, preferring an actual mailbox-scoped thread identity.
        const thread=(await client.query<{id:string}>('SELECT id FROM mail_threads WHERE mailbox_id=$1 AND id=$2',[mailboxId,resolvedThreadId])).rows[0];
        if(thread)resolvedThreadId=thread.id;
        else{
          const message=(await client.query<{id:string}>(`SELECT COALESCE(s.thread_id,d.id) AS id FROM deliveries d
            LEFT JOIN mail_message_state s ON s.message_id=d.id AND s.mailbox_id=d.mailbox_id
            WHERE d.mailbox_id=$1 AND d.id=$2 AND d.deleted_at IS NULL`,[mailboxId,resolvedThreadId])).rows[0];
          if(!message)throw new ApiError(404,'not_found');
          resolvedThreadId=message.id;
        }
      }
      const values:unknown[]=[mailboxId,viewer.principalId],param=(value:unknown)=>{values.push(value);return`$${values.length}`;};
      const filing=folder==='all'?"folder NOT IN ('trash','spam')":folder==='sent'?"direction='outbound' AND folder NOT IN ('trash','spam')":`folder=${param(folder)}`;
      const extra:string[]=[];
      if(options.unread!==undefined)extra.push(`is_read=${param(!options.unread)}`);if(options.starred!==undefined)extra.push(`is_starred=${param(options.starred)}`);
      if(options.labelId)extra.push(`${param(options.labelId)}=ANY(label_ids)`);
      if(options.q){const q=param(`%${options.q.replace(/[\\%_]/g,'\\$&')}%`);extra.push(`(subject ILIKE ${q} OR from_header ILIKE ${q} OR to_header ILIKE ${q} OR cc_header ILIKE ${q} OR EXISTS (SELECT 1 FROM deliveries body WHERE body.id=visible.id AND body.mailbox_id=$1 AND body.deleted_at IS NULL AND body.plain_text ILIKE ${q}) OR EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.delivery_id=visible.id AND ma.filename ILIKE ${q}))`);}
      if(resolvedThreadId)extra.push(`COALESCE(thread_id,id)=${param(resolvedThreadId)}::uuid`);
      const matching=extra.length?extra.join(' AND '):'true';
      const page:string[]=[];if(cursor){page.push(`(received_at,id)<(${param(cursor.at)}::timestamptz,${param(cursor.id)}::uuid)`);page.push(`(received_at,id)<=(${param(cursor.ceilingAt)}::timestamptz,${param(cursor.ceilingId)}::uuid)`);}
      const suffix=`${page.length?'WHERE '+page.join(' AND '):''} ORDER BY received_at DESC,id DESC LIMIT ${param(limit+1)}`;
      const cte=`WITH base AS (${projection}), visible AS (SELECT * FROM base WHERE ${filing}), matched AS (SELECT * FROM visible WHERE ${matching})`;
      const changeSequence=await this.currentSequence(client,mailboxId);
      if(view==='messages'){
        const rows=(await client.query<StateRow>(`${cte} SELECT * FROM matched ${suffix}`,values)).rows;
        const first=rows[0],last=rows[Math.min(rows.length,limit)-1];
        const nextCursor=rows.length>limit&&last?encodeCursor({v:1,filter:fingerprint,at:last.cursor_at,id:last.id,ceilingAt:cursor?.ceilingAt??first!.cursor_at,ceilingId:cursor?.ceilingId??first!.id}):null;
        return{view,messages:rows.slice(0,limit).map(summary),nextCursor,changeSequence,capabilities};
      }
      type ThreadRow=StateRow&{message_count:string;matched_count:string;unread_count:string;starred:boolean;last_message_id:string};
      const rows=(await client.query<ThreadRow>(`${cte}, grouped AS (
        SELECT COALESCE(v.thread_id,v.id) AS tid,count(*) AS message_count,count(*) FILTER(WHERE NOT v.is_read) AS unread_count,bool_or(v.is_starred) AS starred
        FROM visible v WHERE COALESCE(v.thread_id,v.id) IN(SELECT COALESCE(thread_id,id) FROM matched) GROUP BY COALESCE(v.thread_id,v.id)),
        latest AS (SELECT DISTINCT ON(COALESCE(thread_id,id)) * FROM visible ORDER BY COALESCE(thread_id,id),received_at DESC,id DESC),
        result AS (SELECT g.tid AS id,l.id AS last_message_id,l.subject,l.preview,l.received_at,l.cursor_at,l.from_header,l.to_header,g.message_count,g.unread_count,g.starred,
        (SELECT count(*) FROM matched x WHERE COALESCE(x.thread_id,x.id)=g.tid) AS matched_count FROM grouped g JOIN latest l ON COALESCE(l.thread_id,l.id)=g.tid)
        SELECT * FROM result ${suffix}`,values)).rows;
      const first=rows[0],last=rows[Math.min(rows.length,limit)-1];const nextCursor=rows.length>limit&&last?encodeCursor({v:1,filter:fingerprint,at:last.cursor_at,id:last.id,ceilingAt:cursor?.ceilingAt??first!.cursor_at,ceilingId:cursor?.ceilingId??first!.id}):null;
      return{view,threads:rows.slice(0,limit).map(row=>({id:row.id,subject:row.subject,preview:row.preview,receivedAt:row.received_at.toISOString(),from:row.from_header,to:row.to_header,messageCount:Number(row.message_count),matchedCount:Number(row.matched_count),unreadCount:Number(row.unread_count),starred:row.starred,lastMessageId:row.last_message_id})),nextCursor,changeSequence,capabilities};
    });
  }
  async thread(viewer:MailViewer,mailboxId:string,threadId:string,options:MailListOptions={}):Promise<MailListResult>{
    return this.list(viewer,mailboxId,{...options,folder:options.folder??'all',threadId,view:'messages'});
  }
  private async rows(client:PoolClient,mailboxId:string,actor:string,ids:string[]):Promise<StateRow[]>{return(await client.query<StateRow>(`${projection} AND d.id=ANY($3::uuid[]) ORDER BY d.id`,[mailboxId,actor,ids])).rows;}
  private async operation(client:PoolClient,mailboxId:string,actor:string,operationId:string,digest:string):Promise<unknown|null>{
    const row=(await client.query<{request_sha256:string;result:unknown}>('SELECT request_sha256,result FROM mail_operations WHERE mailbox_id=$1 AND actor_id=$2 AND operation_id=$3',[mailboxId,actor,operationId])).rows[0];
    if(row&&row.request_sha256!==digest)throw new ApiError(409,'operation_id_conflict');return row?.result??null;
  }
  async mutate(mailboxId:string,value:unknown,authorize:AuthorizeMailTransaction):Promise<MailMutationResult>{
    const input=validateMailMutation(value),personal=input.set?.read!==undefined||input.set?.starred!==undefined,
      filing=input.set?.folder!==undefined||!!input.addLabelIds?.length||!!input.removeLabelIds?.length,digest=hash({kind:'messages',input});
    return this.transaction(mailboxId,authorize,filing,async(client,viewer)=>{
      const actor=viewer.principalId!,replay=await this.operation(client,mailboxId,actor,input.operationId,digest);if(replay)return replay as MailMutationResult;
      const ids=input.items.map(item=>item.id).sort();
      await client.query('SELECT id FROM deliveries WHERE mailbox_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[mailboxId,ids]);
      for(const messageId of ids)await initializeMessageState(client,{mailboxId,messageId});
      const before=await this.rows(client,mailboxId,actor,ids);if(before.length!==ids.length)throw new ApiError(404,'not_found');
      const wanted=new Map(input.items.map(item=>[item.id,parts(item.version)]));
      for(const row of before){const version=wanted.get(row.id)!;if((filing&&row.filing_version!==version[0])||(personal&&row.personal_version!==version[1]))throw new ApiError(409,'message_version_conflict');}
      const labels=[...new Set([...(input.addLabelIds??[]),...(input.removeLabelIds??[])])];
      if(labels.length&&(await client.query('SELECT id FROM mailbox_labels WHERE mailbox_id=$1 AND id=ANY($2::uuid[])',[mailboxId,labels])).rowCount!==labels.length)throw new ApiError(404,'label_not_found');
      const inverse=[];
      for(const row of before){
        if(personal){await client.query(`INSERT INTO principal_message_flags(mailbox_id,message_id,principal_id,is_read,is_starred) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(mailbox_id,message_id,principal_id) DO UPDATE SET is_read=EXCLUDED.is_read,is_starred=EXCLUDED.is_starred,flags_version=principal_message_flags.flags_version+1,updated_at=now()`,[mailboxId,row.id,actor,input.set?.read??row.is_read,input.set?.starred??row.is_starred]);
          await this.event(client,mailboxId,row.id,'message.personal_changed',actor);}
        if(filing){await client.query('UPDATE mail_message_state SET folder=$2,filing_version=filing_version+1,updated_at=now() WHERE message_id=$1',[row.id,input.set?.folder??row.folder]);
          if(input.removeLabelIds?.length)await client.query('DELETE FROM mail_message_labels WHERE mailbox_id=$1 AND message_id=$2 AND label_id=ANY($3::uuid[])',[mailboxId,row.id,input.removeLabelIds]);
          for(const label of input.addLabelIds??[])await client.query('INSERT INTO mail_message_labels(mailbox_id,message_id,label_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[mailboxId,row.id,label]);
          await this.event(client,mailboxId,row.id,'message.filing_changed',null);}
        inverse.push({id:row.id,personal,filing,read:row.is_read,starred:row.is_starred,folder:row.folder,labelIds:row.label_ids,
          afterFiling:filing?(BigInt(row.filing_version)+1n).toString():row.filing_version,afterPersonal:personal?(BigInt(row.personal_version)+1n).toString():row.personal_version});
      }
      const undoUntil=new Date(Date.now()+30_000).toISOString();const result:MailMutationResult={operationId:input.operationId,messages:(await this.rows(client,mailboxId,actor,ids)).map(state),changeSequence:await this.currentSequence(client,mailboxId),undoUntil};
      await client.query('INSERT INTO mail_operations(mailbox_id,actor_id,operation_id,kind,request_sha256,result,inverse,undo_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[mailboxId,actor,input.operationId,'messages',digest,JSON.stringify(result),JSON.stringify(inverse),undoUntil]);return result;
    });
  }
  async undo(mailboxId:string,operationId:string,authorize:AuthorizeMailTransaction):Promise<MailMutationResult>{
    id(operationId);return this.transaction(mailboxId,authorize,false,async(client,viewer)=>{
      const actor=viewer.principalId!;type Inverse={id:string;personal:boolean;filing:boolean;read:boolean;starred:boolean;folder:string;labelIds:string[];afterFiling:string;afterPersonal:string};
      const op=(await client.query<{kind:string;inverse:Inverse[]|null;undo_until:Date|null;undone_result:MailMutationResult|null}>('SELECT kind,inverse,undo_until,undone_result FROM mail_operations WHERE mailbox_id=$1 AND actor_id=$2 AND operation_id=$3',[mailboxId,actor,operationId])).rows[0];
      if(!op||op.kind!=='messages'||!op.inverse)throw new ApiError(404,'operation_not_found');
      if(op.inverse.some(item=>item.filing))await this.access(client,viewer,mailboxId,true,true);
      if(op.undone_result)return op.undone_result;
      if(!op.undo_until||op.undo_until.getTime()<Date.now())throw new ApiError(409,'undo_expired');
      const ids=op.inverse.map(item=>item.id).sort();await client.query('SELECT id FROM deliveries WHERE mailbox_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[mailboxId,ids]);
      const rows=await this.rows(client,mailboxId,actor,ids),byId=new Map(rows.map(row=>[row.id,row]));if(rows.length!==ids.length)throw new ApiError(409,'undo_conflict');
      for(const item of op.inverse){const row=byId.get(item.id)!;if((item.filing&&row.filing_version!==item.afterFiling)||(item.personal&&row.personal_version!==item.afterPersonal))throw new ApiError(409,'undo_conflict');
        if(item.filing&&item.labelIds.length&&(await client.query('SELECT id FROM mailbox_labels WHERE mailbox_id=$1 AND id=ANY($2::uuid[])',[mailboxId,item.labelIds])).rowCount!==item.labelIds.length)throw new ApiError(409,'undo_conflict');}
      for(const item of op.inverse){
        if(item.personal){await client.query('UPDATE principal_message_flags SET is_read=$4,is_starred=$5,flags_version=flags_version+1,updated_at=now() WHERE mailbox_id=$1 AND message_id=$2 AND principal_id=$3',[mailboxId,item.id,actor,item.read,item.starred]);await this.event(client,mailboxId,item.id,'message.personal_changed',actor);}
        if(item.filing){await client.query('UPDATE mail_message_state SET folder=$2,filing_version=filing_version+1,updated_at=now() WHERE message_id=$1',[item.id,item.folder]);await client.query('DELETE FROM mail_message_labels WHERE mailbox_id=$1 AND message_id=$2',[mailboxId,item.id]);for(const label of item.labelIds)await client.query('INSERT INTO mail_message_labels(mailbox_id,message_id,label_id) VALUES($1,$2,$3)',[mailboxId,item.id,label]);await this.event(client,mailboxId,item.id,'message.filing_changed',null);}
      }
      const result:MailMutationResult={operationId,messages:(await this.rows(client,mailboxId,actor,ids)).map(state),changeSequence:await this.currentSequence(client,mailboxId),undoUntil:null};
      await client.query('UPDATE mail_operations SET undone_result=$4 WHERE mailbox_id=$1 AND actor_id=$2 AND operation_id=$3',[mailboxId,actor,operationId,JSON.stringify(result)]);return result;
    });
  }
  async labels(viewer:MailViewer,mailboxId:string):Promise<{labels:MailLabel[];capabilities:MailCapabilities}>{return this.read(viewer,mailboxId,async(client,capabilities)=>({labels:(await client.query<MailLabel>('SELECT id,name,color,version::text FROM mailbox_labels WHERE mailbox_id=$1 ORDER BY lower(name),id',[mailboxId])).rows,capabilities}));}
  async mutateLabel(mailboxId:string,action:'create'|'update'|'delete',labelId:string|undefined,value:unknown,authorize:AuthorizeMailTransaction):Promise<MailLabelMutationResult>{
    const input=record(value);exactKeys(input,action==='create'?['operationId','name','color']:action==='update'?['operationId','expectedVersion','name','color']:['operationId','expectedVersion']);
    const operationId=id(input.operationId);if(action!=='create'){id(labelId);if(!sequence(input.expectedVersion))invalid();}
    if(action==='create'||input.name!==undefined){if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100||/[\x00-\x1f\x7f]/.test(input.name))invalid();}
    if(input.color!==undefined&&input.color!==null&&(typeof input.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(input.color)))invalid();
    if(action==='update'&&input.name===undefined&&input.color===undefined)invalid();
    const digest=hash({action,labelId:labelId??null,input});
    return this.transaction(mailboxId,authorize,true,async(client,viewer)=>{
      const actor=viewer.principalId!,replay=await this.operation(client,mailboxId,actor,operationId,digest);if(replay)return replay as MailLabelMutationResult;
      let label:MailLabel|undefined;
      if(action==='create'){
        if(Number((await client.query<{n:string}>('SELECT count(*) AS n FROM mailbox_labels WHERE mailbox_id=$1',[mailboxId])).rows[0]!.n)>=100)throw new ApiError(409,'label_limit');
        label={id:randomUUID(),name:(input.name as string).trim(),color:typeof input.color==='string'?input.color.toLowerCase():null,version:'1'};
      }else{label=(await client.query<MailLabel>('SELECT id,name,color,version::text FROM mailbox_labels WHERE mailbox_id=$1 AND id=$2 FOR UPDATE',[mailboxId,labelId])).rows[0];if(!label)throw new ApiError(404,'label_not_found');if(label.version!==input.expectedVersion)throw new ApiError(409,'label_version_conflict');}
      if(action!=='delete'){
        label.name=input.name===undefined?label.name:(input.name as string).trim();label.color=input.color===undefined?label.color:typeof input.color==='string'?input.color.toLowerCase():null;
        if((await client.query('SELECT 1 FROM mailbox_labels WHERE mailbox_id=$1 AND lower(name)=lower($2) AND id<>$3',[mailboxId,label.name,label.id])).rowCount)throw new ApiError(409,'label_name_conflict');
        if(action==='create')await client.query('INSERT INTO mailbox_labels(id,mailbox_id,name,color) VALUES($1,$2,$3,$4)',[label.id,mailboxId,label.name,label.color]);
        else{label.version=(BigInt(label.version)+1n).toString();await client.query('UPDATE mailbox_labels SET name=$3,color=$4,version=version+1 WHERE mailbox_id=$1 AND id=$2',[mailboxId,label.id,label.name,label.color]);}
      }else{
        // Invalidate filing versions before cascading associations, so pending undo cannot resurrect a deleted label.
        await client.query(`UPDATE mail_message_state SET filing_version=filing_version+1,updated_at=now() WHERE mailbox_id=$1 AND message_id IN
          (SELECT message_id FROM mail_message_labels WHERE mailbox_id=$1 AND label_id=$2)`,[mailboxId,label.id]);
        await client.query('DELETE FROM mailbox_labels WHERE mailbox_id=$1 AND id=$2',[mailboxId,label.id]);
      }
      await this.event(client,mailboxId,null,`label.${action}`,null);const result:MailLabelMutationResult={operationId,...(action==='delete'?{deletedId:label.id}:{label}),changeSequence:await this.currentSequence(client,mailboxId)};
      await client.query('INSERT INTO mail_operations(mailbox_id,actor_id,operation_id,kind,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6)',[mailboxId,actor,operationId,`label.${action}`,digest,JSON.stringify(result)]);return result;
    });
  }
  async changes(viewer:MailViewer,mailboxId:string,after:string,limit=500):Promise<MailChangesResult>{
    if(!sequence(after)||!Number.isInteger(limit)||limit<1||limit>500)invalid();
    return this.read(viewer,mailboxId,async client=>{
      const current=await this.currentSequence(client,mailboxId);if(BigInt(after)>BigInt(current))throw new ApiError(409,'mail_cursor_ahead');
      const minimum=(await client.query<{min:string|null}>('SELECT min(sequence)::text AS min FROM mailbox_changes WHERE mailbox_id=$1',[mailboxId])).rows[0]!.min;
      if((minimum&&BigInt(after)<BigInt(minimum)-1n)||(!minimum&&current!=='0'&&after!==current))return{changes:[],nextSequence:current,hasMore:false,resetRequired:true};
      // Page the full sequence domain, then filter personal events. This advances over another actor's invisible events.
      const rows=(await client.query<{sequence:string;kind:string;delivery_id:string|null;actor_principal_id:string|null}>(`SELECT sequence,kind,delivery_id,actor_principal_id FROM mailbox_changes
        WHERE mailbox_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,[mailboxId,after,limit+1])).rows;
      const selected=rows.slice(0,limit);return{changes:selected.filter(row=>row.actor_principal_id===null||row.actor_principal_id===viewer.principalId).map(row=>({sequence:row.sequence,kind:row.kind,messageId:row.delivery_id})),nextSequence:selected.at(-1)?.sequence??current,hasMore:rows.length>limit,resetRequired:false};
    });
  }
}
