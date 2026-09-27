import type { Pool, PoolClient } from 'pg';
import type { OutboundService } from './service.js';
import type { SendSnapshot } from './types.js';
import { extractAttachmentsIsolated } from '../attachments/extractor.js';
import { ApiError } from '../errors.js';
import { digest } from './validation.js';
export interface OwnedDraftPart {
  id:string;filename:string;mime_type:string;sha256:string;size_bytes:number;bytes:Buffer|null;
  source_message_id:string|null;source_attachment_id:string|null;source_content_version:string|null;source_sha256:string|null;
}
/** Rebuild only exact owned parts from the already frozen MIME; this never consults a browser URL or sends mail. */
export async function restoreDraftParts(service:OutboundService,client:Pool|PoolClient,draftId:string,parts:OwnedDraftPart[]):Promise<Array<OwnedDraftPart&{bytes:Buffer}>>{
  if(parts.every(part=>part.bytes!==null))return parts as Array<OwnedDraftPart&{bytes:Buffer}>;
  const frozen=(await client.query<{snapshot:SendSnapshot;raw_sha256:string|null;raw_size:number|null}>('SELECT snapshot,raw_sha256,raw_size FROM outbound_submissions WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 1',[draftId])).rows[0];
  if(!frozen?.raw_sha256||frozen.raw_size===null)throw new ApiError(409,'draft_attachment_recovery_unavailable');
  const raw=await service.deps.blobs.get(frozen.raw_sha256);
  if(raw.length!==frozen.raw_size||digest(raw)!==frozen.raw_sha256)throw new ApiError(409,'draft_attachment_recovery_unavailable');
  const extracted=await extractAttachmentsIsolated(raw);
  if(extracted.parts.length!==frozen.snapshot.attachments.length||parts.length!==frozen.snapshot.attachments.length)throw new ApiError(409,'draft_attachment_correspondence_changed');
  const recovered=new Map<string,Buffer>();
  for(const [index,expected]of frozen.snapshot.attachments.entries()){
    const actual=extracted.parts[index];
    if(!actual||actual.sha256!==expected.sha256||actual.sizeBytes!==expected.sizeBytes||actual.filename!==expected.filename||actual.mimeType!==expected.mimeType)throw new ApiError(409,'draft_attachment_correspondence_changed');
    recovered.set(expected.id,Buffer.from(actual.bytes));
  }
  return parts.map(part=>{const bytes=part.bytes??recovered.get(part.id);if(!bytes||bytes.length!==part.size_bytes||digest(bytes)!==part.sha256)throw new ApiError(409,'draft_attachment_correspondence_changed');return {...part,bytes};});
}
/** Separate maintenance from outcome persistence: cleanup failure cannot roll back an accepted provider receipt. */
export async function releaseTerminalDraftStaging(service:OutboundService):Promise<boolean>{
  const candidate=(await service.pool.query<{id:string;draft_id:string;mailbox_id:string;raw_sha256:string;raw_size:number}>(`SELECT s.id,s.draft_id,s.mailbox_id,s.raw_sha256,s.raw_size FROM outbound_submissions s
    WHERE s.raw_sha256 IS NOT NULL AND s.stage_released_at IS NULL AND s.stage_release_after<=now()
      AND (s.state IN ('failed','blocked','cancelled') OR (s.state IN ('accepted','partial') AND s.sent_copy_state='done'))
      AND NOT EXISTS(SELECT 1 FROM outbound_recipients r WHERE r.submission_id=s.id AND r.status='unknown')
      AND EXISTS(SELECT 1 FROM outbound_draft_attachments a WHERE a.draft_id=s.draft_id AND a.bytes IS NOT NULL)
    ORDER BY s.created_at,s.id LIMIT 1`)).rows[0];
  if(!candidate)return false;
  try{
    const raw=await service.deps.blobs.get(candidate.raw_sha256);
    if(raw.length!==candidate.raw_size||digest(raw)!==candidate.raw_sha256)throw new Error('frozen_mime_unavailable');
    const client=await service.pool.connect();
    try{await client.query('BEGIN');await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE',[candidate.mailbox_id]);
      const valid=await client.query(`SELECT 1 FROM outbound_submissions s WHERE s.id=$1 AND s.raw_sha256=$2 AND s.stage_released_at IS NULL
        AND (s.state IN ('failed','blocked','cancelled') OR (s.state IN ('accepted','partial') AND s.sent_copy_state='done'))
        AND NOT EXISTS(SELECT 1 FROM outbound_recipients r WHERE r.submission_id=s.id AND r.status='unknown') FOR UPDATE`,[candidate.id,candidate.raw_sha256]);
      if(valid.rowCount){await client.query('UPDATE outbound_draft_attachments SET bytes=NULL,released_at=now() WHERE draft_id=$1 AND bytes IS NOT NULL',[candidate.draft_id]);
        await client.query('UPDATE outbound_submissions SET stage_released_at=now(),stage_release_error=NULL WHERE id=$1',[candidate.id]);}
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch{await service.pool.query("UPDATE outbound_submissions SET stage_release_after=now()+interval '5 minutes',stage_release_error='frozen_mime_unavailable' WHERE id=$1 AND stage_released_at IS NULL",[candidate.id]);}
  return true;
}
