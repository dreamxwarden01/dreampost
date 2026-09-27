export interface OutboundConfig {
  provider: 'disabled' | 'cloudflare'; enabled: boolean; accountId?: string; apiToken?: string;
  maxMessageBytes: number; maxRecipients: number; maxDrafts: number; maxAttachmentBytes: number; maxDraftStorageBytes: number;
  maxBodyBytes: number; maxQueueAgeSeconds: number; providerTimeoutMs: number; startDeadlineMs: number;
}
export function loadOutboundConfig(env: NodeJS.ProcessEnv, _mailStorePath?: string): OutboundConfig {
  const provider = env['OUTBOUND_PROVIDER'] ?? 'disabled';
  if (!['disabled','cloudflare'].includes(provider)) throw new Error('Invalid OUTBOUND_PROVIDER');
  function integer(name: string, fallback: number, minimum: number, maximum: number) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  }
  const accountId = env['OUTBOUND_CF_ACCOUNT_ID'], apiToken = env['OUTBOUND_CF_API_TOKEN'];
  if (provider === 'cloudflare' && (!accountId || !/^[0-9a-f]{32}$/i.test(accountId) || !apiToken || apiToken.length < 20 || /\s/.test(apiToken))) {
    throw new Error('Cloudflare outbound requires a separate account ID and Email Sending API token');
  }
  return { provider: provider as OutboundConfig['provider'], enabled: provider === 'cloudflare', ...(accountId ? { accountId } : {}), ...(apiToken ? { apiToken } : {}),
    maxMessageBytes: integer('OUTBOUND_MAX_MESSAGE_BYTES',5*1024*1024,1024,25*1024*1024),
    maxRecipients: integer('OUTBOUND_MAX_RECIPIENTS',50,1,1000), maxDrafts: integer('OUTBOUND_MAX_DRAFTS',100,1,1000),
    maxAttachmentBytes: integer('OUTBOUND_MAX_ATTACHMENT_BYTES',25*1024*1024,1,25*1024*1024),
    maxDraftStorageBytes: integer('OUTBOUND_MAX_DRAFT_STORAGE_BYTES',256*1024*1024,1024,1024*1024*1024),
    maxBodyBytes: integer('OUTBOUND_MAX_BODY_BYTES',1024*1024,1024,2*1024*1024),
    maxQueueAgeSeconds: integer('OUTBOUND_MAX_QUEUE_AGE_SECONDS',86400,60,7*86400),
    providerTimeoutMs: integer('OUTBOUND_PROVIDER_TIMEOUT_MS',15000,1000,30000), startDeadlineMs: integer('OUTBOUND_START_DEADLINE_MS',3000,100,5000) };
}
