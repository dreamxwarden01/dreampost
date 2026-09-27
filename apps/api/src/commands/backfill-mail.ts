import { parseArgs } from 'node:util';
import pg from 'pg';
import { backfillMailState } from '../mail/threading.js';
const {values}=parseArgs({options:{limit:{type:'string',default:'100'}}});
if(!process.env['DATABASE_URL'])throw new Error('DATABASE_URL is required');
const pool=new pg.Pool({connectionString:process.env['DATABASE_URL'],connectionTimeoutMillis:5000});
try{const indexed=await backfillMailState(pool,{limit:Number(values.limit)});const waiting=await pool.query<{count:string}>(`SELECT count(*)::text FROM deliveries d LEFT JOIN message_reader_data rd ON rd.delivery_id=d.id LEFT JOIN mail_message_state s ON s.message_id=d.id WHERE d.deleted_at IS NULL AND s.thread_id IS NULL AND (rd.delivery_id IS NULL OR rd.parser_version<2)`);console.log(JSON.stringify({indexed,awaitingReaderMetadata:waiting.rows[0]!.count}));}finally{await pool.end();}
