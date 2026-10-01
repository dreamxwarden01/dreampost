import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import { ApiError } from '../src/errors.js';
import { registerMailRoutes } from '../src/mail/routes.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/database.js';
import { MailService } from '../src/mail/service.js';
import type { MailViewer } from '../src/mail/types.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('verified-copy API projection with isolated PostgreSQL', () => {
  const schema = `copy_projection_${randomUUID().replaceAll('-', '')}`;
  const box = randomUUID(), other = randomUUID(), alice = randomUUID(), bob = randomUUID(), allocation = randomUUID();
  let admin: pg.Pool, pool: pg.Pool, service: MailService;
  const viewer = (principalId: string): MailViewer => ({ principalId, permissions: new Set(['mailbox.use','mail.manage']) });
  const a = viewer(alice), b = viewer(bob);
  const authorize = (who: MailViewer) => async () => who;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }); await migrate(pool); service = new MailService(pool);
    for (const principal of [alice,bob]) await pool.query("INSERT INTO principals(id,issuer,subject,app_role,access_enabled) VALUES($1::uuid,'fixture',$1::text,1,true)",[principal]);
    for (const id of [box,other]) await pool.query('INSERT INTO mailboxes(id,address,name) VALUES($1,$2,$2)',[id,`${id}@example.test`]);
    await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read','manage_messages']),($1,$3,ARRAY['read'])",[box,alice,bob]);
    await pool.query("INSERT INTO address_registry(address,domain,state) VALUES('self@example.test','example.test','allocated')");
    await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source) VALUES($1,'self@example.test',$2,'manual')",[allocation,box]);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
  beforeEach(async () => { await pool.query('TRUNCATE deliveries,mail_threads,mail_operations,mailbox_labels,mailbox_changes CASCADE'); });
  // This fixture supplies an already-verified relation. Correlation evidence gates
  // are exercised separately; these tests pin pagination, visibility and actions.
  async function group(index = 0, count = 1) {
    const threadId = randomUUID(), sent = randomUUID(), received: string[] = [];
    await pool.query('INSERT INTO mail_threads(id,mailbox_id) VALUES($1,$2)',[threadId,box]);
    const at = new Date(Date.UTC(2026,9,1,12,0,index)).toISOString();
    for (let n = 0; n <= count; n++) {
      const id = n === 0 ? sent : randomUUID(), direction = n === 0 ? 'outbound' : 'inbound'; if (n) received.push(id);
      await pool.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,direction,parse_status,subject,from_header,to_header,plain_text)
        VALUES($1,$2,$3,$4,20,$5,$6,'parsed',$7,'Self <self@example.test>','visible@example.test','Full searchable content')`,
        [id,box,{privateBccFixture:'hidden@example.test'},'a'.repeat(64),at,direction,`Group ${index}`]);
      await pool.query('INSERT INTO mail_message_state(message_id,mailbox_id,thread_id,folder) VALUES($1,$2,$3,$4)',[id,box,threadId,n?'inbox':'archive']);
      if (n) await pool.query(`INSERT INTO mail_verified_copies(inbound_message_id,mailbox_id,sent_message_id,fingerprint_version,fingerprint_sha256,
        wire_message_id,envelope_recipient,allocation_id,route_revision,policy_digest,inbound_raw_sha256,inbound_raw_size,sent_raw_sha256,sent_raw_size)
        VALUES($1,$2,$3,1,$4,$5,'self@example.test',$6,1,$4,$4,20,$4,20)`,[id,box,sent,'a'.repeat(64),`${sent}@example.test`,allocation]);
    }
    return { sent, received, threadId };
  }
  const change = async (who: MailViewer, id: string, set: {read?: boolean;starred?: boolean;folder?: 'archive'|'inbox'|'trash'|'spam'}) => service.mutate(box,
    {operationId:randomUUID(),items:[{id,version:(await service.getState(who,box,id)).version}],set},authorize(who));
  it('provides one logical card and the same full conversation through Inbox and Sent, without private envelope data', async () => {
    const g = await group(0,2);
    for (const folder of ['inbox','sent','all'] as const) {
      const page = await service.list(a,box,{folder}); expect(page.messages).toHaveLength(1);
      const card = page.messages![0]!; expect(card.copyGroupId).toBe(g.sent); expect(card.threadId).toBe(g.threadId);
      expect(card.copies).toHaveLength(folder==='inbox'?2:folder==='sent'?1:3);
      expect(card.id).toBe(folder==='inbox'?card.copies[0]!.id:g.sent);
      expect(JSON.stringify(page)).not.toContain('hidden@example.test'); expect(JSON.stringify(page)).not.toContain('privateBccFixture');
      expect((await service.thread(a,box,card.threadId!)).messages).toHaveLength(1);
    }
    expect((await service.list(a,box,{folder:'all',view:'threads'})).threads![0]).toMatchObject({messageCount:1,matchedCount:1,unreadCount:1});
  });
  it('keeps old HTTP clients on per-delivery semantics and requires an explicit validated grouping opt-in',async()=>{
    const g=await group(),app=Fastify();
    app.setErrorHandler((error,request,reply)=>reply.code(error instanceof ApiError?error.statusCode:500).send({error:error instanceof ApiError?error.code:'error'}));
    registerMailRoutes(app,service,{authenticate:async()=>a});await app.ready();
    try{
      const path=`/mailboxes/${box}/messages?folder=all`;
      const legacy=await app.inject({url:path});expect(legacy.statusCode).toBe(200);expect(legacy.json().messages).toHaveLength(2);
      expect(legacy.json().messages.find((m:{id:string})=>m.id===g.sent)).toMatchObject({read:true,folder:'archive'});
      expect(legacy.json().messages.find((m:{id:string})=>m.id===g.received[0])).toMatchObject({read:false,folder:'inbox'});
      const grouped=await app.inject({url:path+'&groupCopies=true'});expect(grouped.statusCode).toBe(200);expect(grouped.json().messages).toHaveLength(1);
      expect(grouped.json().messages[0]).toMatchObject({id:g.sent,read:false});
      expect((await app.inject({url:`/mailboxes/${box}/threads/${g.threadId}`})).json().messages).toHaveLength(2);
      expect((await app.inject({url:`/mailboxes/${box}/threads/${g.threadId}?groupCopies=true`})).json().messages).toHaveLength(1);
      for(const suffix of ['&groupCopies=1','&groupCopies=true&groupCopies=false'])expect((await app.inject({url:path+suffix})).statusCode).toBe(400);
    }finally{await app.close();}
  });
  it('groups before the 50-card pagination boundary and has no missing or duplicate logical cards', async () => {
    const ids = []; for(let n=0;n<55;n++) ids.push((await group(n,2)).sent);
    for (const view of ['messages','threads'] as const) {
      const first = await service.list(a,box,{folder:'all',view,limit:50}); expect(first.nextCursor).toBeTruthy();
      const next = await service.list(a,box,{folder:'all',view,limit:50,cursor:first.nextCursor!}); expect(next.nextCursor).toBeNull();
      if(view==='messages') {const cards=[...first.messages!,...next.messages!];expect(cards).toHaveLength(55);expect(new Set(cards.map(c=>c.copyGroupId))).toEqual(new Set(ids));expect(cards.every(c=>c.copies.length===3)).toBe(true);}
      else {expect(first.threads).toHaveLength(50);expect(next.threads).toHaveLength(5);expect([...first.threads!,...next.threads!].every(t=>t.messageCount===1)).toBe(true);}
    }
  });
  it('applies read/star filters to logical flags while retaining all folder-visible copy versions', async () => {
    const g = await group(); await change(a,g.received[0]!,{starred:true});
    expect((await service.list(a,box,{folder:'all',unread:false})).messages).toHaveLength(0);
    const unread = (await service.list(a,box,{folder:'all',unread:true})).messages![0]!;expect(unread.copies).toHaveLength(2);expect(unread.read).toBe(false);
    expect((await service.list(a,box,{folder:'all',starred:false})).messages).toHaveLength(0);
    expect((await service.list(a,box,{folder:'all',starred:true})).messages![0]!.copies).toHaveLength(2);
    expect((await service.list(b,box,{folder:'all',starred:true})).messages).toHaveLength(0);
    await change(a,g.received[0]!,{read:true});expect((await service.list(a,box,{folder:'all',unread:false})).messages![0]!.read).toBe(true);
    expect((await service.list(b,box,{folder:'all',unread:true})).messages).toHaveLength(1);
  });
  it('keeps Inbox filing and undo independent from Sent and preserves per-copy authorization', async () => {
    const g = await group();const result = await change(a,g.received[0]!,{folder:'archive'});
    expect((await service.list(a,box,{folder:'inbox'})).messages).toHaveLength(0);expect((await service.list(a,box,{folder:'sent'})).messages).toHaveLength(1);
    await service.undo(box,result.operationId,authorize(a));expect((await service.list(a,box)).messages).toHaveLength(1);
    await expect(change(b,g.received[0]!,{folder:'trash'})).rejects.toMatchObject({code:'message_management_denied'});
    await expect(service.list(a,other,{folder:'all'})).rejects.toMatchObject({statusCode:404});
  });
  it('excludes hidden/deleted copies from cards and still resolves actual message locators', async () => {
    const g = await group(0,2);await change(a,g.received[0]!,{folder:'spam'});
    expect((await service.thread(a,box,g.received[1]!)).messages![0]!.copies).toHaveLength(2);
    const spam=(await service.list(a,box,{folder:'spam'})).messages![0]!;expect(spam.copies.map(c=>c.id)).toEqual([g.received[0]]);
    await pool.query('UPDATE deliveries SET deleted_at=now() WHERE id=$1',[g.sent]);
    const all=(await service.list(a,box,{folder:'all'})).messages![0]!;expect(all.copyGroupId).toBe(g.sent);expect(all.copies.map(c=>c.id)).toEqual([g.received[1]]);
    expect((await service.list(a,box,{folder:'sent'})).messages).toHaveLength(0);
  });
  it('searches and matches labels without discarding other visible variants', async () => {
    const g = await group();const label=(await service.mutateLabel(box,'create',undefined,{operationId:randomUUID(),name:'Synthetic'},authorize(a))).label!;
    await service.mutate(box,{operationId:randomUUID(),items:[{id:g.received[0]!,version:(await service.getState(a,box,g.received[0]!)).version}],addLabelIds:[label.id]},authorize(a));
    const page=await service.list(a,box,{folder:'all',q:'searchable',labelId:label.id});expect(page.messages).toHaveLength(1);
    expect(page.messages![0]!.copies).toHaveLength(2);expect(page.messages![0]!.labelIds).toEqual([label.id]);
  });
});
