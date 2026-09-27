import { ApiError } from '../api';
import { clearSessionLocators, getSessionLocator, invalidateSessionLocator, saveSessionLocator, selectSessionNamespace, withSessionLock } from './session-cache';

export interface AttachmentConfig { downloadOrigin: string; previewOrigin: string; maxPreviewBytes: number }
export interface AttachmentItem {
  id: string; filename: string; sizeBytes: number; mimeType: string; sha256: string;
  deliveryKind: 'mime'; state: 'queued' | 'ready' | 'failed'; previewKind: 'pdf' | 'image' | null;
}
export interface AttachmentList { state: 'pending' | 'ready' | 'failed' | 'over_limit' | 'drift'; items: AttachmentItem[] }
export interface AttachmentAccess { sessionId: string; transferId: string; expiresAt: number; purpose: 'download' | 'preview'; url: string }
export interface MailAccess { mailboxId: string; messageId: string; token: string; csrfToken?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_PREVIEW_RANGE = 256 * 1024;
const invalid = (): never => { throw new ApiError('The attachment service returned an invalid response.'); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const text = (value: unknown, max = 2048): string => typeof value === 'string' && value.length <= max ? value : invalid();
const uuid = (value: unknown): string => typeof value === 'string' && UUID.test(value) ? value : invalid();
const integer = (value: unknown, min = 0): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : invalid();

export function parseAttachmentConfig(value: unknown, appOrigin: string): AttachmentConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const data = object(value); const app = new URL(appOrigin);
  function origin(value: unknown): URL {
    const url = new URL(text(value));
    const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
    const local = app.protocol === 'http:' && loopback(app.hostname) && url.protocol === 'http:' && loopback(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.origin !== value || url.username || url.password || url.search || url.hash) return invalid();
    return url;
  }
  const download = origin(data.downloadOrigin), preview = origin(data.previewOrigin);
  // Cookies ignore ports. A different port cannot isolate the document renderer's credentials.
  if (preview.hostname === app.hostname || preview.hostname === download.hostname || download.hostname === app.hostname) return invalid();
  const maxPreviewBytes = integer(data.maxPreviewBytes, 1);
  if (maxPreviewBytes > 64 * 1024 * 1024) return invalid();
  return { downloadOrigin: download.origin, previewOrigin: preview.origin, maxPreviewBytes };
}

export function parseAttachmentList(value: unknown): AttachmentList {
  const data = object(value);
  const states = ['pending', 'ready', 'failed', 'over_limit', 'drift'] as const;
  if (!states.includes(data.state as AttachmentList['state']) || !Array.isArray(data.items) || data.items.length > 100) return invalid();
  const ids = new Set<string>();
  const items = data.items.map(value => {
    const item = object(value); const id = uuid(item.id);
    if (ids.has(id)) return invalid(); ids.add(id);
    if (!['queued', 'ready', 'failed'].includes(String(item.state)) || item.deliveryKind !== 'mime'
      || ![null, 'pdf', 'image'].includes(item.previewKind as null | string) || !SHA256.test(text(item.sha256, 64))) return invalid();
    return { id, filename: text(item.filename), sizeBytes: integer(item.sizeBytes), mimeType: text(item.mimeType, 128), sha256: String(item.sha256),
      deliveryKind: 'mime' as const, state: item.state as AttachmentItem['state'], previewKind: item.previewKind as AttachmentItem['previewKind'] };
  });
  return { state: data.state as AttachmentList['state'], items };
}

async function checkedFetch(url: string, options: RequestInit): Promise<Response> {
  let response: Response;
  options.signal?.throwIfAborted();
  try { response = await fetch(url, options); options.signal?.throwIfAborted(); }
  catch (error) { if (options.signal?.aborted) throw error; throw new ApiError('Cannot reach the attachment service. Try again.'); }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ApiError('Attachment access expired or changed. Close this preview and try again.', response.status);
    if (response.status === 429) throw new ApiError('Too many active attachment requests. Wait a moment and try again.', 429);
    throw new ApiError('The attachment is not available right now. Refresh the message and try again.', response.status);
  }
  return response;
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try { return object(await response.json()); } catch { return invalid(); }
}
const path = (access: MailAccess) => `/api/mailboxes/${encodeURIComponent(access.mailboxId)}/messages/${encodeURIComponent(access.messageId)}/attachments`;
const headers = (access: MailAccess, mutating = false): Record<string, string> => ({ Accept: 'application/json',
  ...(access.token ? { Authorization: `Bearer ${access.token}` } : {}),
  ...(mutating ? { 'Content-Type': 'application/json', ...(access.csrfToken ? { 'X-CSRF-Token': access.csrfToken } : {}) } : {}),
});

