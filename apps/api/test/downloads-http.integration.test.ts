import { randomBytes,randomUUID,generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createDownloadControlHeaders,verifyDownloadControlResponse,DOWNLOAD_CONTROL_PATH,sha256Hex,type DownloadControlRequest,type DownloadControlReply } from '@dreampost/protocol';
import { buildApp } from '../src/app.js';
import { migrate,seedMailbox } from '../src/database.js';
import { hashSecret } from '../src/auth/cookies.js';
import { SECURE_SESSION_COOKIE } from '../src/auth/types.js';
import type { ApiConfig } from '../src/config.js';

const databaseUrl=process.env['TEST_DATABASE_URL'];
const origin='https://mail.example.com',issuer='https://sso.example.test',clientId='download-http-test';
const key={id:'download-http-test',secret:'synthetic-independent-download-key-32-bytes'};
interface User{id:string;sessionId:string;token:string;csrf:string}
describe.skipIf(!databaseUrl)('attachment source authorization and signed control HTTP',()=>{
  const schema=`download_http_${randomUUID().replaceAll('-','')}`;
  const mailbox=randomUUID(),message=randomUUID(),attachment=randomUUID();
  const digest='a'.repeat(64);
  let admin:pg.Pool,pool:pg.Pool,app:ReturnType<typeof buildApp>,user:User,operator:User;
  const path=`/api/mailboxes/${mailbox}/messages/${message}/attachments`;
  async function makeUser(role:number):Promise<User>{
    const id=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO principals(id,issuer,subject,username,app_role,access_enabled) VALUES($1,$2,$3,$4,$5,true)',[id,issuer,randomUUID(),'test-user',role]);
    const result=await pool.query<{session_id:string}>(`INSERT INTO auth_sessions(token_hash,client_id,principal_id,sso_sid,auth_version,csrf_token,id_token_hint,expires_at,idle_expires_at,next_activity_at)
      VALUES($1,$2,$3,$4,0,$5,'synthetic',now()+interval '2 hours',now()+interval '1 hour',now()+interval '1 day') RETURNING session_id`,[hashSecret(token),clientId,id,randomUUID(),csrf]);
    return{id,token,csrf,sessionId:result.rows[0]!.session_id};
  }
  function headers(u=user){return{cookie:`${SECURE_SESSION_COOKIE}=${u.token}`,origin,'x-csrf-token':u.csrf};}
  async function control(request:DownloadControlRequest){
    const signed=await createDownloadControlHeaders(request,key);
    const response=await app.inject({method:'POST',url:DOWNLOAD_CONTROL_PATH,headers:signed,payload:JSON.stringify(request)});
    const reply=await verifyDownloadControlResponse(response.headers as Record<string,string>,new TextEncoder().encode(response.body),{[key.id]:key.secret},{requestNonce:signed['x-dreampost-download-nonce'],status:response.statusCode});
    return{response,reply,signed};
  }
  async function create(purpose:'download'|'preview'='download'){
    const flowId=randomUUID(),challengeHash=await sha256Hex(randomBytes(32)),secretHash=await sha256Hex(randomBytes(32));
    const response=await app.inject({method:'POST',url:`${path}/${attachment}/sessions`,headers:headers(),payload:{flowId,challengeHash,purpose}});
    expect(response.statusCode).toBe(200);
    return{version:1 as const,op:'redeem' as const,flowId,challengeHash,secretHash,ticket:response.json().ticket as string};
  }
  function admission(reply:DownloadControlReply,secretHash:string):DownloadControlRequest{
    if(reply.op!=='redeem')throw new Error('Unexpected bootstrap response');
    return{version:1,op:'authorize',sessionId:reply.sessionId,transferId:reply.transferId,secretHash,method:'GET',requestOrigin:reply.purpose==='preview'?origin:null};
  }
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,connectionTimeoutMillis:5000,max:1});
    await migrate(pool);await seedMailbox(pool,{id:mailbox,address:'reader@example.test',name:'Synthetic attachment mailbox'});
    await pool.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,parse_status) VALUES($1,$2,'{}',$3,1,now(),'parsed')`,[message,mailbox,digest]);
    await pool.query(`INSERT INTO attachment_inventories(delivery_id,status) VALUES($1,'complete')`,[message]);
    await pool.query(`INSERT INTO attachment_objects(id,sha256,size_bytes,object_key,state,preview_kind,media_type,ready_at) VALUES($1,$2,10,$3,'ready','pdf','application/pdf',now())`,[attachment,digest,`attachments/${attachment}/${digest}`]);
    await pool.query(`INSERT INTO message_attachments(delivery_id,ordinal,attachment_id,filename,mime_type) VALUES($1,0,$2,'example.pdf','application/pdf')`,[message,attachment]);
    const config:ApiConfig={databaseUrl:databaseUrl!,mailStorePath:'/unused/synthetic',ingestKeys:{ingest:'independent-ingest-fixture-key-32-bytes'},devViewToken:'',devMailboxId:'',host:'127.0.0.1',port:0,publicBaseUrl:origin,
      auth:{issuer,clientId,publicBaseUrl:origin,clientPrivateJwk:{...generateKeyPairSync('ed25519').privateKey.export({format:'jwk'}),kid:'fixture'}},
      downloads:{origin:'https://download.example.com',previewOrigin:'https://preview.example.net',key,stagingPath:'/unused/staging',sessionTtlSeconds:3600,maxPreviewBytes:20*1024*1024,stageMaxBytes:256*1024*1024,storageMaxBytes:5*1024*1024*1024,maxSessions:16,maxPendingSessions:4,allowInsecureLocal:false}};
    app=buildApp(config,pool,{authFetch:async()=>{throw new Error('Unexpected real identity-provider request');}});
    user=await makeUser(1);operator=await makeUser(0);
    await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])",[mailbox,user.id]);
  });
  afterAll(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}});
  it('lists only authorized mailbox attachments, even for postmaster',async()=>{
    const allowed=await app.inject({url:path,headers:headers()});expect(allowed.statusCode).toBe(200);expect(allowed.json().items[0]).toMatchObject({id:attachment,previewKind:'pdf',state:'ready'});
    expect((await app.inject({url:path,headers:headers(operator)})).statusCode).toBe(404);
  });
  it('requires Origin and CSRF for issuing a ticket',async()=>{
    const body={flowId:randomUUID(),challengeHash:digest,purpose:'download'};
    expect((await app.inject({method:'POST',url:`${path}/${attachment}/sessions`,headers:{...headers(),origin:'https://elsewhere.example'},payload:body})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:`${path}/${attachment}/sessions`,headers:{...headers(),'x-csrf-token':'invalid'},payload:body})).statusCode).toBe(403);
  });
  it('binds the ticket to the challenge and permits a single redemption',async()=>{
    const request=await create();
    expect((await control({...request,challengeHash:'b'.repeat(64)})).response.statusCode).toBe(401);
    const redeemed=await control(request);expect(redeemed.response.statusCode).toBe(200);
    expect((await control(request)).response.statusCode).toBe(401);
    const sameWire=await app.inject({method:'POST',url:DOWNLOAD_CONTROL_PATH,headers:redeemed.signed,payload:JSON.stringify(request)});expect(sameWire.statusCode).toBe(409);
    const authorized=await control(admission(redeemed.reply,request.secretHash));expect(authorized.reply.op).toBe('authorize');
  });
  it('keeps concurrent session/transfer pairs separate',async()=>{
    const a=await create(),b=await create();const [ar,br]=await Promise.all([control(a),control(b)]);
    const aa=admission(ar.reply,a.secretHash),bb=admission(br.reply,b.secretHash);
    if(aa.op!=='authorize'||bb.op!=='authorize')throw new Error('Invalid fixture');
    expect(aa.sessionId).not.toBe(bb.sessionId);
    expect((await control({...aa,transferId:bb.transferId})).response.statusCode).toBe(404);
    expect((await control({...aa,secretHash:b.secretHash})).response.statusCode).toBe(401);
    expect((await control(aa)).response.statusCode).toBe(200);expect((await control(bb)).response.statusCode).toBe(200);
  });
  it('does not renew source idle time and supports source token rotation',async()=>{
    const request=await create();const redeemed=await control(request);const admit=admission(redeemed.reply,request.secretHash);
    const before=(await pool.query('SELECT idle_expires_at,last_seen FROM auth_sessions WHERE session_id=$1',[user.sessionId])).rows[0];
    user.token=randomBytes(32).toString('base64url');await pool.query('UPDATE auth_sessions SET token_hash=$2 WHERE session_id=$1',[user.sessionId,hashSecret(user.token)]);
    for(let i=0;i<3;i++)expect((await control(admit)).response.statusCode).toBe(200);
    const after=(await pool.query('SELECT idle_expires_at,last_seen FROM auth_sessions WHERE session_id=$1',[user.sessionId])).rows[0];expect(after).toEqual(before);
  });
  it('rechecks membership and message availability',async()=>{
    const request=await create();const redeemed=await control(request);const admit=admission(redeemed.reply,request.secretHash);
    await pool.query('UPDATE mailbox_memberships SET revoked_at=now() WHERE principal_id=$1',[user.id]);expect((await control(admit)).response.statusCode).toBe(404);
    await pool.query('UPDATE mailbox_memberships SET revoked_at=NULL WHERE principal_id=$1',[user.id]);
    await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1',[message]);expect((await control(admit)).response.statusCode).toBe(404);
    await pool.query('UPDATE deliveries SET deleted_at=NULL WHERE id=$1',[message]);
  });
  it('adds file transfers only to the same active source session',async()=>{
    const request=await create();const redeemed=await control(request);const admit=admission(redeemed.reply,request.secretHash);
    if(redeemed.reply.op!=='redeem')throw new Error('Invalid fixture');
    const url=`${path}/${attachment}/transfers`;
    const body={sessionId:redeemed.reply.sessionId,purpose:'preview'};
    expect((await app.inject({method:'POST',url,headers:headers(),payload:body})).statusCode).toBe(409);
    expect((await control(admit)).response.statusCode).toBe(200);
    const response=await app.inject({method:'POST',url,headers:headers(),payload:body});expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBe(redeemed.reply.sessionId);expect(response.json().transferId).not.toBe(redeemed.reply.transferId);
    await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])",[mailbox,operator.id]);
    expect((await app.inject({method:'POST',url,headers:headers(operator),payload:body})).statusCode).toBe(403);
    await pool.query('DELETE FROM mailbox_memberships WHERE mailbox_id=$1 AND principal_id=$2',[mailbox,operator.id]);
    const previewRequest:DownloadControlRequest={version:1,op:'authorize',sessionId:response.json().sessionId,transferId:response.json().transferId,
      secretHash:request.secretHash,method:'GET',requestOrigin:null};
    expect((await control(previewRequest)).response.statusCode).toBe(403);
    expect((await control({...previewRequest,requestOrigin:origin})).response.statusCode).toBe(200);
  });
  it('prunes only dead presented cookies without evicting active sessions',async()=>{
    const request=await create();const redeemed=await control(request);const admit=admission(redeemed.reply,request.secretHash);
    if(redeemed.reply.op!=='redeem')throw new Error('Invalid fixture');
    await control(admit);
    const missing=randomUUID();
    const requestPrune:DownloadControlRequest={version:1,op:'prune',sessions:[
      {sessionId:redeemed.reply.sessionId,secretHash:request.secretHash},{sessionId:missing,secretHash:'b'.repeat(64)}]};
    const before=await control(requestPrune);expect(before.reply).toEqual({version:1,op:'prune',expiredSessionIds:[missing]});
    expect((await control(admit)).response.statusCode).toBe(200);
    const wrong=await control({version:1,op:'prune',sessions:[{sessionId:redeemed.reply.sessionId,secretHash:'c'.repeat(64)}]});
    expect(wrong.reply).toEqual({version:1,op:'prune',expiredSessionIds:[redeemed.reply.sessionId]});
    expect((await control(admit)).response.statusCode).toBe(200);
    await pool.query("UPDATE attachment_download_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[redeemed.reply.sessionId]);
    const after=await control(requestPrune);expect(after.reply).toEqual({version:1,op:'prune',expiredSessionIds:[redeemed.reply.sessionId,missing]});
  });
  it('denies later admissions after the source session is deleted',async()=>{
    const request=await create();const redeemed=await control(request);const admit=admission(redeemed.reply,request.secretHash);
    await pool.query('DELETE FROM auth_sessions WHERE session_id=$1',[user.sessionId]);expect((await control(admit)).response.statusCode).toBe(401);
  });
});
