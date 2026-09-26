import { INGEST_PATH, normalizeRecipientAddress } from '@dreampost/protocol';

export interface GatewayConfig {
  routes: Record<string, string>;
  backendUrl: string;
  key: { id: string; secret: string };
  doneRetentionDays: number;
  routingMode: 'static' | 'dynamic';
  policyKeys: Record<string, string>;
  allowedPolicyDomains: string[];
  allowStaticPreload?: boolean;
  policyAllowedAddresses?: string[];
  operator?: { keys: Record<string, string>; allowedAddresses: string[]; gatewayId: string };
}

export interface GatewayVariables {
  RECIPIENT_ROUTES_JSON?: string;
  BACKEND_INGEST_URL: string;
  INGEST_KEY_ID: string;
  INGEST_SECRET: string;
  ALLOW_INSECURE_LOCAL_BACKEND?: string;
  DONE_RETENTION_DAYS?: string;
  ROUTING_MODE?: string;
  POLICY_KEYS_JSON?: string;
  POLICY_ALLOWED_DOMAINS_JSON?: string;
  POLICY_ALLOW_STATIC_PRELOAD?: string;
  POLICY_ALLOWED_ADDRESSES_JSON?: string;
  OPERATOR_KEYS_JSON?: string;
  OPERATOR_ALLOWED_ADDRESSES_JSON?: string;
  GATEWAY_ID?: string;
}

function configuredAddresses(value: string | undefined, required: boolean): string[] | undefined {
  if (value === undefined && !required) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? 'null'); } catch { throw new Error('Invalid address scope'); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(address => typeof address !== 'string'
    || !/^[^\s@*]+@[^\s@*]+$/.test(address))) throw new Error('A nonempty exact address scope is required');
  return [...new Set((parsed as string[]).map(normalizeRecipientAddress))];
}

export function readConfig(env: GatewayVariables): GatewayConfig {
  const routingMode = env.ROUTING_MODE ?? 'static';
  const allowStaticPreload = env.POLICY_ALLOW_STATIC_PRELOAD === 'true';
  if (env.POLICY_ALLOW_STATIC_PRELOAD !== undefined && !['true', 'false'].includes(env.POLICY_ALLOW_STATIC_PRELOAD)) {
    throw new Error('Invalid static preload setting');
  }
  const policyAllowedAddresses = configuredAddresses(env.POLICY_ALLOWED_ADDRESSES_JSON, allowStaticPreload);
  if (routingMode !== 'static' && routingMode !== 'dynamic') throw new Error('Invalid routing mode');
  let value: unknown;
  try {
    const encodedRoutes = env.RECIPIENT_ROUTES_JSON ?? (routingMode === 'dynamic' ? '{}' : '');
    value = JSON.parse(encodedRoutes);
  } catch { throw new Error('Invalid recipient configuration'); }
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
  const policyKeys: Record<string, string> = Object.create(null) as Record<string, string>;
  let allowedPolicyDomains: string[] = [];
  if (routingMode === 'dynamic' || allowStaticPreload) {
    let keys: unknown;
    let domains: unknown;
    try {
      keys = JSON.parse(env.POLICY_KEYS_JSON ?? 'null');
      domains = JSON.parse(env.POLICY_ALLOWED_DOMAINS_JSON ?? 'null');
    } catch { throw new Error('Invalid policy control configuration'); }
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length) {
      throw new Error('Policy control requires a separate key ring');
    }
    for (const [id, secret] of Object.entries(keys)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof secret !== 'string'
        || new TextEncoder().encode(secret).length < 32 || secret === env.INGEST_SECRET) {
        throw new Error('Invalid or reused policy signing key');
      }
      policyKeys[id] = secret;
    }
    if (!Array.isArray(domains) || !domains.length || domains.some(domain => typeof domain !== 'string'
      || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)
      || domain.includes('..') || domain.split('.').some((label: string) => label.length > 63 || label.startsWith('-') || label.endsWith('-')))) {
      throw new Error('Policy control requires explicit allowed domains');
    }
    allowedPolicyDomains = [...new Set((domains as string[]).map(domain => domain.toLowerCase()))];
  }
  if ((routingMode === 'dynamic' || allowStaticPreload) && policyAllowedAddresses?.some(address =>
    !allowedPolicyDomains.includes(address.slice(address.lastIndexOf('@') + 1)))) throw new Error('Policy address is outside the allowed domains');
  let operator: GatewayConfig['operator'];
  if (env.OPERATOR_KEYS_JSON !== undefined || env.OPERATOR_ALLOWED_ADDRESSES_JSON !== undefined || env.GATEWAY_ID !== undefined) {
    if (!env.GATEWAY_ID || !/^[A-Za-z0-9._-]{1,128}$/.test(env.GATEWAY_ID)) throw new Error('Invalid gateway identity');
    const allowedAddresses = configuredAddresses(env.OPERATOR_ALLOWED_ADDRESSES_JSON, true)!;
    let parsed: unknown;
    try { parsed = JSON.parse(env.OPERATOR_KEYS_JSON ?? 'null'); } catch { throw new Error('Invalid operator key ring'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new Error('Operator keys are required');
    let configuredPolicyKeys: unknown;
    try { configuredPolicyKeys = JSON.parse(env.POLICY_KEYS_JSON ?? '{}'); } catch { throw new Error('Invalid policy key ring'); }
    if (!configuredPolicyKeys || typeof configuredPolicyKeys !== 'object' || Array.isArray(configuredPolicyKeys)) throw new Error('Invalid policy key ring');
    const forbiddenSecrets = new Set([env.INGEST_SECRET, ...Object.values(configuredPolicyKeys).filter((value): value is string => typeof value === 'string')]);
    const keys: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [id, secret] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof secret !== 'string' || new TextEncoder().encode(secret).length < 32
        || forbiddenSecrets.has(secret)) throw new Error('Invalid or reused operator key');
      keys[id] = secret;
    }
    operator = { keys, allowedAddresses, gatewayId: env.GATEWAY_ID };
  }
  if (routingMode === 'dynamic' && operator && !policyAllowedAddresses?.length) {
    throw new Error('Operator-enabled dynamic routing requires an exact policy address scope');
  }
  return { routes, backendUrl: url.href, key: { id: env.INGEST_KEY_ID, secret: env.INGEST_SECRET },
    doneRetentionDays, routingMode, policyKeys, allowedPolicyDomains, allowStaticPreload,
    ...(policyAllowedAddresses ? { policyAllowedAddresses } : {}), ...(operator ? { operator } : {}) };
}
