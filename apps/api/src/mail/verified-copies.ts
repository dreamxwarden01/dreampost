import type { Pool, PoolClient } from 'pg';
import { appendChange } from '../database.js';
import { getOutboundRfcMessageId, normalizeMessageId } from './threading.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_CANDIDATES = 100;
export interface MailContentFingerprintInput {
  deliveryId: string; mailboxId: string; version: number; sha256: string | null; rawSha256: string; rawSize: number;
}
/** Store only a complete, versioned result bound to this exact immutable delivery. */
export async function storeMailContentFingerprint(client: PoolClient, value: MailContentFingerprintInput): Promise<void> {
  if (!UUID.test(value.deliveryId) || !UUID.test(value.mailboxId) || value.version !== 1
    || (value.sha256 !== null && !SHA.test(value.sha256)) || !SHA.test(value.rawSha256)
    || !Number.isSafeInteger(value.rawSize) || value.rawSize < 1) throw new Error('invalid_mail_fingerprint');
  const result = await client.query(`INSERT INTO mail_content_fingerprints(delivery_id,mailbox_id,version,sha256,raw_sha256,raw_size)
    SELECT id,mailbox_id,$3,$4,$5,$6 FROM deliveries WHERE id=$1 AND mailbox_id=$2 AND sha256=$5 AND raw_size=$6
    ON CONFLICT(delivery_id) DO UPDATE SET delivery_id=EXCLUDED.delivery_id
      WHERE mail_content_fingerprints.mailbox_id=EXCLUDED.mailbox_id AND mail_content_fingerprints.version=EXCLUDED.version
        AND mail_content_fingerprints.sha256 IS NOT DISTINCT FROM EXCLUDED.sha256
        AND mail_content_fingerprints.raw_sha256=EXCLUDED.raw_sha256 AND mail_content_fingerprints.raw_size=EXCLUDED.raw_size
    RETURNING delivery_id`, [value.deliveryId,value.mailboxId,value.version,value.sha256,value.rawSha256,value.rawSize]);
  if (result.rowCount !== 1) throw new Error('mail_fingerprint_identity_conflict');
}
export async function recordThreadIdentityClaim(client: PoolClient, mailboxId: string, token: string, messageId: string): Promise<void> {
  await client.query(`INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id) VALUES($1,$2,$3)
    ON CONFLICT DO NOTHING`, [mailboxId,token,messageId]);
}
export async function equivalentCopyClaims(client: PoolClient, mailboxId: string, first: string, second: string): Promise<boolean> {
  if (first === second) return true;
  const result = await client.query<{ equivalent: boolean }>(`SELECT
    COALESCE((SELECT sent_message_id FROM mail_verified_copies WHERE mailbox_id=$1 AND inbound_message_id=$2),$2::uuid)
      = COALESCE((SELECT sent_message_id FROM mail_verified_copies WHERE mailbox_id=$1 AND inbound_message_id=$3),$3::uuid) AS equivalent`,
  [mailboxId,first,second]);
  return result.rows[0]?.equivalent === true;
}
interface CopyCandidate {
  inbound_id: string; sent_id: string; version: number; fingerprint: string; token: string;
  recipient: string; allocation_id: string; revision: string; policy_digest: string;
  inbound_sha: string; inbound_size: number; sent_sha: string; sent_size: number;
  inbound_thread_id: string | null; sent_thread_id: string;
}
/** Adopt a bounded closed branch rooted in a proved copy, or recheck every member after canonical wire proof. */
async function moveVerifiedCopyBranch(client:PoolClient,input:{mailboxId:string;sentId:string;inboundId:string;token:string;sourceThreadId:string|null;targetThreadId:string;replyRoot?:boolean}):Promise<number>{
  if(!input.sourceThreadId||input.sourceThreadId===input.targetThreadId)return 0;
  const proof=(await client.query<{compatible:boolean;member_ids:string[];key_count:number}>(`
    WITH members AS MATERIALIZED (
      SELECT message_id FROM mail_message_state WHERE mailbox_id=$1 AND thread_id=$2 ORDER BY message_id LIMIT 101
    ), branch_keys AS MATERIALIZED (
      SELECT token,claim_message_id,ambiguous,ambiguity_unproven FROM mail_thread_keys
      WHERE mailbox_id=$1 AND thread_id=$2 ORDER BY token LIMIT 1001
    ) SELECT (SELECT count(*) FROM members) BETWEEN 1 AND 100
      AND (SELECT count(*) FROM branch_keys)<=1000
      AND EXISTS(SELECT 1 FROM members WHERE message_id=$3)
      AND NOT EXISTS(
        SELECT 1 FROM members m LEFT JOIN mail_thread_headers h ON h.mailbox_id=$1 AND h.message_id=m.message_id
        CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(h.reference_ids)='array' AND jsonb_typeof(h.in_reply_to)='array'
          THEN CASE WHEN jsonb_array_length(h.reference_ids)>0 THEN h.reference_ids
            ELSE jsonb_build_array(h.in_reply_to->0) END ELSE '[]'::jsonb END AS ancestry) a
        WHERE (m.message_id<>$3 OR $6::boolean) AND NOT EXISTS(SELECT 1 FROM mail_verified_copies v
          WHERE v.mailbox_id=$1 AND v.inbound_message_id=m.message_id AND v.sent_message_id=$4)
        AND NOT COALESCE(h.parser_version>=2 AND h.message_id_header IS DISTINCT FROM $5
          AND jsonb_typeof(h.warnings)='array'
          AND NOT h.warnings ?| ARRAY['reference_limit','invalid_reference','self_reference','conflicting_thread_references','duplicate_message_id']
          AND a.ancestry @> jsonb_build_array($5::text)
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.ancestry) ref
            WHERE jsonb_typeof(ref)<>'string' OR (ref #>> '{}')<>$5 AND NOT EXISTS(
              SELECT 1 FROM branch_keys k JOIN members owner ON owner.message_id=k.claim_message_id
              WHERE k.token=(ref #>> '{}') AND NOT k.ambiguous AND NOT k.ambiguity_unproven)),false))
      AND NOT EXISTS(SELECT 1 FROM branch_keys k WHERE k.ambiguity_unproven OR
        (k.token<>$5 AND (k.ambiguous OR k.claim_message_id IS NULL
          OR NOT EXISTS(SELECT 1 FROM members m WHERE m.message_id=k.claim_message_id)
          OR EXISTS(SELECT 1 FROM mail_thread_identity_claims c WHERE c.mailbox_id=$1 AND c.token=k.token
            AND NOT EXISTS(SELECT 1 FROM members m WHERE m.message_id=c.message_id)))))
      AND NOT EXISTS(SELECT 1 FROM mail_thread_keys WHERE mailbox_id=$1 AND token=$5 AND ambiguity_unproven)
      AND NOT EXISTS(SELECT 1 FROM mail_thread_identity_claims c WHERE c.mailbox_id=$1 AND c.token=$5
        AND c.message_id<>$4 AND ($6::boolean OR c.message_id<>$3) AND NOT EXISTS(SELECT 1 FROM mail_verified_copies v
          WHERE v.mailbox_id=$1 AND v.inbound_message_id=c.message_id AND v.sent_message_id=$4))
      AND NOT EXISTS(SELECT 1 FROM mail_thread_keys k WHERE k.mailbox_id=$1 AND k.token=$5
        AND k.claim_message_id IS NOT NULL AND k.claim_message_id<>$4 AND ($6::boolean OR k.claim_message_id<>$3)
        AND NOT EXISTS(SELECT 1 FROM mail_verified_copies v WHERE v.mailbox_id=$1
          AND v.inbound_message_id=k.claim_message_id AND v.sent_message_id=$4))
      AND NOT EXISTS(SELECT 1 FROM outbound_submissions WHERE mailbox_id=$1 AND rfc_message_id='<'||$5||'>'
        AND state IN ('accepted','partial') AND id<>$4)
      AND NOT EXISTS(SELECT 1 FROM mail_verified_copies v WHERE v.mailbox_id=$1 AND (
        (EXISTS(SELECT 1 FROM members m WHERE m.message_id=v.sent_message_id)
          AND NOT EXISTS(SELECT 1 FROM members m WHERE m.message_id=v.inbound_message_id)) OR
        (v.sent_message_id<>$4 AND EXISTS(SELECT 1 FROM members m WHERE m.message_id=v.inbound_message_id)
          AND NOT EXISTS(SELECT 1 FROM members m WHERE m.message_id=v.sent_message_id)))) AS compatible,
      ARRAY(SELECT message_id FROM members) AS member_ids,(SELECT count(*)::int FROM branch_keys) AS key_count`,
    [input.mailboxId,input.sourceThreadId,input.inboundId,input.sentId,input.token,input.replyRoot??false])).rows[0];
  if(!proof?.compatible)return 0;
  const keys=await client.query('UPDATE mail_thread_keys SET thread_id=$3 WHERE mailbox_id=$1 AND thread_id=$2',
    [input.mailboxId,input.sourceThreadId,input.targetThreadId]);
  const moved=await client.query('UPDATE mail_message_state SET thread_id=$3,updated_at=now() WHERE mailbox_id=$1 AND thread_id=$2 AND message_id=ANY($4::uuid[])',
    [input.mailboxId,input.sourceThreadId,input.targetThreadId,proof.member_ids]);
  if(keys.rowCount!==proof.key_count||moved.rowCount!==proof.member_ids.length)throw new Error('copy_branch_changed_during_admission');
  for(const id of proof.member_ids)await appendChange(client,input.mailboxId,id,'message.threaded',
    {data:{reason:'verified_copy_branch',previousThreadId:input.sourceThreadId,threadId:input.targetThreadId}});
  return proof.member_ids.length;
}

