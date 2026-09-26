import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { FileBlobStore } from '../blob-store.js';
import { runOneParseJob } from '../parser.js';

if (!process.env['DATABASE_URL'] || !process.env['MAIL_STORE_PATH']) throw new Error('DATABASE_URL and MAIL_STORE_PATH are required');
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 5000 });
const blobs = new FileBlobStore(process.env['MAIL_STORE_PATH']);
const once = process.argv.includes('--once');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
try {
  let processed = 0;
  while (!stopping) {
    const found = await runOneParseJob(pool, blobs);
    if (found) processed++;
    if (once && (!found || processed >= 100)) break;
    if (!found) await setTimeout(1000);
  }
  console.log('Parsing job runner stopped.');
} catch { console.error('Parsing job runner failed. Pending jobs remain in PostgreSQL.'); process.exitCode = 1; }
finally { await pool.end(); }
