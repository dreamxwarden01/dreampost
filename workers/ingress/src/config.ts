import { INGEST_PATH, normalizeRecipientAddress } from '@dreampost/protocol';

export interface GatewayConfig {
  routes: Record<string, string>;
  backendUrl: string;
  key: { id: string; secret: string };
  doneRetentionDays: number;
}

export interface GatewayVariables {
  RECIPIENT_ROUTES_JSON: string;
  BACKEND_INGEST_URL: string;
  INGEST_KEY_ID: string;
  INGEST_SECRET: string;
  ALLOW_INSECURE_LOCAL_BACKEND?: string;
  DONE_RETENTION_DAYS?: string;
}

export function readConfig(env: GatewayVariables): GatewayConfig {
  let value: unknown;
  try { value = JSON.parse(env.RECIPIENT_ROUTES_JSON); } catch { throw new Error('Invalid recipient configuration'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recipient configuration');
  const routes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [address, mailbox] of Object.entries(value)) {
    if (!/^[^\s@*]+@[^\s@*]+$/.test(address) || typeof mailbox !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mailbox)) {
      throw new Error('Invalid recipient configuration');
    }
    const normalized = normalizeRecipientAddress(address);
    const normalizedMailbox = mailbox.toLowerCase();
    if (Object.hasOwn(routes, normalized) && routes[normalized] !== normalizedMailbox) {
      throw new Error('Conflicting recipient configuration');
    }
    routes[normalized] = normalizedMailbox;
  }
  const url = new URL(env.BACKEND_INGEST_URL);
  const localHttp = env.ALLOW_INSECURE_LOCAL_BACKEND === 'true'
    && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password
    || url.pathname !== INGEST_PATH || url.search || url.hash) throw new Error('Invalid backend URL');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(env.INGEST_KEY_ID) || !env.INGEST_SECRET || new TextEncoder().encode(env.INGEST_SECRET).length < 32) {
    throw new Error('Missing or invalid ingest signing key');
  }
  const retention = env.DONE_RETENTION_DAYS ?? '7';
  const doneRetentionDays = Number(retention);
  if (!/^\d+$/.test(retention) || !Number.isSafeInteger(doneRetentionDays) || doneRetentionDays < 1 || doneRetentionDays > 3650) {
    throw new Error('DONE_RETENTION_DAYS must be an integer between 1 and 3650');
  }
  return { routes, backendUrl: url.href, key: { id: env.INGEST_KEY_ID, secret: env.INGEST_SECRET }, doneRetentionDays };
}
