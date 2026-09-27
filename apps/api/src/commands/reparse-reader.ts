import { parseArgs } from 'node:util';
import pg from 'pg';
import { scheduleReaderReparse } from '../reader-data.js';

const { values } = parseArgs({ options: { limit: { type: 'string', default: '100' } } });
if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 5000 });
try {
  const scheduled = await scheduleReaderReparse(pool, { limit: Number(values.limit) });
  console.log(JSON.stringify({ scheduled, message: 'Reader reparsing scheduled. Run the parsing jobs to process it.' }));
} finally { await pool.end(); }
