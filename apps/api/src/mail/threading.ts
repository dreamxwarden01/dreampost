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
/** A provider wire identity must be explicitly typed as RFC Message-ID, not an opaque tracking ID. */
export function normalizeProviderRfcMessageId(value: unknown): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 998 || !/^[\x21-\x7e]+$/.test(value)
    || !value.startsWith('<') || !value.endsWith('>')) return null;
  // Restrict provider evidence to unambiguous ASCII dot-atom IDs; unsupported
  // obsolete/commented/quoted forms remain opaque rather than being guessed.
  const atom = "[A-Za-z0-9!#$%&'*+\\/=?^_`{|}~\\-]+";
  const dotAtom = `${atom}(?:\\.${atom})*`;
  return new RegExp(`^<${dotAtom}@${dotAtom}>$`).test(value) ? value : null;
}
/** Read-only trusted provider identity lookup, also used when composing a reply to Sent. */
export async function getOutboundRfcMessageId(client: PoolClient, input: { mailboxId: string; messageId: string }): Promise<string | null> {
  if (!UUID.test(input.mailboxId) || !UUID.test(input.messageId)) return null;
  const row = (await client.query<{ rfc_message_id: string | null }>(`
    SELECT s.rfc_message_id FROM deliveries d JOIN outbound_submissions s ON s.id=d.id AND s.mailbox_id=d.mailbox_id
    WHERE d.id=$1 AND d.mailbox_id=$2 AND d.deleted_at IS NULL AND d.direction='outbound'
      AND s.state IN ('accepted','partial') AND s.raw_sha256=d.sha256 AND s.raw_size=d.raw_size
      AND (s.sent_message_id IS NULL OR s.sent_message_id=d.id)
      AND d.metadata->>'kind'='outbound' AND d.metadata->>'submissionId'=d.id::text`, [input.messageId,input.mailboxId])).rows[0];
  return normalizeProviderRfcMessageId(row?.rfc_message_id);
}
export interface OutboundMessageIdLink {
  threadId: string | null;
  status: 'linked' | 'adopted' | 'unchanged' | 'ignored' | 'conflict';
}
/**
 * Caller owns the business transaction. Only accepted provider evidence tied to
 * the exact immutable Sent delivery may add a wire-ID alias. Incoming MIME and
 * delivery metadata alone cannot confer this authority.
 */
