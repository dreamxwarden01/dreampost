export interface Mailbox {
  id: string;
  address: string;
  name: string;
}

export interface MessageSummary {
  id: string;
  subject: string;
  from: string;
  to: string;
  receivedAt: string;
  preview: string;
  status: string;
  sizeBytes: number;
}

export interface MessageDetail extends Omit<MessageSummary, 'preview'> {
  text: string;
  reader: {
    hasHtml: boolean;
    contentVersion: string;
    replyTo: string;
    cc: string;
    sentAt: string | null;
    envelopeFrom: string;
    envelopeTo: string;
  };
}

export interface RenderedMessage {
  html: string;
  remoteImageCount: number;
  warnings: string[];
}

export interface ReadingPreferences {
  autoLoadExternalImages: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function invalidResponse(): never {
  throw new ApiError('The server returned an invalid response. Try refreshing.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string') return invalidResponse();
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidResponse();
  return value;
}

function messageFields(value: unknown): Omit<MessageSummary, 'preview'> {
  const item = record(value);
  if (typeof item.sizeBytes !== 'number' || !Number.isFinite(item.sizeBytes) || item.sizeBytes < 0) {
    return invalidResponse();
  }
  return {
    id: string(item.id),
    subject: string(item.subject),
    from: string(item.from),
    to: string(item.to),
    receivedAt: string(item.receivedAt),
    status: string(item.status),
    sizeBytes: item.sizeBytes,
  };
}

async function request(path: string, token: string, signal: AbortSignal, accept = 'application/json'): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: accept },
      credentials: token ? 'omit' : 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError('Cannot reach the local mail service. Check the API and development proxy, then try again.');
  }
  if (response.ok) return response;
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(token ? 'The development view token was rejected. Enter a valid token to reconnect.' : 'Your session expired or access changed. Sign in again.', response.status);
  }
  if (response.status === 404) {
    throw new ApiError('This mailbox or message is no longer available. Refresh the inbox.', 404);
  }
  if (response.status === 429) {
    throw new ApiError('The service is receiving too many requests. Wait a moment, then try again.', 429);
  }
  throw new ApiError('The local mail service could not complete the request. Try again shortly.', response.status);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    return invalidResponse();
  }
}

export async function getMailbox(token: string, signal: AbortSignal): Promise<Mailbox> {
  const data = await json(await request('/api/mailboxes', token, signal));
  const mailboxes = list(data.mailboxes);
  if (mailboxes.length !== 1) {
    throw new ApiError('The development API must expose exactly one configured mailbox. Check the API configuration.');
  }
  const item = record(mailboxes[0]);
  return { id: string(item.id), address: string(item.address), name: string(item.name) };
}

function mailboxPath(mailboxId: string): string {
  return `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages`;
}

export async function getMessages(mailboxId: string, token: string, signal: AbortSignal): Promise<MessageSummary[]> {
  const data = await json(await request(mailboxPath(mailboxId), token, signal));
  return list(data.messages).map((value) => ({ ...messageFields(value), preview: string(record(value).preview) }));
}

export async function getMessage(mailboxId: string, messageId: string, token: string, signal: AbortSignal): Promise<MessageDetail> {
  const path = `${mailboxPath(mailboxId)}/${encodeURIComponent(messageId)}`;
  const data = await json(await request(path, token, signal));
  const detail = record(data.message);
  const reader = record(detail.reader);
  if (typeof reader.hasHtml !== 'boolean' || (reader.sentAt !== null && typeof reader.sentAt !== 'string')) return invalidResponse();
  const message: MessageDetail = {
    ...messageFields(data.message), text: string(detail.text),
    reader: {
      hasHtml: reader.hasHtml, contentVersion: string(reader.contentVersion), replyTo: string(reader.replyTo), cc: string(reader.cc),
      sentAt: reader.sentAt, envelopeFrom: string(reader.envelopeFrom), envelopeTo: string(reader.envelopeTo),
    },
  };
  if (message.id !== messageId) return invalidResponse();
  return message;
}

export async function getRawMessage(mailboxId: string, messageId: string, token: string, signal: AbortSignal): Promise<Blob> {
  const path = `${mailboxPath(mailboxId)}/${encodeURIComponent(messageId)}/raw`;
  const response = await request(path, token, signal, 'message/rfc822');
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'message/rfc822') {
    return invalidResponse();
  }
  return response.blob();
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The request could not be completed. Please try again.';
}

export async function getMailboxes(signal: AbortSignal): Promise<Mailbox[]> {
  const data = await json(await request('/api/mailboxes', '', signal));
  return list(data.mailboxes).map(value => {
    const item = record(value);
    return { id: string(item.id), address: string(item.address), name: string(item.name) };
  });
}

export async function sessionRequest<T>(path: string, options: { method?: string; body?: unknown; csrfToken?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal,
    headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    const code = failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string' ? failure.error : '';
    const messages: Record<string, string> = {
      address_taken: 'That address is already allocated. Choose another address.',
      address_unavailable: 'That address is unavailable. Choose another address.',
      forbidden: 'You do not have permission for this action.',
      invalid_address: 'Enter a valid address in a managed domain.',
      legacy_route_cutover_required: 'This address still uses the legacy gateway. Complete its gateway migration before changing it.',
      reserved_address: 'This address is reserved for administrator assignment.',
      unmanaged_address_domain: 'Choose an address in a managed mail domain.',
      permission_denied: 'You do not have permission for this action.',
      request_not_pending: 'This request was already processed. Refresh the list.',
    };
    if (response.status === 401) throw new ApiError('Your session expired. Sign in again.', 401);
    throw new ApiError(messages[code] ?? 'The action could not be completed. Refresh and try again.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function getRenderedMessage(mailboxId: string, messageId: string, token: string, remoteImages: 'blocked' | 'allowed', signal: AbortSignal): Promise<RenderedMessage> {
  const path = `${mailboxPath(mailboxId)}/${encodeURIComponent(messageId)}/render?remoteImages=${remoteImages}`;
  const data = await json(await request(path, token, signal));
  if (typeof data.remoteImageCount !== 'number' || !Number.isSafeInteger(data.remoteImageCount) || data.remoteImageCount < 0) return invalidResponse();
  return { html: string(data.html), remoteImageCount: data.remoteImageCount, warnings: list(data.warnings).map(string) };
}

function readingPreferences(value: unknown): ReadingPreferences {
  const data = record(value);
  if (typeof data.autoLoadExternalImages !== 'boolean') return invalidResponse();
  return { autoLoadExternalImages: data.autoLoadExternalImages };
}

export async function getReadingPreferences(signal: AbortSignal): Promise<ReadingPreferences> {
  return readingPreferences(await sessionRequest<unknown>('/api/preferences', { signal }));
}

export async function updateReadingPreferences(preferences: ReadingPreferences, csrfToken: string, signal: AbortSignal): Promise<ReadingPreferences> {
  return readingPreferences(await sessionRequest<unknown>('/api/preferences', {
    method: 'PATCH', body: preferences, csrfToken, signal,
  }));
}