export async function getAttachments(access: MailAccess, signal: AbortSignal): Promise<AttachmentList> {
  return parseAttachmentList(await json(await checkedFetch(path(access), { signal, headers: headers(access), credentials: access.token ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error' })));
}

const accessNamespaces = new WeakMap<AttachmentAccess, string>();
export const clearAttachmentAccessCache = clearSessionLocators;
function parsedAccess(result: Record<string, unknown>, config: AttachmentConfig, purpose: AttachmentAccess['purpose']): AttachmentAccess {
  const sessionId = uuid(result.sessionId), transferId = uuid(result.transferId), expiresAt = integer(result.expiresAt, 1);
  if (result.purpose !== purpose || expiresAt <= Date.now()) return invalid();
  const url = `${config.downloadOrigin}/sessions/${sessionId}/transfers/${transferId}`;
  if (result.url !== url) return invalid();
  return { sessionId, transferId, expiresAt, purpose, url };
}
async function verifyAttachmentHead(config: AttachmentConfig, namespace: string, session: AttachmentAccess, attachment: AttachmentItem, signal: AbortSignal): Promise<AttachmentAccess> {
  try {
    const response = await checkedFetch(session.url, { method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'error', signal,
      headers: { 'If-Match': `"sha256-${attachment.sha256}"` } });
    const expiryHeader = response.headers.get('x-dreampost-session-expires-at');
    const expiresAt = expiryHeader && /^[0-9]{10,16}$/.test(expiryHeader) ? Number(expiryHeader) : Number.NaN;
    if (response.status !== 200 || response.headers.get('etag') !== `"sha256-${attachment.sha256}"`
      || response.headers.get('content-length') !== String(attachment.sizeBytes) || response.headers.has('content-range')
      || ![null, 'identity'].includes(response.headers.get('content-encoding'))
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return invalid();
    const result = { ...session, expiresAt };
    accessNamespaces.set(result, namespace);
    return result;
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status ?? 0)) invalidateSessionLocator(namespace, session.purpose, session.sessionId);
    throw error;
  }
}
export async function prepareAttachmentAccess(config: AttachmentConfig, access: MailAccess, attachment: AttachmentItem, purpose: AttachmentAccess['purpose'], callerSignal: AbortSignal): Promise<AttachmentAccess> {
  if (!access.token && !access.csrfToken) throw new ApiError('Your session needs to be refreshed before opening attachments.');
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(45_000)]);
  const namespace = await selectSessionNamespace(config.downloadOrigin, `${access.token ? 'development' : 'sso'}:${access.token || access.csrfToken}`, signal);
  return withSessionLock(namespace, purpose, signal, async () => {
    const backendPost = async (suffix: string, body: unknown) => json(await checkedFetch(`${path(access)}/${encodeURIComponent(attachment.id)}${suffix}`, {
      method: 'POST', headers: headers(access, true), credentials: access.token ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error', signal,
      body: JSON.stringify(body),
    }));
    const existing = getSessionLocator(namespace, purpose);
    if (existing) {
      try {
        const result = parsedAccess(await backendPost('/transfers', { sessionId: existing.sessionId, purpose }), config, purpose);
        if (result.sessionId !== existing.sessionId) return invalid();
        const verified = await verifyAttachmentHead(config, namespace, result, attachment, signal);
        signal.throwIfAborted(); saveSessionLocator(namespace, verified); return verified;
      } catch (error) {
        if (signal.aborted || !(error instanceof ApiError) || ![401, 409].includes(error.status ?? 0)) throw error;
        invalidateSessionLocator(namespace, purpose, existing.sessionId);
      }
    }
    const flowId = crypto.randomUUID();
    const workerPost = async (route: string, body: unknown) => json(await checkedFetch(`${config.downloadOrigin}${route}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include', cache: 'no-store', redirect: 'error', signal,
    }));
    const challenge = await workerPost('/bootstrap/challenge', { flowId });
    if (challenge.flowId !== flowId || !SHA256.test(text(challenge.challengeHash, 64))) return invalid();
    const grant = await backendPost('/sessions', { flowId, challengeHash: challenge.challengeHash, purpose });
    const ticket = text(grant.ticket, 16_384); if (!ticket) return invalid();
    const result = parsedAccess(await workerPost('/bootstrap/redeem', { flowId, ticket }), config, purpose);
    const verified = await verifyAttachmentHead(config, namespace, result, attachment, signal);
    signal.throwIfAborted(); saveSessionLocator(namespace, verified); return verified;
  });
}

export async function readAttachmentRange(config: AttachmentConfig, session: AttachmentAccess, attachment: AttachmentItem, begin: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
  if (session.purpose !== 'preview' || session.url !== `${config.downloadOrigin}/sessions/${session.sessionId}/transfers/${session.transferId}`
    || !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > attachment.sizeBytes || end - begin > MAX_PREVIEW_RANGE) return invalid();
  const etag = `"sha256-${attachment.sha256}"`;
  let response: Response;
  try {
    response = await checkedFetch(session.url, { signal, credentials: 'include', redirect: 'error', cache: 'default',
      headers: { Range: `bytes=${begin}-${end - 1}`, 'If-Range': etag } });
  } catch (error) {
    const namespace = accessNamespaces.get(session);
    if (namespace && error instanceof ApiError && [401, 403].includes(error.status ?? 0)) invalidateSessionLocator(namespace, session.purpose, session.sessionId);
    throw error;
  }
  if (response.status !== 206 || response.headers.get('etag') !== etag
    || response.headers.get('content-range') !== `bytes ${begin}-${end - 1}/${attachment.sizeBytes}`
    || response.headers.get('content-length') !== String(end - begin)
    || ![null, 'identity'].includes(response.headers.get('content-encoding'))) return invalid();
  if (!response.body) return invalid();
  const reader = response.body.getReader(); const bytes = new Uint8Array(end - begin); let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (offset + chunk.value.length > bytes.length) return invalid();
      bytes.set(chunk.value, offset); offset += chunk.value.length;
    }
    if (offset !== bytes.length) return invalid();
    return bytes.buffer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
