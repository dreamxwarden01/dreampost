import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const directory = resolve(root, '.local');
await mkdir(directory, { recursive: true });
const password = randomBytes(24).toString('hex');
const ingestSecret = randomBytes(32).toString('hex');
const viewToken = randomBytes(32).toString('hex');
const address = process.argv[2] ?? 'inbox@example.test';
if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(address)) {
  throw new Error('Supply a simple test mailbox address.');
}
const lines = [
  `POSTGRES_PASSWORD=${password}`,
  'POSTGRES_PORT=54329',
  'REDIS_PORT=16379',
  `DATABASE_URL=postgresql://dreampost:${password}@127.0.0.1:54329/dreampost`,
  `TEST_DATABASE_URL=postgresql://dreampost:${password}@127.0.0.1:54329/dreampost`,
  'REDIS_URL=redis://127.0.0.1:16379',
  'HOST=127.0.0.1',
  'PORT=3001',
  'PUBLIC_BASE_URL=http://localhost:5173',
  `MAIL_STORE_PATH=${JSON.stringify(resolve(directory, 'mail').replaceAll('\\', '/'))}`,
  `INGEST_KEYS_JSON='${JSON.stringify({ 'local-1': ingestSecret })}'`,
  `DEV_VIEW_TOKEN=${viewToken}`,
  'DEV_MAILBOX_ID=33333333-3333-4333-8333-333333333333',
  `DEV_MAILBOX_ADDRESS=${address}`,
  'DEV_MAILBOX_NAME="Development inbox"',
];
await writeFile(resolve(directory, 'dev.env'), lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created .local/dev.env with development-only secrets. Existing files are never overwritten.');
console.log('Keep this file private. The development inbox token is DEV_VIEW_TOKEN.');
