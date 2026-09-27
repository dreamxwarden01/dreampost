import MailComposer from 'nodemailer/lib/mail-composer';
import type { SendSnapshot } from './types.js';
import { ApiError } from '../errors.js';
import { digest, references } from './validation.js';
export async function composeMessage(snapshot:SendSnapshot, parts:Array<{id:string;bytes:Buffer}>, maxBytes:number):Promise<Buffer>{
  let body=snapshot.bodyText;
  if(snapshot.quote?.include){
    const quote=snapshot.quote;
    const person=quote.attribution.from.map(value=>value.name?`${value.name} <${value.address}>`:value.address).join(', ');
    if(snapshot.mode==='forward'){
      const format=(values:typeof quote.attribution.to)=>values.map(value=>value.name?`${value.name} <${value.address}>`:value.address).join(', ');
      body+=`\n\n---------- Forwarded message ----------\nFrom: ${person}\nDate: ${quote.attribution.sentAt??'Unknown date'}\nSubject: ${quote.attribution.subject}\nTo: ${format(quote.attribution.to)}`;
      if(quote.attribution.cc.length)body+=`\nCc: ${format(quote.attribution.cc)}`;
      body+=`\n\n${quote.text}`;
    }else body+=`\n\nOn ${quote.attribution.sentAt??'an unknown date'}, ${person||'the sender'} wrote:\n`+quote.text.split(/\r?\n/).map(line=>`> ${line}`).join('\n');
  }
  const composer=new MailComposer({from:snapshot.from,to:snapshot.to,cc:snapshot.cc,subject:snapshot.subject,text:body,
    messageId:snapshot.messageIdHeader,date:new Date(snapshot.date),inReplyTo:references(snapshot.inReplyTo).join(' ')||undefined,references:references(snapshot.references),
    envelope:{from:snapshot.from.address,to:snapshot.envelopeRecipients},disableFileAccess:true,disableUrlAccess:true,
    newline:'\r\n',textEncoding:'quoted-printable',baseBoundary:snapshot.submissionId,
    attachments:snapshot.attachments.map(part=>{const owned=parts.find(value=>value.id===part.id);if(!owned||owned.bytes.length!==part.sizeBytes||digest(owned.bytes)!==part.sha256)throw new ApiError(409,'draft_attachment_unavailable');
      return {filename:part.filename,content:owned.bytes,contentType:part.mimeType,contentDisposition:'attachment',contentTransferEncoding:'base64'};})});
  const compiled=composer.compile();compiled.keepBcc=false;
  const stream=compiled.createReadStream();const chunks:Buffer[]=[];let length=0;
  try{for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;
    if(length>maxBytes){stream.destroy();throw new ApiError(413,'message_too_large');}chunks.push(bytes);}}
  catch(error){stream.destroy();throw error;}
  const message=Buffer.concat(chunks,length);
  if(!Buffer.from(message.toString('utf8'),'utf8').equals(message))throw new ApiError(400,'mime_encoding_unsupported');
  const boundary=message.indexOf('\r\n\r\n');
  if(boundary<0||/^bcc\s*:/im.test(message.subarray(0,boundary).toString('utf8')))throw new Error('bcc_header_forbidden');
  return message;
}
