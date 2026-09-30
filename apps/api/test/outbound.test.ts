import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import PostalMime from 'postal-mime';
import { composeMessage } from '../src/outbound/mime.js';
import { CloudflareRawTransport,ProviderRejection,UnknownSubmission } from '../src/outbound/provider.js';
import { loadOutboundConfig } from '../src/outbound/config.js';
import { addressList,normalizedAddress,strictRecipients } from '../src/outbound/validation.js';
import type { SendSnapshot } from '../src/outbound/types.js';
const config=loadOutboundConfig({OUTBOUND_PROVIDER:'cloudflare',OUTBOUND_CF_ACCOUNT_ID:'a'.repeat(32),OUTBOUND_CF_API_TOKEN:'synthetic-outbound-provider-test-token'});
function snapshot():SendSnapshot{return {submissionId:randomUUID(),transportKey:'fixture',draftId:randomUUID(),draftVersion:1,mailboxId:randomUUID(),authorPrincipalId:randomUUID(),fromAllocationId:randomUUID(),from:{name:'Sender',address:'sender@example.test'},grantId:randomUUID(),sendingGeneration:1,policyRevision:1,policyDigest:'a'.repeat(64),
 to:[{name:'Recipient',address:'to@example.test'}],cc:[{name:'Copy',address:'cc@example.test'}],bcc:[{name:'Hidden',address:'hidden@example.test'}],envelopeRecipients:['to@example.test','cc@example.test','hidden@example.test'],subject:'Test \u4e16\u754c',bodyText:'New words \u4e2d\u6587',quote:null,mode:'new',sourceMessageId:null,inReplyTo:[],references:[],messageIdHeader:'<fixed@example.test>',date:'2026-09-27T12:00:00Z',attachments:[]};}

