import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendChange } from '../database.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Conservative common/quoted msg-id normalization; never lowercase identifiers. */
export function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 998) return null;
  let token = value.trim(); if (token.startsWith('<') && token.endsWith('>')) token = token.slice(1, -1);
  const quoted = /^"([^"\\\r\n]+)"@([^\s<>@]+)$/.exec(token);
  if (quoted) token = `${quoted[1]}@${quoted[2]}`;
  return /^[!#$%&'*+\-/=?^_`{|}~A-Za-z0-9.]+@[^\s<>@\x00-\x1f\x7f]+$/.test(token) ? token : null;
}
export interface ThreadIndexInput {
  mailboxId: string; messageId: string; messageIdHeader?: string | null;
  references?: string[]; inReplyTo?: string[]; parserVersion?: number;
}
export async function initializeMessageState(client: PoolClient, input: { mailboxId: string; messageId: string; direction?: 'inbound' | 'outbound' }): Promise<void> {
  // Derive direction from the persisted record; a caller cannot relabel another message.
  await client.query(`INSERT INTO mail_message_state(message_id,mailbox_id,folder)
    SELECT id,mailbox_id,CASE WHEN direction='outbound' THEN 'archive' ELSE 'inbox' END FROM deliveries
    WHERE id=$1 AND mailbox_id=$2 ON CONFLICT(message_id) DO NOTHING`, [input.messageId,input.mailboxId]);
}
export async function indexMessageThread(client: PoolClient, input: ThreadIndexInput): Promise<string> {
  if (!UUID.test(input.mailboxId) || !UUID.test(input.messageId)) throw new Error('invalid_thread_identity');
  await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[input.mailboxId]);
  await initializeMessageState(client,input);
  const current = await client.query<{thread_id:string|null}>(`SELECT s.thread_id FROM mail_message_state s JOIN deliveries d ON d.id=s.message_id
    WHERE s.message_id=$1 AND s.mailbox_id=$2 AND d.deleted_at IS NULL`,[input.messageId,input.mailboxId]);
  if (!current.rows[0]) throw new Error('thread_message_missing');
  const warnings = new Set<string>();
  const normalize = (values: string[] | undefined) => {
    if (!Array.isArray(values)) return [];
    if (values.length>100) warnings.add('reference_limit');
    const out:string[]=[]; let size=0;
    for(const value of values.slice(0,100)){const token=normalizeMessageId(value);if(!token){warnings.add('invalid_reference');continue;}
      size+=Buffer.byteLength(token);if(size>16384){warnings.add('reference_limit');break;}if(!out.includes(token))out.push(token);}
    return out;
  };
  const own=normalizeMessageId(input.messageIdHeader), references=normalize(input.references), inReplyTo=normalize(input.inReplyTo);
  const ancestry=(references.length?references:inReplyTo.slice(0,1)).filter(token=>{if(token===own){warnings.add('self_reference');return false;}return true;});
  const tokens=[...new Set([...ancestry,...(own?[own]:[])])];
  const result=await client.query<{token:string;thread_id:string;claim_message_id:string|null;ambiguous:boolean}>(
    'SELECT * FROM mail_thread_keys WHERE mailbox_id=$1 AND token=ANY($2::text[])',[input.mailboxId,tokens]);
  const keys=new Map(result.rows.map(row=>[row.token,row]));const ownKey=own?keys.get(own):undefined;
  const duplicate=!!ownKey?.claim_message_id&&ownKey.claim_message_id!==input.messageId;
  if(duplicate){warnings.add('duplicate_message_id');await client.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2',[input.mailboxId,own]);}
  const known=ancestry.map(token=>keys.get(token)).filter(row=>row&&!row.ambiguous);
  if(new Set(known.map(row=>row!.thread_id)).size>1)warnings.add('conflicting_thread_references');
  // Existing memberships never move solely because an untrusted new header bridges threads.
  let threadId=current.rows[0].thread_id ?? (!duplicate&&!ownKey?.ambiguous?ownKey?.thread_id:undefined) ?? known.at(-1)?.thread_id;
  if(!threadId){threadId=randomUUID();await client.query('INSERT INTO mail_threads(id,mailbox_id) VALUES($1,$2)',[threadId,input.mailboxId]);}
  for(const token of ancestry)await client.query(`INSERT INTO mail_thread_keys(mailbox_id,token,thread_id) VALUES($1,$2,$3)
    ON CONFLICT(mailbox_id,token) DO NOTHING`,[input.mailboxId,token,threadId]);
  if(own&&!duplicate)await client.query(`INSERT INTO mail_thread_keys(mailbox_id,token,thread_id,claim_message_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(mailbox_id,token) DO UPDATE SET claim_message_id=EXCLUDED.claim_message_id
    WHERE mail_thread_keys.claim_message_id IS NULL AND NOT mail_thread_keys.ambiguous`,[input.mailboxId,own,threadId,input.messageId]);
  await client.query('UPDATE mail_message_state SET thread_id=$2 WHERE message_id=$1',[input.messageId,threadId]);
  await client.query(`INSERT INTO mail_thread_headers(message_id,mailbox_id,parser_version,message_id_header,reference_ids,in_reply_to,warnings)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(message_id) DO UPDATE SET parser_version=EXCLUDED.parser_version,
    message_id_header=EXCLUDED.message_id_header,reference_ids=EXCLUDED.reference_ids,in_reply_to=EXCLUDED.in_reply_to,warnings=EXCLUDED.warnings,indexed_at=now()`,
    [input.messageId,input.mailboxId,input.parserVersion??1,own,JSON.stringify(references),JSON.stringify(inReplyTo),JSON.stringify([...warnings])]);
  return threadId;
}
/** Bounded metadata-only backfill. The parser remains responsible for reading original MIME. */
export async function backfillMailState(pool:Pool,options:{limit?:number}={}):Promise<number>{
  const limit=options.limit??100;if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('invalid_backfill_limit');
  let count=0;
  for(let i=0;i<limit;i++){
    const client=await pool.connect();try{await client.query('BEGIN');
      const candidate=await client.query<{id:string;mailbox_id:string}>(`SELECT d.id,d.mailbox_id FROM deliveries d LEFT JOIN mail_message_state s ON s.message_id=d.id
        JOIN message_reader_data rd ON rd.delivery_id=d.id AND rd.parser_version>=2
          AND jsonb_typeof(rd.headers->'references')='array' AND jsonb_typeof(rd.headers->'inReplyTo')='array'
        WHERE d.deleted_at IS NULL AND d.parse_status='parsed' AND s.thread_id IS NULL ORDER BY d.stored_at,d.id LIMIT 1`);
      const row=candidate.rows[0];if(!row){await client.query('COMMIT');break;}
      await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[row.mailbox_id]);
      const existing=await client.query('SELECT 1 FROM mail_message_state WHERE message_id=$1 AND thread_id IS NOT NULL',[row.id]);
      if(existing.rowCount){await client.query('COMMIT');continue;}
      const reader=await client.query<{headers:{messageId?:string;references?:string[];inReplyTo?:string[]};parser_version:number}>(
        'SELECT headers,parser_version FROM message_reader_data WHERE delivery_id=$1',[row.id]);
      const h=reader.rows[0]?.headers;
      await indexMessageThread(client,{mailboxId:row.mailbox_id,messageId:row.id,messageIdHeader:h?.messageId,
        references:h?.references,inReplyTo:h?.inReplyTo,parserVersion:reader.rows[0]?.parser_version??1});
      await appendChange(client,row.mailbox_id,row.id,'message.threaded');await client.query('COMMIT');count++;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }return count;
}
