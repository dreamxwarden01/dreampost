import { parseArgs } from 'node:util';
import pg from 'pg';
import { scheduleAttachmentBackfill } from '../attachments/service.js';

const { values } = parseArgs({ options: { limit: { type: 'string', default: '100' } } });
if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 5000 });
try {
  const scheduled = await scheduleAttachmentBackfill(pool, { limit: Number(values.limit) });
  console.log(JSON.stringify({ scheduled, message: 'Attachment extraction scheduled. Run the extraction jobs to process it.' }));
} finally { await pool.end(); }