export async function linkOutboundMessageId(client: PoolClient, input: { mailboxId: string; messageId: string }): Promise<OutboundMessageIdLink> {
  if (!UUID.test(input.mailboxId) || !UUID.test(input.messageId)) throw new Error('invalid_thread_identity');
  await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE', [input.mailboxId]);
  const row = (await client.query<{ thread_id: string | null }>(`
    SELECT ms.thread_id FROM deliveries d JOIN mail_message_state ms ON ms.message_id=d.id AND ms.mailbox_id=d.mailbox_id
    WHERE d.id=$1 AND d.mailbox_id=$2 AND d.deleted_at IS NULL`, [input.messageId,input.mailboxId])).rows[0];
  const currentThread = row?.thread_id ?? null;
  const wire = await getOutboundRfcMessageId(client,input);
  if (!row || !currentThread || !wire) return { threadId: currentThread, status: 'ignored' };
  const token = normalizeMessageId(wire)!;
  type KeyRow = { token: string; thread_id: string; claim_message_id: string | null; ambiguous: boolean };
  const alias = (await client.query<KeyRow>('SELECT token,thread_id,claim_message_id,ambiguous FROM mail_thread_keys WHERE mailbox_id=$1 AND token=$2 FOR UPDATE',
    [input.mailboxId,token])).rows[0];
  const conflict = async (): Promise<OutboundMessageIdLink> => {
    await client.query(`UPDATE mail_thread_headers SET warnings=CASE WHEN warnings ? 'provider_message_id_conflict'
      THEN warnings ELSE warnings || '["provider_message_id_conflict"]'::jsonb END WHERE message_id=$1 AND mailbox_id=$2`, [input.messageId,input.mailboxId]);
    return { threadId: currentThread, status: 'conflict' };
  };
  if (alias?.ambiguous) return conflict();
  if (alias?.claim_message_id && alias.claim_message_id !== input.messageId) {
    // Preserve the first claim for evidence, but stop future references from
    // arbitrarily selecting it after a distinct provider-backed identity collides.
    await client.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2', [input.mailboxId,token]);
    return conflict();
  }
  if (!alias) {
    await client.query('INSERT INTO mail_thread_keys(mailbox_id,token,thread_id,claim_message_id) VALUES($1,$2,$3,$4)',
      [input.mailboxId,token,currentThread,input.messageId]);
    await appendChange(client,input.mailboxId,input.messageId,'message.threaded',{data:{reason:'provider_message_id_linked'}});
    return { threadId: currentThread, status: 'linked' };
  }
  if (alias.thread_id === currentThread) {
    if (alias.claim_message_id === input.messageId) return { threadId: currentThread, status: 'unchanged' };
    await client.query('UPDATE mail_thread_keys SET claim_message_id=$3 WHERE mailbox_id=$1 AND token=$2 AND claim_message_id IS NULL AND NOT ambiguous',
      [input.mailboxId,token,input.messageId]);
    await appendChange(client,input.mailboxId,input.messageId,'message.threaded',{data:{reason:'provider_message_id_linked'}});
    return { threadId: currentThread, status: 'linked' };
  }
  // A claimed alias in a different established thread is not a merge permit.
  if (alias.claim_message_id !== null) return conflict();
  const members = (await client.query<{ message_id: string }>('SELECT message_id FROM mail_message_state WHERE mailbox_id=$1 AND thread_id=$2 ORDER BY message_id FOR UPDATE',
    [input.mailboxId,currentThread])).rows;
  const ownedKeys = (await client.query<KeyRow>('SELECT token,thread_id,claim_message_id,ambiguous FROM mail_thread_keys WHERE mailbox_id=$1 AND thread_id=$2 ORDER BY token FOR UPDATE',
    [input.mailboxId,currentThread])).rows;
  // Include deleted members: tombstoning another message cannot manufacture a singleton.
  if (members.length !== 1 || members[0]!.message_id !== input.messageId || !ownedKeys.length
    || ownedKeys.some(key => key.ambiguous || key.claim_message_id !== input.messageId)) return conflict();
  // A placeholder can have been introduced by a bridge into an unrelated thread.
  // Prove the destination too, including deleted members. The mailbox lock keeps
  // this metadata-only proof and the following moves in one serialized decision.
  // Incomplete reference chains deliberately stay separate rather than guessing.
  const destination = (await client.query<{ compatible: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM mail_message_state WHERE mailbox_id=$1 AND thread_id=$2)
      AND NOT EXISTS(
        SELECT 1 FROM mail_message_state ms LEFT JOIN mail_thread_headers h
          ON h.message_id=ms.message_id AND h.mailbox_id=ms.mailbox_id
        WHERE ms.mailbox_id=$1 AND ms.thread_id=$2 AND NOT COALESCE(
          h.parser_version>=2 AND h.message_id_header IS DISTINCT FROM $3 AND
          CASE WHEN jsonb_typeof(h.reference_ids)='array' AND jsonb_typeof(h.in_reply_to)='array'
            THEN CASE WHEN jsonb_array_length(h.reference_ids)>0
              THEN h.reference_ids @> jsonb_build_array($3::text)
              ELSE h.in_reply_to->>0=$3 END
            ELSE false END, false))
      AND NOT EXISTS(
        SELECT 1 FROM mail_thread_keys k WHERE k.mailbox_id=$1 AND k.thread_id=$2
          AND (k.ambiguous OR (k.claim_message_id IS NULL AND k.token<>$3)
            OR (k.claim_message_id IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM mail_message_state ms WHERE ms.mailbox_id=k.mailbox_id
                AND ms.thread_id=k.thread_id AND ms.message_id=k.claim_message_id)))) AS compatible`,
    [input.mailboxId,alias.thread_id,token])).rows[0];
  if (!destination?.compatible) return conflict();
  const claimed = await client.query(`UPDATE mail_thread_keys SET claim_message_id=$4 WHERE mailbox_id=$1 AND token=$2 AND thread_id=$3
    AND claim_message_id IS NULL AND NOT ambiguous`, [input.mailboxId,token,alias.thread_id,input.messageId]);
  if (claimed.rowCount !== 1) throw new Error('provider_alias_changed_during_admission');
  const movedKeys = await client.query(`UPDATE mail_thread_keys SET thread_id=$3 WHERE mailbox_id=$1 AND thread_id=$2
    AND claim_message_id=$4 AND NOT ambiguous`, [input.mailboxId,currentThread,alias.thread_id,input.messageId]);
  const moved = await client.query('UPDATE mail_message_state SET thread_id=$3,updated_at=now() WHERE mailbox_id=$1 AND message_id=$2 AND thread_id=$4',
    [input.mailboxId,input.messageId,alias.thread_id,currentThread]);
  if (movedKeys.rowCount !== ownedKeys.length || moved.rowCount !== 1) throw new Error('sent_thread_changed_during_adoption');
  // Retain the old empty row. Message locators remain stable, but its old thread
  // UUID URL can be empty; preserving that bookmark would require a separate redirect feature.
  await appendChange(client,input.mailboxId,input.messageId,'message.threaded',
    {data:{reason:'provider_placeholder_adopted',previousThreadId:currentThread,threadId:alias.thread_id}});
  return { threadId: alias.thread_id, status: 'adopted' };
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
  const linked = await linkOutboundMessageId(client, input);
  return linked.threadId ?? threadId;
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
