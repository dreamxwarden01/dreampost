import { ApiError } from '../api';

export type Folder = 'inbox' | 'archive' | 'trash' | 'spam' | 'sent' | 'all';
export interface MailAddress { name: string; address: string }
export interface MailState { id: string; threadId: string | null; read: boolean; starred: boolean; folder: 'inbox' | 'archive' | 'trash' | 'spam'; labelIds: string[]; version: string }
export interface MailCopy extends Omit<MailState, 'threadId'> { direction: 'inbound' | 'outbound' }
export interface MailMessage extends MailState { copyGroupId: string; copies: MailCopy[]; subject: string; from: string; to: string; receivedAt: string; preview: string; status: string; sizeBytes: number; direction: 'inbound' | 'outbound' }
export interface MailThread { id: string; subject: string; preview: string; receivedAt: string; from: string; to: string; messageCount: number; matchedCount: number; unreadCount: number; starred: boolean; lastMessageId: string }
export interface Capabilities { canSetPersonalFlags: boolean; canManageMessages: boolean; canManageLabels: boolean }
export interface MailPage { view: 'messages' | 'threads'; messages: MailMessage[]; threads: MailThread[]; nextCursor: string | null; changeSequence: string; capabilities: Capabilities }
export interface MailLabel { id: string; name: string; color: string | null; version: string }
export interface MutationResult { operationId: string; messages: MailState[]; changeSequence: string; undoUntil: string | null }
export interface MessageMutation { operationId: string; items: Array<{ id: string; version: string }>; set?: { read?: boolean; starred?: boolean; folder?: MailState['folder'] }; addLabelIds?: string[]; removeLabelIds?: string[] }
export class MailApiError extends ApiError {
  constructor(message: string, status?: number, readonly code = '', readonly retryAfterMs?: number) { super(message, status); }
}
/** Retry-After is a minimum delay, not a reason to change a mutation's idempotency key. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value || value.length > 256) return undefined;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) { const delay = Number(normalized) * 1000; return Number.isSafeInteger(delay) && delay <= Number.MAX_SAFE_INTEGER - now ? delay : undefined; }
  const date = Date.parse(normalized); return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export const boxPath = (id: string) => `/api/mailboxes/${encodeURIComponent(id)}`;
export const mutationKey = () => crypto.randomUUID();
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MailApiError('The mail service returned an invalid response.'); return value as Record<string, unknown>; }
export function text(value: unknown): string { if (typeof value !== 'string') throw new MailApiError('The mail service returned an invalid response.'); return value; }
export function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new MailApiError('The mail service returned an invalid response.'); return value; }
export function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new MailApiError('The mail service returned an invalid response.'); return value; }
export function count(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MailApiError('The mail service returned an invalid response.'); return value as number; }
export function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
export function addresses(value: unknown): MailAddress[] { return array(value).map(raw => { const item = object(raw); return { name: text(item.name), address: text(item.address) }; }); }
const errors: Record<string, string> = {
  mutation_replayed_draft_changed: 'The previous save succeeded, but this draft changed again elsewhere. Your local edits are preserved; review the latest version or save a separate copy.',
  draft_version_conflict: 'This draft changed in another tab. Your edits are preserved. Review the latest version or save a separate copy.',
  version_conflict: 'This item changed since it was loaded. Refresh and try again.',
  message_version_conflict: 'A selected message changed. Refresh before applying this action.',
  undo_conflict: 'These messages changed after that action, so it cannot be undone safely.',
  undo_expired: 'The undo window has expired.',
  sending_disabled: 'Sending is not configured yet. Your draft can still be saved.',
  outbound_disabled: 'Sending is not configured yet. Your draft can still be saved.',
  invalid_subject: 'The subject contains unsupported characters or exceeds the 998-byte limit. Shorten or correct it; your text is still here.',
  invalid_body_text: 'The message text exceeds the configured limit or contains an unsupported character. Your edits are still here.',
  invalid_recipient_name: 'A recipient display name is too long or contains unsupported characters. Remove that recipient and enter the corrected address or name.',
  invalid_recipient_address_field: 'A recipient address is too long or contains unsupported control characters. Remove that recipient and enter the corrected address or name.',
  invalid_recipients: 'Check the recipient addresses before sending.',
  invalid_recipient_address: 'Check each recipient address before sending.',
  recipient_required: 'Add at least one valid recipient before sending.',
  sender_selection_required: 'Choose an eligible From address before sending.',
  outbound_not_configured: 'Sending is not configured yet. Your draft can still be saved.',
  too_many_recipients: 'This message exceeds the configured recipient limit. Remove recipients; DreamPost will not split the send silently.',
  draft_limit: 'You have reached the active draft limit. Remove an unneeded draft before creating another.',
  draft_storage_limit: 'Draft attachment storage is full. Remove unneeded draft attachments before uploading more.',
  draft_attachment_limit: 'This draft has reached its attachment limit. Remove a file before adding another.',
  source_preparing: 'The original message is still being prepared. Refresh it and try creating the reply or forward again; no incomplete draft was submitted.',
  source_attachments_preparing: 'The original attachments are still being prepared. Refresh the message before forwarding.',
  source_message_changed: 'The original message changed or is unavailable. Your existing draft has not been overwritten.',
  source_attachment_changed: 'An original attachment changed or is unavailable. No incomplete forward was created.',
  duplicate_confirmation_required: 'Review the duplicate-delivery warning before sending this separate draft.',
  draft_is_submitted: 'This draft was already submitted. Open Outbox to see its status or edit a separate copy.',
  submission_cannot_cancel: 'This send is no longer queued and cannot be cancelled. Refresh its status.',
  message_too_large: 'The complete message exceeds the sending limit. Remove an attachment or shorten the message. Your draft is preserved.',
  attachment_too_large: 'This attachment exceeds the current limit. No public sharing link was created.',
  reply_all_confirmation_required: 'You were not a visible To/Cc recipient. Review Reply all recipients and acknowledge the warning.',
  sender_not_eligible: 'This From address is no longer eligible. Choose an authorized address.',
};
export async function mailRequest(path: string, options: { method?: string; body?: unknown; csrf?: string; signal?: AbortSignal; bytes?: File; version?: number; key?: string; background?: boolean } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal,
      headers: { Accept: 'application/json', ...(options.background ? { 'X-DreamPost-Background': '1' } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
        ...(options.bytes ? { 'Content-Type': 'application/octet-stream', 'X-Draft-Version': String(options.version), 'X-Attachment-Filename': encodeURIComponent(options.bytes.name), 'X-Mutation-Key': options.key! } : options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.bytes ? { body: options.bytes } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  } catch (failure) { if (options.signal?.aborted) throw failure; throw new MailApiError('Cannot reach the mail service. Your unsaved changes are still here.'); }
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null);
    const code = detail && typeof detail === 'object' && 'error' in detail && typeof detail.error === 'string' ? detail.error : '';
    const message = response.status === 401 ? 'Your session expired. Sign in in another tab, then retry. Your unsaved changes are still here.'
      : response.status === 403 ? 'Your access changed or this action is not permitted. Your unsaved changes are still here.'
      : response.status === 409 ? errors[code] ?? 'This item changed elsewhere. Refresh it before trying again; your edits have not been discarded.'
      : response.status === 413 ? errors[code] ?? 'The message or attachment exceeds the current size limit. Your draft is preserved.'
      : response.status === 429 ? errors[code] ?? 'Too many requests. Wait a moment, then retry.'
      : errors[code] ?? 'The mail service could not complete this action. Try again.';
    throw new MailApiError(message, response.status, code, parseRetryAfter(response.headers.get('retry-after')));
  }
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw new MailApiError('The mail service returned an invalid response.'); }
}
export function decodeState(raw: unknown): MailState {
  const i = object(raw); const folder = text(i.folder);
  if (!['inbox', 'archive', 'trash', 'spam'].includes(folder)) throw new MailApiError('Invalid message folder.');
  return { id: text(i.id), threadId: nullableText(i.threadId), read: bool(i.read), starred: bool(i.starred), folder: folder as MailState['folder'], labelIds: array(i.labelIds).map(text), version: text(i.version) };
}
export function decodeMessage(raw: unknown): MailMessage {
  const i = object(raw); const direction = text(i.direction); if (!['inbound', 'outbound'].includes(direction)) throw new MailApiError('Invalid message direction.');
  const state = decodeState(i);
  // An older running API has no copy relation; preserve it as a singleton during rollout.
  // Partial metadata is still invalid, and this fallback never asserts equivalence.
  const legacy = i.copyGroupId === undefined && i.copies === undefined;
  const copyValues = legacy ? [{ ...state, direction }] : i.copies;
  const copies = array(copyValues).map(rawCopy => {
    const copy = object(rawCopy), copyDirection = text(copy.direction);
    if (!['inbound', 'outbound'].includes(copyDirection)) throw new MailApiError('Invalid stored copy direction.');
    const { threadId: _threadId, ...copyState } = decodeState({ ...copy, threadId: null });
    return { ...copyState, direction: copyDirection as MailCopy['direction'] };
  });
  if (!copies.length || new Set(copies.map(copy => copy.id)).size !== copies.length || !copies.some(copy => copy.id === state.id && copy.version === state.version)) throw new MailApiError('Invalid stored copy metadata.');
  return { ...state, copyGroupId: legacy ? state.id : text(i.copyGroupId), copies, subject: text(i.subject), from: text(i.from), to: text(i.to), receivedAt: text(i.receivedAt), preview: text(i.preview), status: text(i.status), sizeBytes: count(i.sizeBytes), direction: direction as MailMessage['direction'] };
}
export function decodeCapabilities(raw: unknown): Capabilities {
  const i = object(raw); return { canSetPersonalFlags: bool(i.canSetPersonalFlags), canManageMessages: bool(i.canManageMessages), canManageLabels: bool(i.canManageLabels) };
}
export function decodePage(raw: unknown): MailPage {
  const i = object(raw); const view = i.view ?? 'messages'; if (view !== 'messages' && view !== 'threads') throw new MailApiError('Invalid mail view.');
  return { view, messages: array(i.messages ?? []).map(decodeMessage), threads: array(i.threads ?? []).map(raw => { const t = object(raw); return { id: text(t.id), subject: text(t.subject), preview: text(t.preview), receivedAt: text(t.receivedAt), from: text(t.from), to: text(t.to), messageCount: count(t.messageCount), matchedCount: count(t.matchedCount), unreadCount: count(t.unreadCount), starred: bool(t.starred), lastMessageId: text(t.lastMessageId) }; }), nextCursor: nullableText(i.nextCursor), changeSequence: text(i.changeSequence), capabilities: decodeCapabilities(i.capabilities) };
}
export interface MailQuery { folder: Folder; view: 'messages' | 'threads'; q?: string; unread?: boolean; starred?: boolean; labelId?: string }
export async function loadMail(mailboxId: string, query: MailQuery, cursor: string | null, signal: AbortSignal, background = false): Promise<MailPage> {
  const params = new URLSearchParams({ folder: query.folder, view: query.view, limit: '50', groupCopies: 'true' });
  if (query.q) params.set('q', query.q); if (query.unread) params.set('unread', 'true'); if (query.starred) params.set('starred', 'true'); if (query.labelId) params.set('labelId', query.labelId); if (cursor) params.set('cursor', cursor);
  return decodePage(await mailRequest(`${boxPath(mailboxId)}/messages?${params}`, { signal, background }));
}
export async function loadThread(mailboxId: string, threadId: string, folder: Folder, cursor: string | null, signal: AbortSignal, background = false): Promise<MailPage> {
  const params = new URLSearchParams({ limit: '50', folder: folder === 'trash' || folder === 'spam' ? folder : 'all', groupCopies: 'true' }); if (cursor) params.set('cursor', cursor);
  return decodePage(await mailRequest(`${boxPath(mailboxId)}/threads/${encodeURIComponent(threadId)}?${params}`, { signal, background }));
}
export function decodeMutation(raw: unknown): MutationResult { const i = object(raw); return { operationId: text(i.operationId), messages: array(i.messages).map(decodeState), changeSequence: text(i.changeSequence), undoUntil: nullableText(i.undoUntil) }; }
export async function mutateMessages(box: string, body: MessageMutation, csrf: string): Promise<MutationResult> { return decodeMutation(await mailRequest(`${boxPath(box)}/messages/mutate`, { method: 'POST', body, csrf })); }
export async function undoMessages(box: string, id: string, csrf: string): Promise<MutationResult> { return decodeMutation(await mailRequest(`${boxPath(box)}/operations/${encodeURIComponent(id)}/undo`, { method: 'POST', body: {}, csrf })); }
export function decodeLabel(raw: unknown): MailLabel { const i = object(raw); return { id: text(i.id), name: text(i.name), color: nullableText(i.color), version: text(i.version) }; }
export async function loadLabels(box: string, signal: AbortSignal, background = false): Promise<{ labels: MailLabel[]; capabilities: Capabilities }> { const i = object(await mailRequest(`${boxPath(box)}/labels`, { signal, background })); return { labels: array(i.labels).map(decodeLabel), capabilities: decodeCapabilities(i.capabilities) }; }
export async function changeLabel(box: string, csrf: string, action: 'POST' | 'PATCH' | 'DELETE', body: { name?: string; color?: string | null }, label?: MailLabel): Promise<void> {
  await mailRequest(`${boxPath(box)}/labels${label ? `/${encodeURIComponent(label.id)}` : ''}`, { method: action, csrf, body: { ...body, operationId: mutationKey(), ...(label ? { expectedVersion: label.version } : {}) } });
}

/** Scoped invalidations only. A failed source session terminates rather than reconnecting indefinitely. */
export async function watchMailbox(box: string, signal: AbortSignal, invalidate: () => void, status: (value: 'live' | 'reconnecting' | 'expired') => void): Promise<void> {
  let lastId = '', retry = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${boxPath(box)}/events`, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) } });
      if ([401, 403, 404].includes(response.status)) { status('expired'); return; }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Unavailable');
      status('live'); retry = 0; const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal.aborted) {
          const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }).replaceAll('\r\n', '\n');
          if (buffer.length > 65536) throw new Error('Invalid event stream');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const id = event.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim();
            if (id && /^\d{1,30}$/.test(id)) lastId = id;
            if (event.split('\n').some(line => ['event: invalidate', 'event: reset'].includes(line.trim()))) invalidate();
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { if (signal.aborted) return; }
    if (signal.aborted) return;
    status('reconnecting');
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, Math.min(15000, 1000 * 2 ** retry++)); signal.addEventListener('abort', done, { once: true }); });
  }
}
