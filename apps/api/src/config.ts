import { readFileSync } from 'node:fs';
import type { AuthConfig } from './auth/types.js';
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
  auth?: AuthConfig;
  addresses?: { defaultDomain: string; managedDomains: string[]; reservedLocalParts?: string[] };
  policySync?: { gatewayUrl: string; key: { id: string; secret: string } };
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
  const authMode = env['AUTH_MODE'] ?? 'development';
  if (!['development', 'sso'].includes(authMode)) throw new Error('AUTH_MODE must be development or sso');
  const devViewToken = authMode === 'sso' ? '' : required('DEV_VIEW_TOKEN');
  if (authMode === 'development' && devViewToken.length < 32) throw new Error('DEV_VIEW_TOKEN must contain at least 32 characters');
  const devMailboxId = authMode === 'sso' ? '' : required('DEV_MAILBOX_ID');
  if (authMode === 'development' && !UUID.test(devMailboxId)) throw new Error('DEV_MAILBOX_ID must be a UUID');
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
  let auth: AuthConfig | undefined;
  let addresses: ApiConfig['addresses'];
  let policySync: ApiConfig['policySync'];
  if (authMode === 'sso') {
    let privateJwk: unknown;
    try { privateJwk = JSON.parse(readFileSync(required('SSO_CLIENT_KEY_FILE'), 'utf8')); }
    catch { throw new Error('SSO_CLIENT_KEY_FILE must contain a private JWK'); }
    if (!privateJwk || typeof privateJwk !== 'object' || !('d' in privateJwk)) throw new Error('SSO client private key is missing');
    auth = {
      issuer: required('SSO_ISSUER'), clientId: required('SSO_CLIENT_ID'), publicBaseUrl,
      ...(env['SSO_CLIENT_NAME'] ? { clientName: env['SSO_CLIENT_NAME'] } : {}),
      clientPrivateJwk: privateJwk as AuthConfig['clientPrivateJwk'],
      ...(env['SSO_INTERNAL_BASE_URL'] ? { internalBaseUrl: env['SSO_INTERNAL_BASE_URL'] } : {}),
      ...(env['SSO_ACCOUNT_PORTAL_URL'] ? { accountPortalUrl: env['SSO_ACCOUNT_PORTAL_URL'] } : {}),
      allowInsecureLocal: env['SSO_ALLOW_INSECURE_LOCAL'] === 'true',
    };
    const managedDomains = required('MAIL_MANAGED_DOMAINS').split(',').map(domain => domain.trim().toLowerCase());
    const defaultDomain = required('MAIL_DEFAULT_DOMAIN').toLowerCase();
    if (!managedDomains.length || managedDomains.some(domain => !domain || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
      || !managedDomains.includes(defaultDomain)) throw new Error('Managed/default mail domains are invalid');
    addresses = { defaultDomain, managedDomains: [...new Set(managedDomains)], ...(env['MAIL_RESERVED_LOCAL_PARTS'] ? { reservedLocalParts: env['MAIL_RESERVED_LOCAL_PARTS'].split(',').map(value => value.trim().toLowerCase()).filter(Boolean) } : {}) };
  }
  if (env['POLICY_GATEWAY_URL']) {
    const url = new URL(env['POLICY_GATEWAY_URL']);
    const localHttp = env['ALLOW_INSECURE_LOCAL_GATEWAY'] === 'true' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.pathname !== '/internal/v1/recipient-policies' || url.search || url.hash) {
      throw new Error('Invalid policy gateway URL');
    }
    const id = required('POLICY_KEY_ID');
    const secret = required('POLICY_SECRET');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || Buffer.byteLength(secret) < 32) throw new Error('Invalid policy signing key');
    policySync = { gatewayUrl: url.href, key: { id, secret } };
  }
  const port = Number(env['PORT'] ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  return {
    databaseUrl, mailStorePath: resolve(required('MAIL_STORE_PATH')), ingestKeys,
    devViewToken, devMailboxId: devMailboxId.toLowerCase(), host: env['HOST'] ?? '127.0.0.1',
    port, publicBaseUrl, ...(auth ? { auth } : {}), ...(addresses ? { addresses } : {}), ...(policySync ? { policySync } : {}),
  };
}