/** Caller holds the mailbox row lock. Establish evidence before duplicate-key handling; receipt never implies acceptance. */
export async function establishVerifiedCopies(client: PoolClient, input: { mailboxId: string; messageId: string }): Promise<{ linked: number; moved: number; conflicts: number }> {
  const incoming = await client.query<{ id: string }>(`SELECT d.id FROM deliveries d JOIN mail_thread_headers h ON h.message_id=d.id AND h.mailbox_id=d.mailbox_id
    WHERE d.mailbox_id=$1 AND d.direction='inbound' AND d.deleted_at IS NULL AND (d.id=$2 OR EXISTS(
      SELECT 1 FROM outbound_submissions s JOIN deliveries sd ON sd.id=s.id AND sd.mailbox_id=s.mailbox_id
      JOIN mail_content_fingerprints fs ON fs.delivery_id=sd.id AND fs.mailbox_id=sd.mailbox_id
        AND fs.raw_sha256=sd.sha256 AND fs.raw_size=sd.raw_size AND fs.version=1 AND fs.sha256 IS NOT NULL
      JOIN mail_content_fingerprints fi ON fi.delivery_id=d.id AND fi.mailbox_id=d.mailbox_id
        AND fi.raw_sha256=d.sha256 AND fi.raw_size=d.raw_size AND fi.version=fs.version AND fi.sha256=fs.sha256
      WHERE s.id=$2 AND s.mailbox_id=$1 AND s.state IN ('accepted','partial')
        AND s.rfc_message_id='<'||h.message_id_header||'>' AND sd.sha256=s.raw_sha256 AND sd.raw_size=s.raw_size))
    ORDER BY d.id LIMIT $3`, [input.mailboxId,input.messageId,MAX_CANDIDATES]);
  let linked = 0, moved = 0, conflicts = 0;
  for (const { id } of incoming.rows) {
    const candidates = (await client.query<CopyCandidate>(`
      SELECT DISTINCT ON (s.id) d.id AS inbound_id,s.id AS sent_id,fi.version,fi.sha256 AS fingerprint,h.message_id_header AS token,
        p.address AS recipient,p.allocation_id,p.revision,p.sha256 AS policy_digest,
        d.sha256 AS inbound_sha,d.raw_size AS inbound_size,sd.sha256 AS sent_sha,sd.raw_size AS sent_size,
        si.thread_id AS inbound_thread_id,ss.thread_id AS sent_thread_id
      FROM deliveries d JOIN mail_thread_headers h ON h.message_id=d.id AND h.mailbox_id=d.mailbox_id
      JOIN mail_message_state si ON si.message_id=d.id AND si.mailbox_id=d.mailbox_id
      JOIN mail_content_fingerprints fi ON fi.delivery_id=d.id AND fi.mailbox_id=d.mailbox_id
        AND fi.raw_sha256=d.sha256 AND fi.raw_size=d.raw_size AND fi.version=1 AND fi.sha256 IS NOT NULL
      JOIN address_policy_history p ON p.mailbox_id=d.mailbox_id AND p.address=lower(d.metadata->>'envelopeTo')
        AND p.allocation_id::text=d.metadata->>'allocationId' AND p.revision::text=d.metadata->>'routeRevision'
        AND p.sha256=d.metadata->>'policyDigest' AND p.receive_enabled
      JOIN outbound_submissions s ON s.mailbox_id=d.mailbox_id AND s.state IN ('accepted','partial')
        AND s.rfc_message_id='<' || h.message_id_header || '>'
      JOIN deliveries sd ON sd.id=s.id AND sd.mailbox_id=s.mailbox_id AND sd.direction='outbound' AND sd.deleted_at IS NULL
        AND sd.sha256=s.raw_sha256 AND sd.raw_size=s.raw_size AND (s.sent_message_id IS NULL OR s.sent_message_id=sd.id)
        AND sd.metadata->>'kind'='outbound' AND sd.metadata->>'submissionId'=sd.id::text
      JOIN mail_message_state ss ON ss.message_id=sd.id AND ss.mailbox_id=sd.mailbox_id AND ss.thread_id IS NOT NULL
      JOIN mail_content_fingerprints fs ON fs.delivery_id=sd.id AND fs.mailbox_id=sd.mailbox_id
        AND fs.raw_sha256=sd.sha256 AND fs.raw_size=sd.raw_size AND fs.version=fi.version AND fs.sha256=fi.sha256
      JOIN outbound_recipients r ON r.submission_id=s.id AND lower(r.address)=p.address AND r.status='accepted'
        AND s.snapshot->'envelopeRecipients' @> jsonb_build_array(r.address)
      WHERE d.id=$1 AND d.mailbox_id=$2 AND d.direction='inbound' AND d.deleted_at IS NULL
        AND d.metadata->>'version'='2' AND d.metadata->>'mailboxId'=d.mailbox_id::text
      ORDER BY s.id LIMIT 2`, [id,input.mailboxId])).rows;
    if (candidates.length !== 1) { if (candidates.length > 1) conflicts++; continue; }
    const c = candidates[0]!;
    if (normalizeMessageId(await getOutboundRfcMessageId(client,{mailboxId:input.mailboxId,messageId:c.sent_id})) !== c.token) continue;
    const previous = (await client.query<{ sent_message_id: string }>('SELECT sent_message_id FROM mail_verified_copies WHERE inbound_message_id=$1', [id])).rows[0];
    if (previous) { if (previous.sent_message_id !== c.sent_id) conflicts++; continue; }
    // One logical card remains within the existing 100-message mutation limit.
    // Tombstoning a member does not create room to silently grow its evidence set.
    const count=(await client.query<{n:string}>('SELECT count(*) AS n FROM mail_verified_copies WHERE mailbox_id=$1 AND sent_message_id=$2',[input.mailboxId,c.sent_id])).rows[0]!;
    if(Number(count.n)>=99){conflicts++;continue;}
    // Group evidence and membership commit together; a relation never spans threads.
    const branchMoved=await moveVerifiedCopyBranch(client,{mailboxId:input.mailboxId,sentId:c.sent_id,inboundId:id,
      token:c.token,sourceThreadId:c.inbound_thread_id,targetThreadId:c.sent_thread_id});
    moved+=branchMoved;
    if(!branchMoved&&c.inbound_thread_id!==c.sent_thread_id){
      await client.query('UPDATE mail_message_state SET thread_id=$3,updated_at=now() WHERE mailbox_id=$1 AND message_id=$2',
        [input.mailboxId,id,c.sent_thread_id]);
      await appendChange(client,input.mailboxId,id,'message.threaded',{data:{reason:'verified_copy',threadId:c.sent_thread_id}});moved++;
    }
    await client.query(`INSERT INTO mail_verified_copies(inbound_message_id,mailbox_id,sent_message_id,fingerprint_version,fingerprint_sha256,
      wire_message_id,envelope_recipient,allocation_id,route_revision,policy_digest,inbound_raw_sha256,inbound_raw_size,sent_raw_sha256,sent_raw_size)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id,input.mailboxId,c.sent_id,c.version,c.fingerprint,c.token,c.recipient,c.allocation_id,c.revision,c.policy_digest,c.inbound_sha,c.inbound_size,c.sent_sha,c.sent_size]);
    await appendChange(client,input.mailboxId,id,'message.copy_verified',{data:{sentMessageId:c.sent_id}});
    linked++;
  }
  return { linked, moved, conflicts };
}
export interface VerifiedCopyResult { linked: number; moved: number; conflicts: number }
/** Caller owns the transaction. Move proved copies and closed related branches, never unrelated thread members. */
export async function reconcileVerifiedCopies(client: PoolClient, input: { mailboxId: string; messageId: string }): Promise<VerifiedCopyResult> {
  if (!UUID.test(input.mailboxId) || !UUID.test(input.messageId)) throw new Error('invalid_thread_identity');
  await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE', [input.mailboxId]);
  const evidence = await establishVerifiedCopies(client,input);
  const canonical = (await client.query<{ sent_message_id: string }>(`SELECT DISTINCT sent_message_id FROM mail_verified_copies
    WHERE mailbox_id=$1 AND (inbound_message_id=$2 OR sent_message_id=$2)`, [input.mailboxId,input.messageId])).rows;
  let moved = evidence.moved;
  for (const { sent_message_id: sentId } of canonical) {
    const wire = await getOutboundRfcMessageId(client,{mailboxId:input.mailboxId,messageId:sentId});
    const token = normalizeMessageId(wire); if (!token) continue;
    const target = (await client.query<{ thread_id: string }>(`SELECT thread_id FROM mail_message_state
      WHERE mailbox_id=$1 AND message_id=$2 AND thread_id IS NOT NULL`, [input.mailboxId,sentId])).rows[0];
    if (!target) continue;
    await recordThreadIdentityClaim(client,input.mailboxId,token,sentId);
    const copies = (await client.query<{ inbound_message_id: string }>(`SELECT c.inbound_message_id FROM mail_verified_copies c
      JOIN mail_message_state ms ON ms.mailbox_id=c.mailbox_id AND ms.message_id=c.inbound_message_id
      WHERE c.mailbox_id=$1 AND c.sent_message_id=$2 AND ms.thread_id IS DISTINCT FROM $3::uuid
      ORDER BY c.inbound_message_id LIMIT $4`, [input.mailboxId,sentId,target.thread_id,MAX_CANDIDATES])).rows;
    for (const copy of copies) {
      await client.query('UPDATE mail_message_state SET thread_id=$3,updated_at=now() WHERE mailbox_id=$1 AND message_id=$2',
        [input.mailboxId,copy.inbound_message_id,target.thread_id]);
      await appendChange(client,input.mailboxId,copy.inbound_message_id,'message.threaded',{data:{reason:'verified_copy',threadId:target.thread_id}}); moved++;
    }
    // Every known historical own-ID claim, including deleted messages, must belong
    // to this exact equivalence class. An unrelated third claim keeps it ambiguous.
    const proof = (await client.query<{ compatible: boolean }>(`SELECT
      NOT EXISTS(SELECT 1 FROM mail_thread_keys WHERE mailbox_id=$1 AND token=$2 AND ambiguity_unproven)
      AND NOT EXISTS(SELECT 1 FROM mail_thread_identity_claims c WHERE c.mailbox_id=$1 AND c.token=$2 AND c.message_id<>$3
        AND NOT EXISTS(SELECT 1 FROM mail_verified_copies v WHERE v.mailbox_id=c.mailbox_id AND v.inbound_message_id=c.message_id AND v.sent_message_id=$3))
      AND NOT EXISTS(SELECT 1 FROM mail_thread_keys k WHERE k.mailbox_id=$1 AND k.token=$2 AND k.claim_message_id IS NOT NULL AND k.claim_message_id<>$3
        AND NOT EXISTS(SELECT 1 FROM mail_verified_copies v WHERE v.mailbox_id=k.mailbox_id AND v.inbound_message_id=k.claim_message_id AND v.sent_message_id=$3))
      AND NOT EXISTS(SELECT 1 FROM outbound_submissions s WHERE s.mailbox_id=$1 AND s.rfc_message_id=$4
        AND s.state IN ('accepted','partial') AND s.id<>$3) AS compatible`, [input.mailboxId,token,sentId,wire])).rows[0];
    if (proof?.compatible) {
      const previousKey=(await client.query<{ambiguous:boolean}>('SELECT ambiguous FROM mail_thread_keys WHERE mailbox_id=$1 AND token=$2',[input.mailboxId,token])).rows[0];
      await client.query(`INSERT INTO mail_thread_keys(mailbox_id,token,thread_id,claim_message_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(mailbox_id,token) DO UPDATE SET thread_id=EXCLUDED.thread_id,claim_message_id=EXCLUDED.claim_message_id,ambiguous=false
        WHERE NOT mail_thread_keys.ambiguity_unproven`, [input.mailboxId,token,target.thread_id,sentId]);
      // Only warnings invalidated by this exact canonical proof may be removed.
      // A duplicate local Sent ID, unrelated references and all other warnings survive.
      await client.query(`UPDATE mail_thread_headers h SET warnings=COALESCE((
        SELECT jsonb_agg(w.value) FROM jsonb_array_elements(h.warnings) w(value)
        WHERE NOT ((w.value='"duplicate_message_id"'::jsonb AND h.message_id_header=$2)
          OR (w.value='"provider_message_id_conflict"'::jsonb AND h.message_id=$3))), '[]'::jsonb)
        WHERE h.mailbox_id=$1 AND (h.message_id=$3 OR EXISTS(SELECT 1 FROM mail_verified_copies c
          WHERE c.mailbox_id=h.mailbox_id AND c.inbound_message_id=h.message_id AND c.sent_message_id=$3))
          AND jsonb_typeof(h.warnings)='array'
          AND h.warnings ?| ARRAY['duplicate_message_id','provider_message_id_conflict']`, [input.mailboxId,token,sentId]);
      if(previousKey?.ambiguous){
        // A reply received between two copies and Sent persistence could have
        // created a separate thread while the wire key was ambiguous. Revisit
        // only closed branches; unlike a proved-copy root, the selected reply
        // must itself pass every ancestry/header/claim check in that proof.
        const detached=(await client.query<{message_id:string;thread_id:string}>(`SELECT DISTINCT ON (ms.thread_id) h.message_id,ms.thread_id
          FROM mail_thread_headers h JOIN mail_message_state ms ON ms.mailbox_id=h.mailbox_id AND ms.message_id=h.message_id
          WHERE h.mailbox_id=$1 AND ms.thread_id IS NOT NULL AND ms.thread_id<>$2 AND h.parser_version>=2
            AND h.message_id_header IS DISTINCT FROM $3
            AND CASE WHEN jsonb_typeof(h.reference_ids)='array' AND jsonb_typeof(h.in_reply_to)='array'
              THEN CASE WHEN jsonb_array_length(h.reference_ids)>0 THEN h.reference_ids @> jsonb_build_array($3::text)
                ELSE h.in_reply_to->>0=$3 END ELSE false END
          ORDER BY ms.thread_id,h.message_id LIMIT $4`,[input.mailboxId,target.thread_id,token,MAX_CANDIDATES])).rows;
        for(const branch of detached)moved+=await moveVerifiedCopyBranch(client,{mailboxId:input.mailboxId,sentId,
          inboundId:branch.message_id,token,sourceThreadId:branch.thread_id,targetThreadId:target.thread_id,replyRoot:true});
      }
    } else {
      await client.query('UPDATE mail_thread_keys SET ambiguous=true WHERE mailbox_id=$1 AND token=$2', [input.mailboxId,token]);
      evidence.conflicts++;
    }
  }
  return { ...evidence, moved };
}
/** Metadata-only bounded reconciliation of existing fingerprints; no raw reads or deletion. */
export async function backfillVerifiedCopies(pool: Pool, options: { limit?: number; afterDeliveryId?: string } = {}): Promise<{ processed: number; nextCursor: string | null }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (options.afterDeliveryId !== undefined && !UUID.test(options.afterDeliveryId))) throw new Error('invalid_copy_backfill');
  const rows = (await pool.query<{ delivery_id: string; mailbox_id: string }>(`SELECT delivery_id,mailbox_id FROM mail_content_fingerprints
    WHERE ($1::uuid IS NULL OR delivery_id>$1) ORDER BY delivery_id LIMIT $2`, [options.afterDeliveryId ?? null,limit+1])).rows;
  for (const row of rows.slice(0,limit)) {
    const client=await pool.connect(); try { await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5000ms'");
      await reconcileVerifiedCopies(client,{mailboxId:row.mailbox_id,messageId:row.delivery_id}); await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return { processed:Math.min(rows.length,limit),nextCursor:rows.length>limit?rows[limit-1]!.delivery_id:null };
}
