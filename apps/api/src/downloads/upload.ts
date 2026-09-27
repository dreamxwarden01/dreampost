import { createAttachmentUploadHeaders, verifyAttachmentUploadResponse, MAX_DOWNLOAD_CONTROL_BYTES } from '@dreampost/protocol';
import type { Pool } from 'pg';
import type { DownloadConfig } from './config.js';
import type { AttachmentStagingStore } from '../attachments/types.js';
import { claimAttachmentUpload, completeAttachmentUpload, retryAttachmentUpload, repairMissingAttachmentStaging } from '../attachments/service.js';

async function bounded(response:Response):Promise<Uint8Array> {
  const size=response.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size)>MAX_DOWNLOAD_CONTROL_BYTES)) throw new Error('invalid_upload_reply');
  if (!response.body) throw new Error('invalid_upload_reply');
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[]; let length=0;
  try {
    for (;;) {
      const part=await reader.read(); if(part.done)break;
      length+=part.value.length;
      if(length>MAX_DOWNLOAD_CONTROL_BYTES) { await reader.cancel(); throw new Error('invalid_upload_reply'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const raw=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  return raw;
}

/** One durable lease, one bounded upload; retries reuse the immutable object key. */
export async function runOneAttachmentUpload(pool:Pool,staging:AttachmentStagingStore,config:DownloadConfig,fetcher:typeof fetch=fetch):Promise<boolean> {
  const task=await claimAttachmentUpload(pool);
  if(!task)return false;
  try {
    const raw=await staging.get(task.attachmentId,task.sha256);
    if(raw.length!==task.sizeBytes)throw new Error('invalid_staging_size');
    const expected={attachmentId:task.attachmentId,sha256:task.sha256,sizeBytes:task.sizeBytes};
    const headers=await createAttachmentUploadHeaders(expected,config.key);
    const response=await fetcher(`${config.origin}/internal/v1/objects/${task.attachmentId}`,{
      method:'PUT',headers,body:new Uint8Array(raw),redirect:'error',signal:AbortSignal.timeout(120_000),
    });
    if(response.status!==200){
      await response.body?.cancel();
      // Failure bodies are not signed upload receipts. A proxy or transient R2 error must never permanently strand a file.
      await retryAttachmentUpload(pool,task,`upload_http_${response.status}`);
      return true;
    }
    const ack=await verifyAttachmentUploadResponse(response.headers,await bounded(response),{[config.key.id]:config.key.secret},expected,
      {requestNonce:headers['x-dreampost-download-nonce']});
    await completeAttachmentUpload(pool,task,ack);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await repairMissingAttachmentStaging(pool,task);
    }
    // Never persist upstream bodies, local paths or a credential-bearing exception.
    const corrupt = !!error && typeof error === 'object' && 'code' in error && error.code === 'attachment_digest_mismatch';
    await retryAttachmentUpload(pool,task,corrupt?'attachment_staging_corrupt':'attachment_upload_failed',{blocked:corrupt});
  }
  return true;
}
