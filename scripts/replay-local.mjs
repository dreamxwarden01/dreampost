import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDeliveryHeaders, INGEST_PATH, matchesAck, sha256Hex } from '../packages/protocol/dist/index.js';

const { values } = parseArgs({ options: { input: { type: 'string' }, 'delivery-id': { type: 'string' } } });
const raw = new Uint8Array(await readFile(values.input ?? 'fixtures/welcome.eml'));
const deliveryId = values['delivery-id'] ?? randomUUID();
if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new Error('Invalid delivery ID.');
const stateDir = resolve('.local/replays');
await mkdir(stateDir, { recursive: true });
const statePath = resolve(stateDir, `${deliveryId}.json`);
let metadata;
try { metadata = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  metadata = { version: 1, deliveryId, mailboxId: process.env.DEV_MAILBOX_ID,
    envelopeFrom: 'lab@example.test', envelopeTo: process.env.DEV_MAILBOX_ADDRESS,
    receivedAt: new Date().toISOString(), rawSize: raw.byteLength };
  await writeFile(statePath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const keys = JSON.parse(process.env.INGEST_KEYS_JSON ?? '{}');
const [entry] = Object.entries(keys);
if (!entry) throw new Error('No ingestion key is configured.');
const [id, secret] = entry;
const headers = await createDeliveryHeaders(metadata, raw, { id, secret });
const url = new URL(INGEST_PATH, process.env.API_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`);
const response = await fetch(url, { method: 'POST', headers, body: raw, redirect: 'error', signal: AbortSignal.timeout(30_000) });
const ack = await response.json();
if (response.status !== 200 || !matchesAck(ack, { deliveryId, sha256: await sha256Hex(raw) })) {
  throw new Error(`The backend did not acknowledge durable storage (HTTP ${response.status}).`);
}
console.log(JSON.stringify({ deliveryId, status: ack.status, sha256: ack.sha256 }));
