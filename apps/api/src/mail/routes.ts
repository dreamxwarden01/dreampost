import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { MailViewFolder } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
import type { MailService } from './service.js';
import type { MailListOptions, MailStreamReference, MailViewer } from './types.js';
export interface MailRouteOptions {
  authenticate:(request:FastifyRequest,options:{mutating:boolean;client?:PoolClient})=>Promise<MailViewer>;
  captureStream?:(request:FastifyRequest)=>Promise<MailStreamReference>;
  recheckStream?:(reference:MailStreamReference)=>Promise<{viewer:MailViewer;expiresAt:number}>;
  streamPollMs?:number; streamLifetimeMs?:number;
}
const activeStreams=new Map<string,number>();let totalStreams=0;
function query(request:FastifyRequest,allowed:string[]):Record<string,string>{
  const value=request.query as Record<string,unknown>;const out:Record<string,string>={};
  for(const[key,item]of Object.entries(value)){if(!allowed.includes(key)||typeof item!=='string')throw new ApiError(400,'invalid_mail_query');out[key]=item;}return out;
}
function positive(value:string|undefined,defaultValue:number,max:number):number{if(value===undefined)return defaultValue;if(!/^[1-9]\d{0,3}$/.test(value)||Number(value)>max)throw new ApiError(400,'invalid_mail_query');return Number(value);}
function boolean(value:string|undefined):boolean|undefined{if(value===undefined)return undefined;if(value!=='true'&&value!=='false')throw new ApiError(400,'invalid_mail_query');return value==='true';}
function listOptions(request:FastifyRequest,thread=false):MailListOptions{
  const q=query(request,thread?['limit','cursor','folder','groupCopies']:['view','limit','cursor','folder','unread','starred','labelId','q','groupCopies']);
  if(q.view!==undefined&&!['messages','threads'].includes(q.view))throw new ApiError(400,'invalid_mail_query');
  if(q.folder!==undefined&&!['inbox','archive','trash','spam','sent','all'].includes(q.folder))throw new ApiError(400,'invalid_mail_query');
  return{groupCopies:boolean(q.groupCopies)??false,view:q.view as MailListOptions['view'],limit:positive(q.limit,50,100),cursor:q.cursor,folder:q.folder as MailViewFolder|undefined,unread:boolean(q.unread),starred:boolean(q.starred),labelId:q.labelId,q:q.q};
}
/** Register inside /api. The source session is rechecked with the same business client on writes. */
export function registerMailRoutes(api:FastifyInstance,service:MailService,options:MailRouteOptions):void{
  type Mailbox={id:string};
  const viewer=(request:FastifyRequest)=>options.authenticate(request,{mutating:false});
  const authorization=(request:FastifyRequest)=>(client:PoolClient)=>options.authenticate(request,{mutating:true,client});
  api.get<{Params:Mailbox}>('/mailboxes/:id/messages',async request=>service.list(await viewer(request),request.params.id,listOptions(request)));
  api.get<{Params:Mailbox&{threadId:string}}>('/mailboxes/:id/threads/:threadId',async request=>service.thread(await viewer(request),request.params.id,request.params.threadId,listOptions(request,true)));
  api.post<{Params:Mailbox}>('/mailboxes/:id/messages/mutate',{bodyLimit:32768},async request=>service.mutate(request.params.id,request.body,authorization(request)));
  api.post<{Params:Mailbox&{operationId:string}}>('/mailboxes/:id/operations/:operationId/undo',{bodyLimit:1024},async request=>{
    if(request.body!==undefined&&request.body!==null&&(typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body).length))throw new ApiError(400,'invalid_mail_request');
    return service.undo(request.params.id,request.params.operationId,authorization(request));
  });
  api.get<{Params:Mailbox}>('/mailboxes/:id/labels',async request=>{query(request,[]);return service.labels(await viewer(request),request.params.id);});
  api.post<{Params:Mailbox}>('/mailboxes/:id/labels',{bodyLimit:4096},async request=>service.mutateLabel(request.params.id,'create',undefined,request.body,authorization(request)));
  api.patch<{Params:Mailbox&{labelId:string}}>('/mailboxes/:id/labels/:labelId',{bodyLimit:4096},async request=>service.mutateLabel(request.params.id,'update',request.params.labelId,request.body,authorization(request)));
  api.delete<{Params:Mailbox&{labelId:string}}>('/mailboxes/:id/labels/:labelId',{bodyLimit:4096},async request=>service.mutateLabel(request.params.id,'delete',request.params.labelId,request.body,authorization(request)));
  api.get<{Params:Mailbox}>('/mailboxes/:id/changes',async request=>{const q=query(request,['after','limit']);return service.changes(await viewer(request),request.params.id,q.after??'0',positive(q.limit,500,500));});
  api.get<{Params:Mailbox}>('/mailboxes/:id/events',async(request,reply)=>{
    if(!options.captureStream||!options.recheckStream)throw new ApiError(403,'event_stream_unavailable');
    const q=query(request,['after']);const last=request.headers['last-event-id'];if(last!==undefined&&typeof last!=='string')throw new ApiError(400,'invalid_mail_query');
    let cursor=typeof last==='string'?last:q.after??'0';
    const reference=await options.captureStream(request);const initial=await options.recheckStream(reference);
    if(initial.viewer.principalId!==reference.principalId||initial.expiresAt<=Date.now())throw new ApiError(401,'authentication_required');
    let pending=await service.changes(initial.viewer,request.params.id,cursor,500);
    if(reply.raw.destroyed||reply.raw.writableEnded)return reply;
    const actorKey=reference.principalId;
    if(totalStreams>=100||(activeStreams.get(actorKey)??0)>=4)throw new ApiError(429,'event_stream_limit');
    totalStreams++;activeStreams.set(actorKey,(activeStreams.get(actorKey)??0)+1);
    const stopped=new AbortController(),close=()=>stopped.abort();reply.raw.once('close',close);
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    const started=Date.now(),lifetime=Math.min(options.streamLifetimeMs??300_000,300_000),poll=Math.max(25,options.streamPollMs??1000);
    let heartbeat=0;
    try{
      while(!stopped.signal.aborted&&!reply.raw.destroyed&&Date.now()-started<lifetime){
        if(pending.changes.length||pending.resetRequired){
          const kind=pending.resetRequired?'reset':'invalidate';
          if(!reply.raw.write(`id: ${pending.nextSequence}\nevent: ${kind}\ndata: ${JSON.stringify({sequence:pending.nextSequence})}\n\n`))break;
        }
        cursor=pending.nextSequence;if(pending.resetRequired)break;
        if(Date.now()-heartbeat>=15000){if(!reply.raw.write(': heartbeat\n\n'))break;heartbeat=Date.now();}
        if(!pending.hasMore)await sleep(poll,undefined,{signal:stopped.signal});
        if(stopped.signal.aborted)break;
        const current=await options.recheckStream(reference);
        if(current.viewer.principalId!==reference.principalId||current.expiresAt<=Date.now())break;
        pending=await service.changes(current.viewer,request.params.id,cursor,500);
      }
    }catch{/* A revoked/expired session or disconnected client closes the stream without sending content. */}
    finally{reply.raw.removeListener('close',close);if(!reply.raw.writableEnded)reply.raw.end();totalStreams--;const remaining=(activeStreams.get(actorKey)??1)-1;if(remaining)activeStreams.set(actorKey,remaining);else activeStreams.delete(actorKey);}
  });
}
