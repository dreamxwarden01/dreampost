import { loadEnvFile } from 'node:process';
import { writeFile } from 'node:fs/promises';
loadEnvFile('.local/dev.env');
const [entry] = Object.entries(JSON.parse(process.env.INGEST_KEYS_JSON ?? '{}'));
if (!entry || !process.env.DEV_MAILBOX_ADDRESS || !process.env.DEV_MAILBOX_ID) throw new Error('Run local environment setup first.');
const [id, secret] = entry;
const vars = [
  `RECIPIENT_ROUTES_JSON='${JSON.stringify({ [process.env.DEV_MAILBOX_ADDRESS]: process.env.DEV_MAILBOX_ID })}'`,
  `BACKEND_INGEST_URL="http://127.0.0.1:${process.env.PORT ?? '3001'}/internal/v1/deliveries"`,
  `INGEST_KEY_ID="${id}"`, `INGEST_SECRET="${secret}"`, 'ALLOW_INSECURE_LOCAL_BACKEND="true"',
];
await writeFile('workers/ingress/.dev.vars', vars.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created local Worker variables without displaying secrets.');
