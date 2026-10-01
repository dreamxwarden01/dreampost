import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { FileBlobStore } from '../blob-store.js';
import { backfillMailContentFingerprints } from '../mail/fingerprint-backfill.js';
const {values} = parseArgs({options:{limit:{type:'string'},'after-delivery-id':{type:'string'},mailbox:{type:'string'}}});
const config=loadConfig(),pool=new pg.Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000});
try {
  const result=await backfillMailContentFingerprints(pool,new FileBlobStore(config.mailStorePath),{
    limit:values.limit===undefined?100:Number(values.limit),afterDeliveryId:values['after-delivery-id'],mailboxId:values.mailbox});
  console.log(JSON.stringify(result));
  if(result.failures.length)process.exitCode=1;
} catch { console.error('Mail copy backfill failed. Existing committed evidence is retained; original mail was not changed.');process.exitCode=1; }
finally { await pool.end(); }
