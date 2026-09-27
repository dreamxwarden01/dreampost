import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageReader } from '../MessageReader';
import { errorMessage, type MessageDetail } from '../api';
import type { AttachmentConfig } from '../attachments/api';
import type { ComposeMode } from '../compose/api';
import { loadThread, type Capabilities, type Folder, type MailAddress, type MailMessage } from './api';

export interface MessageSelection { opening: number; kind: 'message' | 'thread'; id: string; message?: MailMessage; lastMessageId?: string }
export function ThreadPane({ mailboxId, selection, folder, revision, csrf, imagePreference, attachmentConfig, capabilities, canCompose, selected, onSelect, onMutate, onCompose, onRead, onOpenMessage, onBack }: {
  mailboxId: string; selection: MessageSelection; folder: Folder; revision: number; csrf: string; imagePreference: boolean; attachmentConfig?: AttachmentConfig; capabilities: Capabilities; canCompose: boolean; selected: Set<string>;
  onSelect: (message: MailMessage) => void; onMutate: (messages: MailMessage[], set: { read?: boolean; starred?: boolean; folder?: 'inbox' | 'archive' | 'trash' | 'spam' }) => void;
  onCompose: (mode: ComposeMode, id: string, person?: MailAddress) => void; onRead: (message: MailMessage) => void; onOpenMessage: (id: string) => void; onBack: () => void;
}) {
  const [messages, setMessages] = useState<MailMessage[]>(selection.message ? [selection.message] : []);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([selection.message?.id ?? selection.lastMessageId ?? '']));
  const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const [details, setDetails] = useState<Record<string, MessageDetail>>({});
  const receiveDetail = useCallback((message: MessageDetail) => setDetails(previous => previous[message.id]?.reader.contentVersion === message.reader.contentVersion ? previous : { ...previous, [message.id]: message }), []);
  useEffect(() => {
    if (selection.kind === 'message') { if (selection.message) setMessages([selection.message]); return; }
    void reload(); return () => request.current?.abort();
  }, [selection.id, selection.kind, revision, mailboxId, folder, selection.message]);
  async function reload(after?: string) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError('');
    try { const result = await loadThread(mailboxId, selection.id, folder, after ?? null, controller.signal, true); if (controller.signal.aborted) return;
      setMessages(previous => after ? [...previous, ...result.messages.filter(m => !previous.some(old => old.id === m.id))] : result.messages); setCursor(result.nextCursor);
      if (!after) setExpanded(previous => previous.size ? previous : new Set(result.messages.slice(-1).map(m => m.id)));
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className="thread-pane" aria-label="Conversation reader" aria-busy={loading}>
    <div className="thread-toolbar"><button className="button subtle" onClick={onBack}>← Back to list</button><span>{selection.kind === 'thread' ? `${messages.length} loaded messages` : 'Message'}</span></div>
    {error && <div className="error-panel" role="alert">{error}<button className="button" onClick={() => void reload()}>Retry</button></div>}
    <div className="thread-scroll">{messages.map(message => <ThreadCard key={message.id} message={message} open={expanded.has(message.id)} selected={selected.has(message.id)} canCompose={canCompose} capabilities={capabilities} detail={details[message.id]}
      toggle={() => { if (!expanded.has(message.id)) onOpenMessage(message.id); setExpanded(previous => { const next = new Set(previous); next.has(message.id) ? next.delete(message.id) : next.add(message.id); return next; }); }}
      select={() => onSelect(message)} mutate={set => onMutate([message], set)} compose={(mode, person) => onCompose(mode, message.id, person)}>
      <MessageReader mailboxId={mailboxId} messageId={message.id} token="" revision={revision} csrfToken={csrf} autoLoadExternalImages={imagePreference} attachmentConfig={attachmentConfig} onBack={onBack} embedded onOpened={() => onRead(message)} onDetail={receiveDetail} />
    </ThreadCard>)}
    {loading && messages.length === 0 && <p className="mail-empty" role="status">Loading conversation…</p>}
    {cursor && <button className="button load-more" disabled={loading} onClick={() => void reload(cursor)}>Load more messages</button>}
    {!loading && !messages.length && !error && <p className="mail-empty">No visible messages remain in this conversation.</p>}
    </div>
  </section>;
}
function ThreadCard({ message, open, selected, canCompose, capabilities, toggle, select, mutate, compose, children, detail }: { detail?: MessageDetail; message: MailMessage; open: boolean; selected: boolean; canCompose: boolean; capabilities: Capabilities; toggle: () => void; select: () => void; mutate: (set: { read?: boolean; starred?: boolean; folder?: 'inbox' | 'archive' | 'trash' | 'spam' }) => void; compose: (mode: ComposeMode, person?: MailAddress) => void; children: React.ReactNode }) {
  const [showPeople, setShowPeople] = useState(false);
  const people: MailAddress[] = [];
  if (detail?.addresses) for (const person of [...detail.addresses.replyTo, ...detail.addresses.from, ...detail.addresses.to, ...detail.addresses.cc]) if (!people.some(p => p.address === person.address)) people.push(person);
  return <div className={`thread-card ${open ? 'expanded' : ''} ${!message.read ? 'unread' : ''}`}>
    <div className="thread-card-heading"><input type="checkbox" aria-label={`Select ${message.subject || 'message'}`} checked={selected} onChange={select} /><button className="thread-expand" aria-expanded={open} onClick={toggle}><span><strong dir="auto">{message.from || 'Unknown sender'}</strong><small dir="auto">{message.subject || '(No subject)'}</small></span><time>{new Date(message.receivedAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button><button className={`star-button ${message.starred ? 'starred' : ''}`} disabled={!capabilities.canSetPersonalFlags} aria-label={message.starred ? 'Unstar message' : 'Star message'} onClick={() => mutate({ starred: !message.starred })}>{message.starred ? '★' : '☆'}</button></div>
    {open && <><div className="message-action-bar">{canCompose && <><button className="button" onClick={() => compose('reply')}>Reply</button><button className="button" onClick={() => compose('reply_all')}>Reply all</button><button className="button subtle" onClick={() => compose('forward')}>Forward</button><button className="button subtle" aria-expanded={showPeople} onClick={() => setShowPeople(v => !v)}>Reply to a person</button></>}<button className="button subtle" disabled={!capabilities.canSetPersonalFlags} onClick={() => mutate({ read: !message.read })}>{message.read ? 'Mark unread' : 'Mark read'}</button>{capabilities.canManageMessages && <><button className="button subtle" onClick={() => mutate({ folder: message.folder === 'archive' ? 'inbox' : 'archive' })}>{message.folder === 'archive' ? 'Move to inbox' : 'Archive'}</button><button className="button subtle" onClick={() => mutate({ folder: 'trash' })}>Move to trash</button></>}</div>{showPeople && <div className="reply-people">{people.length ? people.map((person, i) => <button key={i} className="button" onClick={() => { setShowPeople(false); compose('reply_person', person); }}>{person.name ? `${person.name} <${person.address}>` : person.address}</button>) : <p>Recipient choices appear after the parsed message has loaded.</p>}</div>}{children}</>}
  </div>;
}
