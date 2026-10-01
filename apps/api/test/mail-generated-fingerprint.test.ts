import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { composeMessage } from '../src/outbound/mime.js';
import type { SendSnapshot } from '../src/outbound/types.js';
import { fingerprintMessageContent } from '../src/mail/content-fingerprint.js';

const id = '00000000-0000-4000-8000-000000000001';
// Version 1 is a persisted policy. These constants must not be regenerated to
// accept an accidental normalization change; a later policy needs a new version.
const golden = {
  ascii: '458a1bf5417af9760983c120a2528dae4a5133ba79bc8bd8c7843797c38f1646',
  unicode: 'fa1ca8743504346733718a00b96718fcc636faefc852f3eed7f99e5a8b889c21',
  attachment: '972149e81c57f5b074cac421a629881384bbcc0dfc3ba464a243a816befb52a9',
  reply: '5c181cf1ffbe9148177fe516b94aabde3b60d494e95ba160b41b92657d0ad514',
  empty: '2bce8b7b926a813542274b7919e89339ad28ba4410d6a80c333cb484101367ff',
} as const;
async function generated(kind: keyof typeof golden) {
  const snapshot: SendSnapshot = { submissionId:id,transportKey:'fixture',draftId:id,draftVersion:1,mailboxId:id,authorPrincipalId:id,
    fromAllocationId:id,from:{name:'Synthetic Owner',address:'owner@example.test'},grantId:id,sendingGeneration:1,policyRevision:1,policyDigest:'a'.repeat(64),
    to:[{name:'',address:'self@example.test'}],cc:[],bcc:[],envelopeRecipients:['self@example.test'],subject:'Synthetic fingerprint vector',
    bodyText:kind==='unicode'?'Unicode caf\u00e9 \u4e2d\u6587 \u2713':kind==='empty'?'':'Exact generated self-copy body.',quote:null,mode:'new',sourceMessageId:null,
    inReplyTo:[],references:[],messageIdHeader:'<fixed.local@example.test>',date:'2026-10-01T00:00:00.000Z',attachments:[] };
  const parts:Array<{id:string;bytes:Buffer}>=[];
  if(kind==='attachment'){
    const bytes=Buffer.from('Synthetic attachment bytes\r\n'),sha256=createHash('sha256').update(bytes).digest('hex');
    snapshot.attachments=[{id,filename:'fixture.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256}];parts.push({id,bytes});
  }
  if(kind==='reply'){
    snapshot.mode='reply';snapshot.sourceMessageId=id;snapshot.inReplyTo=['<parent@example.test>'];snapshot.references=['<parent@example.test>'];
    snapshot.quote={sourceMessageId:id,sourceContentVersion:'fixture:2',sourceSha256:'b'.repeat(64),include:true,
      attribution:{from:[{name:'Original Sender',address:'original@example.test'}],to:[{name:'',address:'self@example.test'}],cc:[],subject:'Prior subject',sentAt:'2026-09-30T00:00:00.000Z'},text:'Original quoted text.\nAnother line.'};
  }
  return composeMessage(snapshot,parts,5*1024*1024);
}
function observedTransportTransform(raw:Buffer) {
  const at=raw.indexOf('\r\n\r\n'),header=raw.subarray(0,at).toString('utf8');
  const annotations='Received: synthetic relay\r\nFeedback-ID: synthetic:provider\r\nX-Cf-Spamh-Score: 0\r\n'
    +'DKIM-Signature: synthetic-unverified\r\nDKIM-Signature: second-unverified\r\nARC-Authentication-Results: synthetic-unverified\r\nARC-Message-Signature: synthetic-unverified\r\nARC-Seal: synthetic-unverified\r\n';
  return Buffer.concat([Buffer.from(annotations),Buffer.from(header.replace(/^Message-ID:.*$/im,'Message-ID: <provider@example.test>')+'\r\n\r\n'),raw.subarray(at+4),Buffer.from('\r\n')]);
}
describe('real MIME generator and fingerprint version 1 golden vectors',()=>{
  it.each(Object.keys(golden) as Array<keyof typeof golden>)('matches the observed transport transformation for generated %s mail',async kind=>{
    const raw=await generated(kind),before=Buffer.from(raw),changed=observedTransportTransform(raw);
    expect(fingerprintMessageContent(raw)).toEqual({version:1,sha256:golden[kind]});
    expect(fingerprintMessageContent(changed)).toEqual({version:1,sha256:golden[kind]});
    expect(raw).toEqual(before);expect(raw.equals(changed)).toBe(false);
    const header=raw.subarray(0,raw.indexOf('\r\n\r\n')).toString();
    if(kind==='ascii'||kind==='reply')expect(header).toContain('Content-Transfer-Encoding: 7bit');
    if(kind==='unicode')expect(header).toContain('Content-Transfer-Encoding: quoted-printable');
    if(kind==='empty'){expect(header).toContain('Content-Type: text/plain');expect(header).not.toContain('Content-Transfer-Encoding:');}
  });
  it('still rejects changed content after a real generated transport transformation',async()=>{
    const changed=observedTransportTransform(await generated('ascii'));
    expect(fingerprintMessageContent(Buffer.from(changed.toString().replace('Exact generated self-copy body.','Different generated self-copy body.')))?.sha256).not.toBe(golden.ascii);
    expect(fingerprintMessageContent(Buffer.from(changed.toString().replace('Subject: Synthetic fingerprint vector','Subject: Changed subject')))?.sha256).not.toBe(golden.ascii);
  });
});
