import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { DOWNLOAD_CONTROL_PATH, MAX_DOWNLOAD_CONTROL_BYTES, createDownloadControlResponseHeaders,
  verifyDownloadControlRequest, type DownloadControlReply } from '@dreampost/protocol';
import type { ApiConfig } from '../config.js';
import type { AuthService } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { listAttachments } from '../attachments/service.js';
import { DownloadService } from './service.js';

export function registerDownloadControl(app: FastifyInstance, config: ApiConfig, pool: Pool, auth?: AuthService): DownloadService | undefined {
  if (!config.downloads) return undefined;
  const service = new DownloadService(pool,config,auth);
  void app.register(async control => {
    control.removeContentTypeParser('application/json');
    control.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:MAX_DOWNLOAD_CONTROL_BYTES},(_request,body,done)=>done(null,body));
    control.post(DOWNLOAD_CONTROL_PATH,{bodyLimit:MAX_DOWNLOAD_CONTROL_BYTES},async(request,reply)=>{
      reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
      if (request.url !== DOWNLOAD_CONTROL_PATH || !Buffer.isBuffer(request.body)) throw new ApiError(400,'invalid_control_request');
      let verified;
      try { verified=await verifyDownloadControlRequest(request.headers,request.body,{[service.config.key.id]:service.config.key.secret}); }
      catch { throw new ApiError(401,'invalid_control_authorization'); }
      let body:DownloadControlReply;
      let status=200;
      try {
        await service.consumeNonce(verified.keyId,verified.nonce);
        body=verified.request.op==='redeem' ? await service.redeem(verified.request)
          : verified.request.op==='prune' ? await service.prune(verified.request) : await service.authorize(verified.request);
      } catch(error) {
        status=error instanceof ApiError ? error.statusCode : 503;
        body={version:1,op:'error',error:error instanceof ApiError ? error.code : 'temporarily_unavailable'};
      }
      reply.headers(await createDownloadControlResponseHeaders(body,service.config.key,{requestNonce:verified.nonce,status}));
      return reply.code(status).send(JSON.stringify(body));
    });
  });
  return service;
}

type Params={id:string;messageId:string;attachmentId:string};
export function registerAttachmentRoutes(api:FastifyInstance,pool:Pool,service:DownloadService,
  authorizeMessage:(request:FastifyRequest,mailboxId:string,messageId:string)=>Promise<unknown>):void {
  api.get<{Params:Omit<Params,'attachmentId'>}>('/mailboxes/:id/messages/:messageId/attachments',async request=>{
    await authorizeMessage(request,request.params.id,request.params.messageId);
    const inventory=await listAttachments(pool,request.params.messageId);
    const state=inventory.status==='complete'?'ready':inventory.status==='unavailable'
      ? /limit/.test(inventory.errorCode??'')?'over_limit':'failed':inventory.status;
    return {state,items:inventory.items.map(item=>({id:item.id,filename:item.filename,mimeType:item.mimeType,
      sizeBytes:item.sizeBytes,sha256:item.sha256,deliveryKind:item.deliveryKind,state:item.state==='ready'?'ready':item.state==='failed'?'failed':'queued',
      previewKind:item.previewKind==='none'||item.sizeBytes>service.config.maxPreviewBytes||item.sizeBytes===0?null:item.previewKind==='raster'?'image':'pdf'}))};
  });
  api.post<{Params:Params}>('/mailboxes/:id/messages/:messageId/attachments/:attachmentId/transfers',{bodyLimit:4096},async request=>{
    await authorizeMessage(request,request.params.id,request.params.messageId);
    return service.addTransfer(request,request.params.messageId,request.params.attachmentId,request.body);
  });
  api.post<{Params:Params}>('/mailboxes/:id/messages/:messageId/attachments/:attachmentId/sessions',{bodyLimit:4096},async request=>{
    await authorizeMessage(request,request.params.id,request.params.messageId);
    return service.create(request,request.params.messageId,request.params.attachmentId,request.body);
  });
}
