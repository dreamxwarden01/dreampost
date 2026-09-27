import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { OutboundDependencies } from './types.js';
import type { Actor } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { OutboundService } from './service.js';
export type OutboundAuthenticate=(request:FastifyRequest,options:{mutating:boolean;client?:PoolClient;readOnly?:boolean})=>Promise<Actor>;
const activeMutations=new Map<string,number>();let totalMutations=0;
export function getOutboundMutationActivity(){return {active:totalMutations};}
type Params={id:string;draftId:string;attachmentId:string;submissionId:string};
function body(request:FastifyRequest):Record<string,unknown>{if(!request.body||typeof request.body!=='object'||Array.isArray(request.body)||Buffer.isBuffer(request.body))throw new ApiError(400,'invalid_body');return request.body as Record<string,unknown>;}
export function registerOutboundRoutes(app:FastifyInstance,baseService:OutboundService,authenticate:OutboundAuthenticate):void{
  void app.register(async routes=>{
    const actors=new WeakMap<FastifyRequest,Actor>(),services=new WeakMap<FastifyRequest,OutboundService>();
    const budgets=new WeakMap<FastifyRequest,{processing:boolean;requested:boolean;release:()=>void}>();
    const release=(request:FastifyRequest)=>{const budget=budgets.get(request);if(!budget)return;budget.requested=true;if(!budget.processing)budget.release();};
    routes.addHook('onResponse',async request=>release(request));
    routes.addHook('onError',async request=>release(request));
    routes.addHook('onRoute',options=>{
      const handler=options.handler;
      options.handler=async function(request,reply){
        const budget=budgets.get(request);if(budget)budget.processing=true;
        try{return await handler.call(this,request,reply);}finally{if(budget){budget.processing=false;if(budget.requested)budget.release();}}
      };
    });
    routes.addHook('onRequest',async(request,reply)=>{
      reply.header('Cache-Control','no-store');const mutating=!['GET','HEAD'].includes(request.method);
      const initial=await authenticate(request,{mutating,readOnly:!mutating});actors.set(request,initial);
      if(mutating){
        if(!initial.permissions.has('mailbox.use')||!initial.permissions.has('mail.send'))throw new ApiError(403,'permission_denied');
        const count=activeMutations.get(initial.principalId)??0;
        if(count>=2||totalMutations>=8){reply.header('Retry-After','1');throw new ApiError(429,'outbound_busy');}
        activeMutations.set(initial.principalId,count+1);totalMutations++;
        let released=false;
        const requestRelease=()=>release(request);
        const budget={processing:false,requested:false,release:()=>{
          if(released)return;released=true;totalMutations--;const left=(activeMutations.get(initial.principalId)??1)-1;
          if(left)activeMutations.set(initial.principalId,left);else activeMutations.delete(initial.principalId);
          request.raw.removeListener('aborted',requestRelease);reply.raw.removeListener('close',requestRelease);budgets.delete(request);
        }};
        budgets.set(request,budget);request.raw.once('aborted',requestRelease);reply.raw.once('close',requestRelease);
      }
      const current=async(principalId:string,client:PoolClient,options?:{readOnly?:boolean})=>{
        const actor=await authenticate(request,{mutating,client,readOnly:options?.readOnly??!mutating});
        if(actor.principalId!==initial.principalId||actor.principalId!==principalId)throw new ApiError(401,'authentication_required');return actor;
      };
      const deps:OutboundDependencies={...baseService.deps,resolvePrincipal:current,
        withSenderAdmission:(input,work)=>baseService.deps.withSenderAdmission(input,async(client,sender)=>{await current(input.principalId,client);return work(client,sender);})};
      services.set(request,new OutboundService(baseService.pool,baseService.config,deps));
    });
    const service=(request:FastifyRequest)=>services.get(request)!;
    routes.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:baseService.config.maxAttachmentBytes},(_request,value,done)=>done(null,value));
    const actor=(request:FastifyRequest)=>{const value=actors.get(request);if(!value)throw new ApiError(401,'authentication_required');return value.principalId;};
    routes.post<{Params:Params}>('/api/mailboxes/:id/drafts',{bodyLimit:16384},async request=>({draft:await service(request).createDraft(actor(request),request.params.id,body(request))}));
    routes.get<{Params:Params}>('/api/mailboxes/:id/drafts',async request=>({drafts:await service(request).listDrafts(actor(request),request.params.id)}));
    routes.get<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId',async request=>({draft:await service(request).getDraft(actor(request),request.params.id,request.params.draftId)}));
    routes.patch<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId',{bodyLimit:baseService.config.maxBodyBytes+800*1024},async request=>({draft:await service(request).patchDraft(actor(request),request.params.id,request.params.draftId,body(request))}));
    routes.post<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId/duplicate',{bodyLimit:4096},async request=>({draft:await service(request).duplicateDraft(actor(request),request.params.id,request.params.draftId,body(request))}));
    routes.post<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId/discard',{bodyLimit:4096},async request=>service(request).discardDraft(actor(request),request.params.id,request.params.draftId,body(request)));
    routes.post<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId/attachments',{bodyLimit:baseService.config.maxAttachmentBytes},async request=>{
      if(!Buffer.isBuffer(request.body))throw new ApiError(415,'binary_attachment_required');
      const version=Number(request.headers['x-draft-version']),key=request.headers['x-mutation-key'],name=request.headers['x-attachment-filename'];
      if(!Number.isSafeInteger(version)||typeof key!=='string'||typeof name!=='string')throw new ApiError(400,'invalid_attachment_metadata');
      let filename:string;try{filename=decodeURIComponent(name);}catch{throw new ApiError(400,'invalid_attachment_filename');}
      return {draft:await service(request).addAttachment(actor(request),request.params.id,request.params.draftId,{expectedVersion:version,mutationKey:key,filename},request.body)};
    });
    routes.post<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId/attachments/copy',{bodyLimit:8192},async request=>({draft:await service(request).copyAttachment(actor(request),request.params.id,request.params.draftId,body(request))}));
    routes.delete<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId/attachments/:attachmentId',{bodyLimit:4096},async request=>({draft:await service(request).removeAttachment(actor(request),request.params.id,request.params.draftId,request.params.attachmentId,body(request))}));
    routes.post<{Params:Params}>('/api/mailboxes/:id/drafts/:draftId/send',{bodyLimit:4096},async request=>({submission:await service(request).submit(actor(request),request.params.id,request.params.draftId,body(request))}));
    routes.get<{Params:Params}>('/api/mailboxes/:id/outbox',async request=>({outbox:await service(request).listOutbox(actor(request),request.params.id)}));
    routes.get<{Params:Params}>('/api/mailboxes/:id/outbox/:submissionId',async request=>({submission:await service(request).getSubmission(actor(request),request.params.id,request.params.submissionId)}));
    routes.post<{Params:Params}>('/api/mailboxes/:id/outbox/:submissionId/cancel',{bodyLimit:4096},async request=>({submission:await service(request).cancel(actor(request),request.params.id,request.params.submissionId,body(request))}));
  });
}
