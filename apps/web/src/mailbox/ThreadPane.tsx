import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageReader } from '../MessageReader';
import { errorMessage, type MessageDetail } from '../api';
import type { AttachmentConfig } from '../attachments/api';
import type { ComposeMode } from '../compose/api';
import { loadThread, type Capabilities, type Folder, type MailAddress, type MailMessage } from './api';
import { archiveDestination, containsCopy, mergeMessagePages, sameMessage } from './copies';

export interface MessageSelection { opening: number; kind: 'message' | 'thread'; id: string; message?: MailMessage; lastMessageId?: string }
export function ThreadPane({ mailboxId, selection, folder, revision, csrf, imagePreference, attachmentConfig, capabilities, canCompose, selected, onSelect, onMutate, onCompose, onRead, onOpenMessage, onBack }: {
  mailboxId: string; selection: MessageSelection; folder: Folder; revision: number; csrf: string; imagePreference: boolean; attachmentConfig?: AttachmentConfig; capabilities: Capabilities; canCompose: boolean; selected: Set<string>;
  onSelect: (message: MailMessage) => void; onMutate: (messages: MailMessage[], set: { read?: boolean; starred?: boolean; folder?: 'inbox' | 'archive' | 'trash' | 'spam' }) => void;
  onCompose: (mode: ComposeMode, id: string, person?: MailAddress) => void; onRead: (message: MailMessage) => void; onOpenMessage: (message: MailMessage) => void; onBack: () => void;
}) {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([selection.message?.copyGroupId ?? selection.lastMessageId ?? '']));
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const previousMessages = useRef<MailMessage[]>([]);
  const [details, setDetails] = useState<Record<string, MessageDetail>>({});
  const receiveDetail = useCallback((message: MessageDetail) => setDetails(previous => previous[message.id]?.reader.contentVersion === message.reader.contentVersion ? previous : { ...previous, [message.id]: message }), []);
  useEffect(() => { void reload(); return () => request.current?.abort(); }, [selection.id, revision, mailboxId, folder]);
  async function reload(after?: string) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError('');
    try {
      let result = await loadThread(mailboxId, selection.id, folder, after ?? null, controller.signal, true);
      const anchor = selection.message?.id ?? selection.lastMessageId;
      // A verified late copy can move the only member out of its original thread.
      // Resolve its already authorized delivery locator instead of leaving an empty reader.
      if (!after && !result.messages.length && anchor && anchor !== selection.id) result = await loadThread(mailboxId, anchor, folder, null, controller.signal, true);
      if (controller.signal.aborted) return;
      const old = previousMessages.current;
      const next = after ? mergeMessagePages(old, result.messages) : result.messages;
      setExpanded(previous => new Set([...previous].map(anchor => {
        const prior = old.find(message => containsCopy(message, anchor));
        return next.find(message => containsCopy(message, anchor) || prior && sameMessage(prior, message))?.copyGroupId ?? anchor;
      })));
      previousMessages.current = next; setMessages(next); setCursor(result.nextCursor);
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className="thread-pane" aria-label="Conversation reader" aria-busy={loading}>
    <div className="thread-toolbar"><button className="button subtle" onClick={onBack}>← Back to list</button><span>{messages.length} loaded message{messages.length === 1 ? '' : 's'}</span></div>
    {error && <div className="error-panel" role="alert">{error}<button className="button" onClick={() => void reload()}>Retry</button></div>}
    <div className="thread-scroll">{messages.map(message => <ThreadCard key={message.copyGroupId} message={message} open={expanded.has(message.copyGroupId)} selected={selected.has(message.copyGroupId)} canCompose={canCompose} capabilities={capabilities} details={details}
      toggle={() => { if (!expanded.has(message.copyGroupId)) onOpenMessage(message); setExpanded(previous => { const next = new Set(previous); next.has(message.copyGroupId) ? next.delete(message.copyGroupId) : next.add(message.copyGroupId); return next; }); }}
      select={() => onSelect(message)} mutate={set => onMutate([message], set)} compose={(mode, id, person) => onCompose(mode, id, person)}
      renderCopy={id => <MessageReader key={`${mailboxId}:${id}`} mailboxId={mailboxId} messageId={id} token="" revision={revision} csrfToken={csrf} autoLoadExternalImages={imagePreference} attachmentConfig={attachmentConfig} onBack={onBack} embedded onOpened={() => onRead(message)} onDetail={receiveDetail} />} />)}
      {loading && messages.length === 0 && <p className="mail-empty" role="status">Loading conversation…</p>}
      {cursor && <button className="button load-more" disabled={loading} onClick={() => void reload(cursor)}>Load more messages</button>}
      {!loading && !messages.length && !error && <p className="mail-empty">No visible messages remain in this conversation.</p>}
    </div>
  </section>;
}
function ThreadCard({ message, open, selected, canCompose, capabilities, toggle, select, mutate, compose, renderCopy, details }: {
  details: Record<string, MessageDetail>; message: MailMessage; open: boolean; selected: boolean; canCompose: boolean; capabilities: Capabilities;
  toggle: () => void; select: () => void; mutate: (set: { read?: boolean; starred?: boolean; folder?: 'inbox' | 'archive' | 'trash' | 'spam' }) => void;
  compose: (mode: ComposeMode, id: string, person?: MailAddress) => void; renderCopy: (id: string) => React.ReactNode;
}) {
  const [showPeople, setShowPeople] = useState(false), [chosenCopy, setChosenCopy] = useState<string | null>(null);
  const copyId = chosenCopy && message.copies.some(copy => copy.id === chosenCopy) ? chosenCopy : message.id;
  const detail = details[copyId], people: MailAddress[] = [];
  if (detail?.addresses) for (const person of [...detail.addresses.replyTo, ...detail.addresses.from, ...detail.addresses.to, ...detail.addresses.cc]) if (!people.some(p => p.address === person.address)) people.push(person);
  const archiveTo = archiveDestination(message);
  const mixedCopies = message.copies.some(copy => copy.direction === 'inbound') && message.copies.some(copy => copy.direction === 'outbound');
  const receivedCount = message.copies.filter(copy => copy.direction === 'inbound').length;
  const receivedLabel = receivedCount === 1 ? 'received copy' : 'received copies';
  return <div className={`thread-card ${open ? 'expanded' : ''} ${!message.read ? 'unread' : ''}`} data-copy-group={message.copyGroupId}>
    <div className="thread-card-heading"><input type="checkbox" aria-label={`Select ${message.subject || 'message'}`} checked={selected} onChange={select} /><button className="thread-expand" aria-expanded={open} onClick={toggle}><span><strong dir="auto">{message.from || 'Unknown sender'}</strong><small dir="auto">{message.subject || '(No subject)'}</small></span><time>{new Date(message.receivedAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button><button className={`star-button ${message.starred ? 'starred' : ''}`} disabled={!capabilities.canSetPersonalFlags} aria-label={message.starred ? 'Unstar message' : 'Star message'} onClick={() => mutate({ starred: !message.starred })}>{message.starred ? '★' : '☆'}</button></div>
    {open && <><div className="message-action-bar">{canCompose && <><button className="button" onClick={() => compose('reply', copyId)}>Reply</button><button className="button" onClick={() => compose('reply_all', copyId)}>Reply all</button><button className="button subtle" onClick={() => compose('forward', copyId)}>Forward</button><button className="button subtle" aria-expanded={showPeople} onClick={() => setShowPeople(v => !v)}>Reply to a person</button></>}<button className="button subtle" disabled={!capabilities.canSetPersonalFlags} onClick={() => mutate({ read: !message.read })}>{message.read ? 'Mark unread' : 'Mark read'}</button>{capabilities.canManageMessages && <><button className="button subtle" onClick={() => mutate({ folder: archiveTo })}>{mixedCopies ? archiveTo === 'inbox' ? `Move ${receivedLabel} to inbox` : `Archive ${receivedLabel}` : archiveTo === 'inbox' ? 'Move to inbox' : 'Archive'}</button><button className="button subtle" onClick={() => mutate({ folder: 'trash' })}>{mixedCopies ? `Move ${receivedLabel} to trash` : 'Move to trash'}</button></>}</div>
      {message.copies.length > 1 && <label className="thread-copy-controls">Stored copy <select aria-label="Stored message copy" value={copyId} onChange={event => { setChosenCopy(event.target.value); setShowPeople(false); }}>{message.copies.map(copy => <option key={copy.id} value={copy.id}>{copy.direction === 'outbound' ? 'Sent copy' : `Received copy${message.copies.filter(item => item.direction === 'inbound').length > 1 ? ` ${message.copies.filter(item => item.direction === 'inbound').findIndex(item => item.id === copy.id) + 1}` : ''}`} · {copy.folder}</option>)}</select><span>One message; original copies are preserved.</span></label>}
      {showPeople && <div className="reply-people">{people.length ? people.map((person, index) => <button key={index} className="button" onClick={() => { setShowPeople(false); compose('reply_person', copyId, person); }}>{person.name ? `${person.name} <${person.address}>` : person.address}</button>) : <p>Recipient choices appear after the parsed message has loaded.</p>}</div>}{renderCopy(copyId)}</>}
  </div>;
}
