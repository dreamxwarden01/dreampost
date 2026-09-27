import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { MailAddress } from '@dreampost/protocol';
import { ApiError } from '../errors.js';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireId(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400,'invalid_identity'); return value.toLowerCase(); }
export function text(value: unknown, maxBytes: number, multiline = false, code = 'invalid_draft_field'): string {
  if (typeof value !== 'string' || Buffer.byteLength(value)>maxBytes || (multiline ? /\u0000/.test(value) : /[\x00-\x1f\x7f]/.test(value))) throw new ApiError(400,code);
  return value;
}
export function addressList(value: unknown): MailAddress[] {
  if (!Array.isArray(value) || value.length>100) throw new ApiError(400,'invalid_recipients');
  return value.map(item=>{
    if (!item || typeof item!=='object' || Object.keys(item).some(key=>!['name','address'].includes(key))) throw new ApiError(400,'invalid_recipients');
    return {name:text(item.name ?? '',512,false,'invalid_recipient_name'),address:text(item.address,2048,false,'invalid_recipient_address_field')};
  });
}
/** Normalize inherited header presentation without splitting a Unicode code point. */
export function seedHeader(value:string,maxBytes:number):string {
  const cleaned=value.replace(/[\x00-\x1f\x7f]+/g,' ');let result='',bytes=0;
  for(const point of cleaned){const size=Buffer.byteLength(point);if(bytes+size>maxBytes)break;result+=point;bytes+=size;}return result;
}
export function sourceIdentity(sha256:string|null|undefined,legacyVersion?:string|null):string {
  const value=sha256??legacyVersion?.split(':')[0];
  if(!value||! /^[0-9a-f]{64}$/.test(value))throw new ApiError(409,'source_identity_unavailable');return value;
}
export function normalizedAddress(value: string): string {
  const address=value.trim(), at=address.lastIndexOf('@');
  if(at<1||at!==address.indexOf('@'))throw new ApiError(400,'invalid_recipient_address');
  const local=address.slice(0,at),domain=domainToASCII(address.slice(at+1)).toLowerCase();
  if(Buffer.byteLength(address)>254||local.length>64||!/[\x21-\x7e]/.test(local)||!/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local)||local.startsWith('.')||local.endsWith('.')||local.includes('..')
    ||!domain||domain.length>253||domain.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw new ApiError(400,'invalid_recipient_address');
  return `${local}@${domain}`;
}
export function strictRecipients(lists: MailAddress[][], maximum: number): { lists: MailAddress[][]; envelope: string[] } {
  const seen=new Set<string>();
  const normalized=lists.map(list=>list.map(item=>({name:text(item.name,512,false,'invalid_recipient_name'),address:normalizedAddress(item.address)})).filter(item=>{if(seen.has(item.address))return false;seen.add(item.address);return true;}));
  if(!seen.size)throw new ApiError(400,'recipient_required');
  if(seen.size>maximum)throw new ApiError(413,'too_many_recipients');
  return {lists:normalized,envelope:[...seen]};
}
export function canonical(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,part])=>`${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function safeFilename(value: string): string {
  const name=text(value,1024).split(/[\\/]/).at(-1)!.trim();
  if(!name||name==='.'||name==='..')throw new ApiError(400,'invalid_attachment_filename');
  return name;
}
export function references(values:string[]):string[]{
  const valid=[...new Set(values.filter(value=>/^<[^<>\s@]+@[^<>\s@]+>$/.test(value)&&Buffer.byteLength(value)<=998))];
  const result:string[]=[];let size=0;
  for(const value of valid.slice(-100).reverse()){if(size+Buffer.byteLength(value)+1>2048)break;result.unshift(value);size+=Buffer.byteLength(value)+1;}
  return result;
}

export function requireVersion(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<1)throw new ApiError(400,'expected_version_required');return Number(value);}
