import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/database.js';
import { MailService } from '../src/mail/service.js';
import type { MailListOptions, MailViewer } from '../src/mail/types.js';

const databaseUrl=process.env['TEST_DATABASE_URL'];
// Explicit opt-in: this creates and drops only a fresh synthetic 100k-row schema.
const enabled=process.env['TEST_MAIL_PERFORMANCE']==='1'&&!!databaseUrl;
describe.skipIf(!enabled)('100k-message isolated query-plan benchmark',()=>{
  const schema=`mail_perf_${randomUUID().replaceAll('-','')}`,box=randomUUID(),actor=randomUUID(),allocation=randomUUID();
  let admin:pg.Pool,pool:pg.Pool,service:MailService,threadId:string;
  let captured:{sql:string;values:unknown[]}|undefined;
  const viewer:MailViewer={principalId:actor,permissions:new Set(['mailbox.use'])};
  const reports:unknown[]=[];
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:databaseUrl});await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2});
    pool.on('connect',client=>{const query=client.query.bind(client);client.query=((...args:any[])=>{
      if(typeof args[0]==='string'&&args[0].includes('/* mail_list_'))captured={sql:args[0],values:args[1]??[]};
      return (query as any)(...args);
    }) as typeof client.query;});
    await migrate(pool);service=new MailService(pool);
    await pool.query("INSERT INTO principals(id,issuer,subject,app_role,access_enabled) VALUES($1::uuid,'synthetic',$1::text,1,true)",[actor]);
    await pool.query("INSERT INTO mailboxes(id,address,name) VALUES($1,'synthetic@example.test','Synthetic benchmark')",[box]);
    await pool.query("INSERT INTO mailbox_memberships(mailbox_id,principal_id,permissions) VALUES($1,$2,ARRAY['read'])",[box,actor]);
    await pool.query("INSERT INTO address_registry(address,domain,state) VALUES('synthetic@example.test','example.test','allocated')");
    await pool.query("INSERT INTO address_allocations(id,address,mailbox_id,source) VALUES($1,'synthetic@example.test',$2,'manual')",[allocation,box]);
    await pool.query('CREATE TABLE benchmark_ids AS SELECT n,gen_random_uuid() AS id,gen_random_uuid() AS thread_id FROM generate_series(1,100000) n');
    await pool.query('CREATE UNIQUE INDEX benchmark_ids_number ON benchmark_ids(n)');
    await pool.query('INSERT INTO mail_threads(id,mailbox_id) SELECT thread_id,$1 FROM benchmark_ids',[box]);
    await pool.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,direction,parse_status,subject,from_header,to_header,plain_text,preview)
      SELECT id,$1,'{}',$2,512,'2026-01-01'::timestamptz+n*interval '1 second',CASE WHEN n%100=0 THEN 'outbound' ELSE 'inbound' END,
        'parsed','Synthetic message '||n,'sender@example.test','synthetic@example.test',
        repeat('Complete synthetic body. ',48)||CASE WHEN n=12345 THEN 'needle-only' ELSE '' END,'Synthetic preview' FROM benchmark_ids`,[box,'a'.repeat(64)]);
    await pool.query(`INSERT INTO mail_message_state(message_id,mailbox_id,thread_id,folder)
      SELECT i.id,$1,COALESCE(parent.thread_id,i.thread_id),CASE WHEN i.n%10=0 THEN 'archive' ELSE 'inbox' END
      FROM benchmark_ids i LEFT JOIN benchmark_ids parent ON i.n%100 IN(1,2) AND parent.n=i.n-i.n%100`,[box]);
    await pool.query(`INSERT INTO mail_verified_copies(inbound_message_id,mailbox_id,sent_message_id,fingerprint_version,fingerprint_sha256,
      wire_message_id,envelope_recipient,allocation_id,route_revision,policy_digest,inbound_raw_sha256,inbound_raw_size,sent_raw_sha256,sent_raw_size)
      SELECT i.id,$1,parent.id,1,$2,parent.id::text||'@example.test','synthetic@example.test',$3,1,$2,$2,512,$2,512
      FROM benchmark_ids i JOIN benchmark_ids parent ON i.n%100 IN(1,2) AND parent.n=i.n-i.n%100`,[box,'a'.repeat(64),allocation]);
    await pool.query(`INSERT INTO message_reader_data(delivery_id,parser_version,headers)
      SELECT id,2,jsonb_build_object('from','sender@example.test','to','synthetic@example.test','cc','observer@example.test',
        'subject','Synthetic message '||n,'references',jsonb_build_array(),'inReplyTo',jsonb_build_array()) FROM benchmark_ids`);
    const label=randomUUID();await pool.query("INSERT INTO mailbox_labels(id,mailbox_id,name) VALUES($1,$2,'Synthetic label')",[label,box]);
    await pool.query('INSERT INTO mail_message_labels(mailbox_id,message_id,label_id) SELECT $1,id,$2 FROM benchmark_ids WHERE n%20=0',[box,label]);
    await pool.query(`INSERT INTO principal_message_flags(mailbox_id,message_id,principal_id,is_read,is_starred)
      SELECT $1,id,$2,true,n%99=0 FROM benchmark_ids WHERE n%33=0`,[box,actor]);
    threadId=(await pool.query('SELECT thread_id FROM benchmark_ids WHERE n=50000')).rows[0].thread_id;
    for(const table of ['deliveries','mail_message_state','mail_threads','mail_verified_copies','principal_message_flags','message_reader_data','mail_message_labels','message_attachments'])await pool.query(`ANALYZE ${table}`);
  },60000);
  afterAll(async()=>{
    try{if(reports.length){const directory=resolve('.local/mail-performance');await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'report.json'),JSON.stringify({rows:100000,readerHeaderRows:100000,labelLinks:5000,plainBodyBytes:1200,reports},null,2)+'\n');}}
    finally{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}}
  });
  const scenarios:Array<{name:string;options:MailListOptions;expected:number}>=[
    {name:'Inbox',options:{folder:'inbox'},expected:50},
    {name:'All',options:{folder:'all'},expected:50},
    {name:'Thread',options:{folder:'all'},expected:1},
    {name:'Query',options:{folder:'all',q:'needle-only'},expected:1},
    {name:'Threads',options:{folder:'all',view:'threads'},expected:50},
    {name:'LegacyInbox',options:{folder:'inbox',groupCopies:false},expected:50},
  ];
  it.each(scenarios)('$name keeps projection bounded and returns correct cards',async scenario=>{
    captured=undefined;const started=performance.now();
    const result=scenario.name==='Thread'?await service.thread(viewer,box,threadId,scenario.options):await service.list(viewer,box,scenario.options);
    const wallMs=performance.now()-started;expect(result.messages?.length??result.threads?.length).toBe(scenario.expected);
    expect(captured).toBeDefined();const query=captured!;
    const client=await pool.connect();let plan:any;
    try{await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='15000ms'");
      plan=(await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`,query.values)).rows[0]['QUERY PLAN'][0];
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const report={scenario:scenario.name,wallMs:Math.round(wallMs*100)/100,executionMs:plan['Execution Time'],planningMs:plan['Planning Time'],
      sharedHitBlocks:plan.Plan['Shared Hit Blocks'],sharedReadBlocks:plan.Plan['Shared Read Blocks'],tempReadBlocks:plan.Plan['Temp Read Blocks'],tempWrittenBlocks:plan.Plan['Temp Written Blocks'],plan:plan.Plan};
    reports.push(report);console.log(JSON.stringify({...report,plan:undefined}));
    expect(plan['Execution Time']).toBeLessThan(2500);
    if(['Inbox','All'].includes(scenario.name)){
      expect(JSON.stringify(plan.Plan)).toContain('deliveries_mailbox_received');
      expect(plan.Plan['Shared Hit Blocks']).toBeLessThan(10000);
    }
    if(scenario.name==='Thread')expect(plan.Plan['Shared Hit Blocks']).toBeLessThan(2000);
    if(scenario.name==='LegacyInbox')expect(result.messages!.every(card=>card.copies.length===1&&card.copyGroupId===card.id)).toBe(true);
    if(scenario.name==='Thread')expect(result.messages![0]!.copies).toHaveLength(3);
  },30000);
});