describe('outbound composition and provider boundary',()=>{
 it('keeps pending recipient text in drafts but validates normalized envelopes at send',()=>{
  expect(addressList([{name:'',address:'someone@'}])[0]!.address).toBe('someone@');
  expect(()=>strictRecipients([[{name:'',address:'someone@'}]],50)).toThrow('invalid_recipient_address');
  expect(normalizedAddress('Case+b@B\u00dcCHER.example')).toBe('Case+b@xn--bcher-kva.example');
  expect(()=>normalizedAddress('\u540d@example.test')).toThrow('invalid_recipient_address');
  expect(()=>addressList([{name:'Injected\r\nBcc: other@example.test',address:'a@example.test'}])).toThrow();
  expect(strictRecipients([[{name:'',address:'a@EXAMPLE.test'}],[{name:'',address:'a@example.test'}]],50).envelope).toEqual(['a@example.test']);
 });
 it('builds Bcc-free MIME with Unicode content and separate envelope recipients',async()=>{
  const s=snapshot(),raw=await composeMessage(s,[],config.maxMessageBytes),parsed=await PostalMime.parse(raw);
  expect(parsed.subject).toBe(s.subject);expect(parsed.text).toContain(s.bodyText);expect(parsed.bcc).toBeUndefined();expect(raw.toString()).not.toContain('hidden@example.test');
  expect(parsed.messageId).toBe('<fixed@example.test>');expect(parsed.from?.address).toBe('sender@example.test');
 });
 it('includes quote separately without changing authored body and preserves reply headers',async()=>{
  const s=snapshot();s.inReplyTo=['<parent@example.test>'];s.references=['<older@example.test>','<parent@example.test>'];s.quote={sourceMessageId:randomUUID(),sourceContentVersion:'fixture:1',include:true,attribution:{from:[{name:'Original',address:'original@example.test'}],to:[],cc:[],subject:'Original',sentAt:'2026-09-27T10:00:00Z'},text:'Original line\nSecond line'};
  const included=await PostalMime.parse(await composeMessage(s,[],config.maxMessageBytes));expect(included.text).toContain('> Original line');expect(included.inReplyTo).toBe('<parent@example.test>');expect(s.bodyText).not.toContain('Original line');
  s.quote.include=false;expect((await PostalMime.parse(await composeMessage(s,[],config.maxMessageBytes))).text).not.toContain('Original line');
 });
 it('formats forwarding with the visible original headers and no private Bcc attribution',async()=>{
  const s=snapshot();s.mode='forward';s.quote={sourceMessageId:randomUUID(),sourceContentVersion:'fixture',include:true,attribution:{from:[{name:'Original',address:'original@example.test'}],to:[{name:'To',address:'visible@example.test'}],cc:[{name:'Cc',address:'copy@example.test'}],subject:'Original subject',sentAt:'2026-09-27T10:00:00Z'},text:'Original content'};
  const parsed=await PostalMime.parse(await composeMessage(s,[],config.maxMessageBytes));expect(parsed.text).toContain('Forwarded message');expect(parsed.text).toContain('Subject: Original subject');expect(parsed.text).toContain('To: To <visible@example.test>');expect(parsed.text).toContain('Cc: Cc <copy@example.test>');expect(parsed.text).not.toContain('Bcc:');expect(parsed.text!.indexOf(s.bodyText)).toBeLessThan(parsed.text!.indexOf('Forwarded message'));
 });
 it('checks final MIME bytes, rather than input text alone',async()=>{
  const s=snapshot();s.bodyText='x'.repeat(300);await expect(composeMessage(s,[],100)).rejects.toMatchObject({code:'message_too_large'});
 });
 it('sends one raw JSON request, routes private recipients only through the envelope, and preserves partial outcomes',async()=>{
  const s=snapshot(),mime=await composeMessage(s,[],config.maxMessageBytes);
  const fake=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{expect(String(_url)).toContain('/email/sending/send_raw');expect(init?.redirect).toBe('error');const body=JSON.parse(String(init?.body));expect(body.from).toBe(s.from.address);expect(body.recipients).toEqual(s.envelopeRecipients);expect(body.mime_message).toBe(mime.toString());return Response.json({success:true,result:{message_id:'provider-id',delivered:['to@example.test'],queued:['cc@example.test'],permanent_bounces:[],suppressed_recipients:['hidden@example.test']}});});
  const result=await new CloudflareRawTransport(config,fake).send({submissionId:s.submissionId,envelopeFrom:s.from.address,recipients:s.envelopeRecipients,mime});
  expect(fake).toHaveBeenCalledTimes(1);expect(result.recipients.map(r=>r.status)).toEqual(['accepted','accepted','failed']);expect(result.recipients[2]!.code).toBe('cf_suppressed_recipients');
 });
 it('records an explicit case-preserved Cloudflare RFC identity separately from opaque tracking receipts',async()=>{
  const input={submissionId:randomUUID(),envelopeFrom:'a@example.test',recipients:['b@example.test'],mime:Buffer.from('body')};
  for(const id of ['<Wire.Case@Example.test>','opaque-receipt','unbracketed@example.test','<a@example.test> <b@example.test>','<a@\u4f8b.example>']){
   const result=await new CloudflareRawTransport(config,async()=>Response.json({success:true,result:{message_id:id,delivered:[],queued:input.recipients,permanent_bounces:[]}})).send(input);
   expect(result.providerMessageId).toBe(id);expect(result.rfcMessageId).toBe(id==='<Wire.Case@Example.test>'?id:undefined);
   expect(result.recipients[0]!.status).toBe('accepted');
  }
 });
 it('does not retry uncertain network or internal failure responses' ,async()=>{
  for(const fake of [vi.fn(async()=>{throw new Error('timeout');}),vi.fn(async()=>Response.json({success:false,errors:[{code:10002}]},{status:500})),vi.fn(async()=>new Response('proxy',{status:503}))]){
   await expect(new CloudflareRawTransport(config,fake).send({submissionId:randomUUID(),envelopeFrom:'a@example.test',recipients:['b@example.test'],mime:Buffer.from('body')})).rejects.toBeInstanceOf(UnknownSubmission);expect(fake).toHaveBeenCalledTimes(1);
  }
 });
 it('classifies only recognized pre-delivery rejections as safe to retry or fix',async()=>{
  await expect(new CloudflareRawTransport(config,async()=>Response.json({success:false,errors:[{code:10004}]},{status:429,headers:{'retry-after':'7'}})).send({submissionId:randomUUID(),envelopeFrom:'a@example.test',recipients:['b@example.test'],mime:Buffer.from('body')})).rejects.toMatchObject({retryable:true,retryAfterSeconds:7});
  await expect(new CloudflareRawTransport(config,async()=>Response.json({success:false,errors:[{code:10102}]},{status:403})).send({submissionId:randomUUID(),envelopeFrom:'a@example.test',recipients:['b@example.test'],mime:Buffer.from('body')})).rejects.toBeInstanceOf(ProviderRejection);
 });
 it('does not infer acceptance for a missing recipient or trust an unexpected recipient',async()=>{
  const input={submissionId:randomUUID(),envelopeFrom:'a@example.test',recipients:['b@example.test'],mime:Buffer.from('body')};
  const missing=await new CloudflareRawTransport(config,async()=>Response.json({success:true,result:{message_id:'id',delivered:[],queued:[],permanent_bounces:[]}})).send(input);expect(missing.recipients[0]!.status).toBe('unknown');
  await expect(new CloudflareRawTransport(config,async()=>Response.json({success:true,result:{delivered:['intruder@example.test'],queued:[],permanent_bounces:[]}})).send(input)).rejects.toBeInstanceOf(UnknownSubmission);
 });
 it('keeps sending disabled without explicit separate configuration',()=>{
  expect(loadOutboundConfig({CLOUDFLARE_API_TOKEN:'not-an-outbound-credential'}).enabled).toBe(false);
  expect(()=>loadOutboundConfig({OUTBOUND_PROVIDER:'cloudflare'})).toThrow();
 });
});
