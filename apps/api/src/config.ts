import { resolve } from 'node:path';

export interface ApiConfig {
  databaseUrl: string;
  mailStorePath: string;
  ingestKeys: Record<string, string>;
  devViewToken: string;
  devMailboxId: string;
  host: string;
  port: number;
  publicBaseUrl: string;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  function required(name: string): string {
    const value = env[name];
    if (!value) throw new Error(`Missing configuration: ${name}`);
    return value;
  }
  const databaseUrl = required('DATABASE_URL');
  let databaseProtocol: string;
  try { databaseProtocol = new URL(databaseUrl).protocol; }
  catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(databaseProtocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  const devViewToken = required('DEV_VIEW_TOKEN');
  if (devViewToken.length < 32) throw new Error('DEV_VIEW_TOKEN must contain at least 32 characters');
  const devMailboxId = required('DEV_MAILBOX_ID');
  if (!UUID.test(devMailboxId)) throw new Error('DEV_MAILBOX_ID must be a UUID');
  let parsed: unknown;
  try { parsed = JSON.parse(required('INGEST_KEYS_JSON')); }
  catch { throw new Error('INGEST_KEYS_JSON must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INGEST_KEYS_JSON must be a JSON object');
  }
  const ingestKeys: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, secret] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
      throw new Error('Every ingestion key requires a valid ID and a secret of at least 32 UTF-8 bytes');
    }
    ingestKeys[id] = secret;
  }
  if (!Object.keys(ingestKeys).length) throw new Error('At least one ingestion key is required');
  const publicBaseUrl = required('PUBLIC_BASE_URL');
  let publicUrl: URL;
  try { publicUrl = new URL(publicBaseUrl); }
  catch { throw new Error('PUBLIC_BASE_URL must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_BASE_URL must be an HTTP(S) URL without credentials');
  }
  const port = Number(env['PORT'] ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  return {
    databaseUrl, mailStorePath: resolve(required('MAIL_STORE_PATH')), ingestKeys,
    devViewToken, devMailboxId: devMailboxId.toLowerCase(), host: env['HOST'] ?? '127.0.0.1',
    port, publicBaseUrl,
  };
}
