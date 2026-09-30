import type { MailTransport, OutboundSubmission, OutboundResult } from '@dreampost/protocol';
import type { OutboundConfig } from './config.js';
import { normalizeProviderRfcMessageId } from '../mail/threading.js';
export class ProviderRejection extends Error {
  constructor(readonly code:string,readonly retryable=false,readonly retryAfterSeconds=30){super(code);this.name='ProviderRejection';}
}
export class UnknownSubmission extends Error { constructor(readonly code='provider_outcome_unknown'){super(code);this.name='UnknownSubmission';} }
async function readReply(response:Response):Promise<unknown>{
  if(!response.body)throw new UnknownSubmission('provider_reply_invalid');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw new UnknownSubmission('provider_reply_too_large');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new UnknownSubmission('provider_reply_invalid');}
}
export class CloudflareRawTransport implements MailTransport {
  readonly capabilities;
  constructor(private readonly config:OutboundConfig,private readonly fetcher:typeof fetch=fetch){
    if(!config.enabled||!config.accountId||!config.apiToken)throw new Error('outbound_not_configured');
    this.capabilities={maxMessageBytes:config.maxMessageBytes,maxRecipients:Math.min(config.maxRecipients,50),supportsIdempotencyKey:false};
  }
  async send(submission:OutboundSubmission):Promise<OutboundResult>{
    if(submission.mime.byteLength>this.config.maxMessageBytes||submission.recipients.length>this.capabilities.maxRecipients)throw new ProviderRejection('provider_limit_exceeded');
    const raw=Buffer.from(submission.mime),mime=raw.toString('utf8');
    if(!Buffer.from(mime).equals(raw))throw new ProviderRejection('mime_encoding_unsupported');
    let response:Response;
    try{response=await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/email/sending/send_raw`,{
      method:'POST',headers:{Authorization:`Bearer ${this.config.apiToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:submission.envelopeFrom,recipients:submission.recipients,mime_message:mime}),redirect:'error',signal:AbortSignal.timeout(this.config.providerTimeoutMs)});}
    catch{throw new UnknownSubmission();}
    const body=await readReply(response) as {success?:unknown;errors?:Array<{code?:unknown}>;result?:Record<string,unknown>};
    if(!response.ok||body?.success!==true){
      const code=body?.success===false&&Array.isArray(body.errors)&&body.errors.length===1?body.errors[0]?.code:null;
      if(response.status===429&&code===10004){const retry=Number(response.headers.get('retry-after'));throw new ProviderRejection('provider_throttled',true,Number.isSafeInteger(retry)&&retry>0?Math.min(retry,3600):30);}
      const definite=new Map([[400,new Set([10001,10200,10201,10202])],[401,new Set([10101,10103])],[403,new Set([10102,10105,10203])],[404,new Set([10000])]]);
      if(typeof code==='number'&&definite.get(response.status)?.has(code))throw new ProviderRejection(`provider_rejected_${code}`);
      throw new UnknownSubmission();
    }
    const result=body.result;if(!result||typeof result!=='object')throw new UnknownSubmission('provider_reply_invalid');
    const outcomes=new Map<string,OutboundResult['recipients'][number]>(),expected=new Set(submission.recipients);
    for(const [name,status]of[['delivered','accepted'],['queued','accepted'],['permanent_bounces','failed'],['suppressed_recipients','failed']] as const){
      const list=result[name]??(name==='suppressed_recipients'?[]:undefined);
      if(!Array.isArray(list))throw new UnknownSubmission('provider_reply_invalid');
      for(const address of list){if(typeof address!=='string'||!expected.has(address)||outcomes.has(address))throw new UnknownSubmission('provider_reply_invalid');outcomes.set(address,{address,status,code:`cf_${name}`});}
    }
    const id=result.message_id;
    if(id!==undefined&&(typeof id!=='string'||id.length>998||/[\r\n\0]/.test(id)))throw new UnknownSubmission('provider_reply_invalid');
    // Cloudflare documents message_id with a bracketed sent-message example;
    // the controlled raw-send/reply probe confirmed its wire-ID meaning. Other
    // transports may have only opaque receipts; those never become thread aliases.
    const rfcMessageId=normalizeProviderRfcMessageId(id);
    return {...(typeof id==='string'&&id?{providerMessageId:id}:{}),...(rfcMessageId?{rfcMessageId}:{}),recipients:submission.recipients.map(address=>outcomes.get(address)??{address,status:'unknown',code:'provider_recipient_unreported'})};
  }
}
