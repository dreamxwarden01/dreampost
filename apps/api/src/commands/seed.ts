import { parseArgs } from 'node:util';
import pg from 'pg';
import { seedMailbox } from '../database.js';
import { UUID } from '../config.js';

const { values } = parseArgs({ options: {
  id: { type: 'string' }, address: { type: 'string' }, name: { type: 'string' },
} });
values.id ??= process.env['DEV_MAILBOX_ID'];
values.address ??= process.env['DEV_MAILBOX_ADDRESS'];
values.name ??= process.env['DEV_MAILBOX_NAME'];
if (!values.id || !UUID.test(values.id) || !values.address || !/^[^\s<>@]+@[^\s<>@]+$/.test(values.address) || !values.name?.trim()) {
  throw new Error('Supply --id, --address, and --name, or explicit DEV_MAILBOX_ID/DEV_MAILBOX_ADDRESS/DEV_MAILBOX_NAME configuration');
}
if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 5000 });
try {
  await seedMailbox(pool, { id: values.id, address: values.address, name: values.name });
  console.log('Development mailbox and case-insensitive recipient route created.');
} catch { console.error('Mailbox seeding failed; existing IDs and addresses are never overwritten.'); process.exitCode = 1; }
finally { await pool.end(); }
