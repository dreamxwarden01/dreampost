import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, type Mailbox } from '../api';
import type { AttachmentConfig } from '../attachments/api';
import { Composer } from '../compose/Composer';
import { cancelSubmission, createDraft, duplicateDraft, listDrafts, listOutbox, loadDraft, type ComposeMode, type Draft, type DraftSummary, type OutboundConfig, type Submission } from '../compose/api';
import { ThreadPane, type MessageSelection } from './ThreadPane';
import { array, bool, boxPath, mailRequest, object, text, changeLabel, loadLabels, loadMail, mutateMessages, mutationKey, undoMessages, watchMailbox, type Capabilities, type Folder, type MailAddress, type MailLabel, type MailMessage, type MailPage, type MailQuery, type MailState, type MessageMutation, type MutationResult } from './api';

interface Props { mailbox: Mailbox; accessibleMailboxIds: string[]; csrf: string; permissions: string[]; active: boolean; visible: boolean; outbound?: OutboundConfig; attachmentConfig?: AttachmentConfig; autoLoadExternalImages: boolean; onComposerState: (open: boolean, dirty: boolean) => void }
const noCapabilities: Capabilities = { canSetPersonalFlags: false, canManageMessages: false, canManageLabels: false };
interface SidebarMetadata { mailboxId: string; labels: MailLabel[]; capabilities: Capabilities }
type Destination = Folder | 'drafts' | 'outbox';
const destinations: Array<[Destination, string, string]> = [['inbox', 'Inbox', '▣'], ['sent', 'Sent', '↗'], ['drafts', 'Drafts', '✎'], ['outbox', 'Outbox', '⇧'], ['archive', 'Archive', '▤'], ['spam', 'Spam', '!'], ['trash', 'Trash', '⌫'], ['all', 'All mail', '≡']];
const date = (value: string) => new Date(value).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function MailboxWorkspace({ mailbox, accessibleMailboxIds, csrf, permissions, active, visible, outbound, attachmentConfig, autoLoadExternalImages, onComposerState }: Props) {
  const [destination, setDestination] = useState<Destination>('inbox'); const [queryText, setQueryText] = useState(''); const [query, setQuery] = useState(''); const [view, setView] = useState<'messages' | 'threads'>('messages');
  const [unread, setUnread] = useState(false); const [starred, setStarred] = useState(false); const [labelId, setLabelId] = useState('');
  const [storedPage, setPage] = useState<MailPage | null>(null); const [sidebar, setSidebar] = useState<SidebarMetadata | null>(null); const [storedDrafts, setDrafts] = useState<DraftSummary[]>([]); const [storedOutbox, setOutbox] = useState<Submission[]>([]);
  const [contentMailboxId, setContentMailboxId] = useState(mailbox.id); const [deniedAccessKey, setDeniedAccessKey] = useState<string | null>(null); const [labelsRevision, setLabelsRevision] = useState(0);
  const [storedSelection, setSelection] = useState<MessageSelection | null>(null); const [storedSelected, setSelected] = useState<Map<string, MailMessage>>(() => new Map());
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0); const [refreshKey, setRefreshKey] = useState(0);
  const [live, setLive] = useState<'live' | 'reconnecting' | 'expired'>('reconnecting'); const [undo, setUndo] = useState<MutationResult | null>(null); const [notice, setNotice] = useState('');
  const [composer, setComposer] = useState<Draft | null>(null); const [composerDirty, setComposerDirty] = useState(false); const composerDirtyRef = useRef(false); composerDirtyRef.current = composerDirty;
  const [labelsOpen, setLabelsOpen] = useState(false); const [labelName, setLabelName] = useState(''); const [editLabel, setEditLabel] = useState<MailLabel | null>(null); const [actionLabel, setActionLabel] = useState('');
  const request = useRef<AbortController | null>(null); const epoch = useRef(0); const mounted = useRef(true); const activeRef = useRef(active);
  const opening = useRef(0);
  const pendingRead = useRef(new Set<string>()), suppressRead = useRef(new Set<string>());
  const accessKey = `${mailbox.id}:${csrf}`; const currentAccess = useRef(accessKey); currentAccess.current = accessKey;
  const permissionKey = [...permissions].sort().join('|');
  const accessAllowed = active && accessibleMailboxIds.includes(mailbox.id) && permissions.includes('mailbox.use') && deniedAccessKey !== accessKey;
  activeRef.current = accessAllowed;
  const currentContent = accessAllowed && contentMailboxId === mailbox.id;
  const page = currentContent ? storedPage : null, drafts = currentContent ? storedDrafts : [], outbox = currentContent ? storedOutbox : [];
  const selection = currentContent ? storedSelection : null, selected = currentContent ? storedSelected : new Map<string, MailMessage>();
  const metadata = accessAllowed && sidebar?.mailboxId === mailbox.id ? sidebar : null;
  const labels = metadata?.labels ?? [];
  // Sidebar authority belongs to the mailbox, not the transient message-list page.
  const capabilities: Capabilities = metadata ? { ...metadata.capabilities,
    canManageMessages: metadata.capabilities.canManageMessages && permissions.includes('mail.manage'),
    canManageLabels: metadata.capabilities.canManageLabels && permissions.includes('mail.manage') } : noCapabilities;
  const canCompose = accessAllowed && permissions.includes('mail.send');
  const backgroundRefresh = useRef(false), labelsBackground = useRef(false);
  const metadataCursor = useRef<{ mailboxId: string; sequence: string } | null>(null);
  const latestSequence = useRef<{ mailboxId: string; sequence: string } | null>(null);
  const refreshLabels = useCallback((background = true) => { labelsBackground.current = background; setLabelsRevision(value => value + 1); }, []);
  const refresh = useCallback(() => { backgroundRefresh.current = false; setRefreshKey(value => value + 1); }, []);
  const refreshInBackground = useCallback(() => { backgroundRefresh.current = true; setRefreshKey(value => value + 1); }, []);
  const refreshAll = useCallback(() => { setDeniedAccessKey(null); refreshLabels(false); refresh(); }, [refresh, refreshLabels]);
  const revokeAccess = useCallback((scope: string) => {
    if (currentAccess.current !== scope) return;
    setDeniedAccessKey(scope); setSidebar(null); setPage(null); setDrafts([]); setOutbox([]); setSelection(null); setSelected(new Map());
    setUndo(null); setNotice(''); setLabelsOpen(false); setEditLabel(null); setLabelName(''); setLive('expired'); request.current?.abort();
    setLoading(false); setError('Your mailbox access changed. Refresh your session before continuing.');
  }, []);
  const listFailure = useCallback((failure: unknown, scope: string) => {
    if (currentAccess.current !== scope) return;
    if (failure instanceof ApiError && [401, 403, 404].includes(failure.status ?? 0)) revokeAccess(scope);
    else setError(errorMessage(failure));
  }, [revokeAccess]);
  const updateCapabilities = useCallback((box: string, value: Capabilities) => {
    setSidebar(old => old?.mailboxId === box ? { ...old, capabilities: value } : { mailboxId: box, labels: [], capabilities: value });
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    setContentMailboxId(mailbox.id); setSelection(null); setSelected(new Map()); setPage(null); setSidebar(null); setDrafts([]); setOutbox([]); setUndo(null);
    setError(''); setNotice(''); setLabelId(''); setActionLabel(''); setLabelsOpen(false); setEditLabel(null); setLabelName('');
    setDestination('inbox'); setQuery(''); setQueryText(''); suppressRead.current.clear(); metadataCursor.current = null; latestSequence.current = null; epoch.current++;
  }, [mailbox.id]);
  useEffect(() => {
    if (accessAllowed) return;
    request.current?.abort(); setSidebar(null); setPage(null); setDrafts([]); setOutbox([]); setSelection(null); setSelected(new Map()); setUndo(null); setLoading(false);
  }, [accessAllowed]);
  const folder = destination === 'drafts' || destination === 'outbox' ? 'inbox' : destination;
  const listQuery: MailQuery = { folder, view, q: query, unread, starred, ...(labelId ? { labelId } : {}) };
  const queryKey = JSON.stringify(listQuery);
  useEffect(() => {
    setSelected(new Map()); setSelection(null); setPage(null); suppressRead.current.clear();
  }, [mailbox.id, destination, queryKey]);
  useEffect(() => {
    if (!accessAllowed) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const current = ++epoch.current; setLoading(true); setError('');
    const run = async () => {
      try {
        if (destination === 'drafts') { const result = await listDrafts(mailbox.id, controller.signal, backgroundRefresh.current); if (!controller.signal.aborted && current === epoch.current) setDrafts(result); }
        else if (destination === 'outbox') { const result = await listOutbox(mailbox.id, controller.signal, backgroundRefresh.current); if (!controller.signal.aborted && current === epoch.current) setOutbox(result); }
        else { const result = await loadMail(mailbox.id, JSON.parse(queryKey) as MailQuery, null, controller.signal, backgroundRefresh.current); if (!controller.signal.aborted && current === epoch.current) { setPage(result); updateCapabilities(mailbox.id, result.capabilities); latestSequence.current = { mailboxId: mailbox.id, sequence: result.changeSequence }; if (metadataCursor.current?.mailboxId !== mailbox.id) { metadataCursor.current = latestSequence.current; refreshLabels(true); } setSelection(old => old?.kind === 'message' && result.messages.some(m => m.id === old.id) ? { ...old, message: result.messages.find(m => m.id === old.id)! } : old); setSelected(previous => new Map([...previous].map(([id, old]) => [id, result.messages.find(m => m.id === id) ?? old]))); setRevision(v => v + 1); } }
      } catch (failure) { if (!controller.signal.aborted && current === epoch.current) listFailure(failure, accessKey); }
      finally { if (!controller.signal.aborted && current === epoch.current) setLoading(false); }
    }; void run(); return () => controller.abort();
  }, [mailbox.id, accessKey, accessAllowed, permissionKey, destination, queryKey, refreshKey, listFailure, refreshLabels, updateCapabilities]);
  useEffect(() => {
    if (!accessAllowed) return;
    const controller = new AbortController(), scope = accessKey;
    void loadLabels(mailbox.id, controller.signal, labelsBackground.current).then(result => {
      if (!controller.signal.aborted && currentAccess.current === scope) setSidebar({ mailboxId: mailbox.id, labels: result.labels, capabilities: result.capabilities });
    }).catch(failure => { if (!controller.signal.aborted) listFailure(failure, scope); });
    return () => controller.abort();
  }, [mailbox.id, accessKey, accessAllowed, permissionKey, labelsRevision, listFailure]);
  useEffect(() => {
    if (!accessAllowed) return;
    const controller = new AbortController(), scope = accessKey; let timer: ReturnType<typeof setTimeout> | undefined;
    let connected = false, reconnecting = false, inspecting = false, pendingInspection = false;
    const inspectChanges = async () => {
      if (inspecting) { pendingInspection = true; return; }
      inspecting = true;
      try {
        const cursor = metadataCursor.current;
        if (cursor?.mailboxId !== mailbox.id) { refreshLabels(true); return; }
        const result = object(await mailRequest(`${boxPath(mailbox.id)}/changes?after=${encodeURIComponent(cursor.sequence)}&limit=500`, { signal: controller.signal, background: true }));
        const next = text(result.nextSequence); if (!/^\d{1,30}$/.test(next)) throw new Error('Invalid mailbox change sequence.');
        const reset = bool(result.resetRequired), more = bool(result.hasMore);
        const changed = array(result.changes).some(change => text(object(change).kind).startsWith('label.'));
        if (controller.signal.aborted || currentAccess.current !== scope) return;
        const latest = latestSequence.current;
        // A fresh labels snapshot also covers skipped backlog up to an already observed list snapshot.
        const sequence = more && latest?.mailboxId === mailbox.id && BigInt(latest.sequence) > BigInt(next) ? latest.sequence : next;
        metadataCursor.current = { mailboxId: mailbox.id, sequence };
        if (reset || more || changed) refreshLabels(true);
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (failure instanceof ApiError && [401, 403, 404].includes(failure.status ?? 0)) listFailure(failure, scope);
          else refreshLabels(true);
        }
      } finally {
        inspecting = false;
        if (pendingInspection && !controller.signal.aborted) { pendingInspection = false; void inspectChanges(); }
      }
    };
    void watchMailbox(mailbox.id, controller.signal, () => {
      if (!timer) timer = setTimeout(() => { timer = undefined; refreshInBackground(); void inspectChanges(); }, 300);
    }, status => {
      if (controller.signal.aborted || currentAccess.current !== scope) return;
      setLive(status);
      if (status === 'expired') revokeAccess(scope);
      else if (status === 'reconnecting') reconnecting = true;
      else { if (connected && reconnecting) refreshLabels(true); connected = true; reconnecting = false; }
    });
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [mailbox.id, accessKey, accessAllowed, refreshInBackground, refreshLabels, listFailure, revokeAccess]);
  useEffect(() => { if (destination !== 'outbox' || !accessAllowed) return; const timer = setInterval(refreshInBackground, 5000); return () => clearInterval(timer); }, [destination, accessAllowed, refreshInBackground]);
  useEffect(() => { if (!undo?.undoUntil) return; const timer = setTimeout(() => setUndo(null), Math.max(0, new Date(undo.undoUntil).getTime() - Date.now())); return () => clearTimeout(timer); }, [undo]);
  async function more() { if (!page?.nextCursor || loading) return; const current = epoch.current; const controller = new AbortController(); request.current?.abort(); request.current = controller; setLoading(true); setError('');
    try { const result = await loadMail(mailbox.id, listQuery, page.nextCursor, controller.signal); if (!controller.signal.aborted && current === epoch.current) { updateCapabilities(mailbox.id, result.capabilities); latestSequence.current = { mailboxId: mailbox.id, sequence: result.changeSequence }; setPage(previous => previous ? { ...result, messages: [...previous.messages, ...result.messages.filter(m => !previous.messages.some(old => old.id === m.id))], threads: [...previous.threads, ...result.threads.filter(t => !previous.threads.some(old => old.id === t.id))] } : result); } }
    catch (failure) { if (!controller.signal.aborted && current === epoch.current) listFailure(failure, accessKey); } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function applyStates(changes: MailState[], expected: Map<string, string>) {
    const map = new Map(changes.map(message => [message.id, message]));
    // Versions are opaque. Only patch the exact snapshot that issued the mutation.
    const merge = (message: MailMessage): MailMessage => {
      const change = map.get(message.id);
      return change && message.version === expected.get(message.id) ? { ...message, ...change } : message;
    };
    setPage(old => old ? { ...old, messages: old.messages.map(merge) } : old);
    setSelection(old => old?.message ? { ...old, message: merge(old.message) } : old);
    setSelected(old => new Map([...old].map(([id, value]) => [id, merge(value)])));
  }
  async function mutate(items: MailMessage[], changes: Omit<MessageMutation, 'operationId' | 'items'>, allowUndo = true) {
    if (!items.length || !activeRef.current || busy && allowUndo) return;
    const box = mailbox.id, scope = accessKey, expected = new Map(items.map(message => [message.id, message.version]));
    if (allowUndo) { setBusy(true); setUndo(null); setNotice(''); } setError('');
    if (changes.set?.read === false) items.forEach(message => suppressRead.current.add(message.id));
    try {
      const result = await mutateMessages(box, { ...changes, operationId: mutationKey(), items: items.map(message => ({ id: message.id, version: message.version })) }, csrf);
      // A list refresh cannot discard an accepted operation's receipt or replace its Undo target.
      if (!mounted.current || currentAccess.current !== scope || !activeRef.current) return;
      applyStates(result.messages, expected);
      if (allowUndo) { setUndo(result.undoUntil ? result : null); setNotice(`${items.length} message${items.length === 1 ? '' : 's'} updated.`); }
      refresh();
    } catch (failure) { if (mounted.current && currentAccess.current === scope && activeRef.current) setError(errorMessage(failure)); }
    finally { if (mounted.current && allowUndo) setBusy(false); }
  }
  async function undoOperation(operation: MutationResult) {
    if (busy || !activeRef.current) return;
    const scope = accessKey, expected = new Map(operation.messages.map(message => [message.id, message.version]));
    setBusy(true); setError('');
    try {
      const result = await undoMessages(mailbox.id, operation.operationId, csrf);
      if (!mounted.current || currentAccess.current !== scope || !activeRef.current) return;
      applyStates(result.messages, expected); setUndo(current => current?.operationId === operation.operationId ? null : current);
      setNotice('Action undone.'); refresh();
    } catch (failure) { if (mounted.current && currentAccess.current === scope && activeRef.current) setError(errorMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const onRead = useCallback((message: MailMessage) => {
    if (message.read || suppressRead.current.has(message.id) || pendingRead.current.has(message.id) || !activeRef.current) return;
    pendingRead.current.add(message.id); void mutate([message], { set: { read: true } }, false).finally(() => pendingRead.current.delete(message.id));
  }, [mailbox.id, csrf]);
  function toggleSelected(message: MailMessage) { setSelected(previous => { const next = new Map(previous); next.has(message.id) ? next.delete(message.id) : next.size < 100 && next.set(message.id, message); return next; }); }
  async function startCompose(mode: ComposeMode, sourceMessageId?: string, person?: MailAddress) {
    if (!canCompose || busy) return;
    if (composer) { setNotice('Finish or save and close the current composer before opening another draft.'); return; }
    setBusy(true); setError(''); const box = mailbox.id;
    try { const draft = await createDraft(box, { mode, ...(sourceMessageId ? { sourceMessageId } : {}), ...(person ? { replyPerson: person } : {}), mutationKey: mutationKey() }, csrf); if (mounted.current) { setComposer(draft); setComposerDirty(false); onComposerState(true, false); refresh(); } }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); } finally { if (mounted.current) setBusy(false); }
  }
  async function openDraft(id: string) { if (composer) { setNotice('Save and close the current composer before opening another draft.'); return; } setBusy(true); try { const draft = await loadDraft(mailbox.id, id); if (mounted.current) { setComposer(draft); onComposerState(true, false); } } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }
  async function recoverSubmission(item: Submission) {
    if (composer) { setNotice('Save and close the current composer before opening another draft.'); return; }
    setBusy(true); setError('');
    try { const recovered = await duplicateDraft(item.mailboxId, item.draftId, csrf, mutationKey()); if (mounted.current) { setComposer(recovered); onComposerState(true, false); } }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); } finally { if (mounted.current) setBusy(false); }
  }
  function navigate(next: Destination) { setDestination(next); setLabelId(''); setQuery(''); setQueryText(''); setUnread(false); setStarred(false); }
  const composerState = useCallback((open: boolean, dirty: boolean) => { setComposerDirty(dirty); onComposerState(open, dirty); }, [onComposerState]);
  function search(event: FormEvent) { event.preventDefault(); setQuery(queryText.trim()); }
  async function labelChange(method: 'POST' | 'PATCH' | 'DELETE', label?: MailLabel) { if (!accessAllowed) return; const scope = accessKey; setBusy(true); setError(''); try { await changeLabel(mailbox.id, csrf, method, method === 'DELETE' ? {} : { name: labelName.trim() }, label); if (currentAccess.current !== scope) return; setLabelName(''); setEditLabel(null); refreshLabels(false); refresh(); } catch (failure) { listFailure(failure, scope); } finally { if (mounted.current) setBusy(false); } }
  const title = labelId ? labels.find(l => l.id === labelId)?.name ?? 'Label' : destinations.find(d => d[0] === destination)?.[1] ?? 'Mail';
  const selectedItems = [...selected.values()];
  return <>
    <main hidden={!visible} className={`inbox-workspace everyday-workspace ${selection ? 'has-selection' : ''}`}>
      <aside className="mailbox-sidebar" aria-label="Mailbox navigation"><div className="mailbox-identity"><span className="mailbox-avatar">D</span><div><strong>{mailbox.name}</strong><span>{mailbox.address}</span></div></div>
        {permissions.includes('mail.send') && <button className="button primary compose-new" aria-label="Compose" disabled={!accessAllowed || busy} onClick={() => void startCompose('new')}>✎ Compose</button>}
        <nav className="mail-folders">{destinations.map(([id, label, symbol]) => <button key={id} className={`folder-button ${destination === id && !labelId ? 'active' : ''}`} aria-current={destination === id && !labelId ? 'page' : undefined} onClick={() => navigate(id)}><span aria-hidden="true">{symbol}</span>{label}</button>)}</nav>
        <div className="labels-heading"><span className="sidebar-label">Labels</span>{capabilities.canManageLabels && <button className="button subtle" aria-expanded={labelsOpen} onClick={() => setLabelsOpen(v => !v)}>Manage</button>}</div>
        <nav className="mail-labels">{labels.map(label => <button key={label.id} className={`folder-button ${labelId === label.id ? 'active' : ''}`} onClick={() => { navigate('all'); setLabelId(label.id); }}><span aria-hidden="true">◇</span>{label.name}</button>)}</nav>
        <div className="sidebar-footer"><span className={`status-dot ${live === 'live' ? 'connected' : ''}`} /> {live === 'live' ? 'Live updates' : live === 'expired' ? 'Access changed' : 'Reconnecting…'}</div>
      </aside>
      <section className="list-panel" aria-labelledby="everyday-list-heading" aria-busy={loading}>
        <div className="mobile-mail-navigation"><select aria-label="Mail folder" value={destination} onChange={e => navigate(e.target.value as Destination)}>{destinations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>{canCompose && <button className="button primary" disabled={busy} onClick={() => void startCompose('new')}>Compose</button>}</div>
        <div className="list-heading"><div><h1 id="everyday-list-heading">{title}</h1><p>{destination === 'spam' ? 'Manually filed messages · automatic filtering is not configured' : destination === 'outbox' ? 'Provider acceptance is not proof of delivery' : query ? `Search: ${query}` : 'Your mail, under your control'}</p></div><button className="icon-button" aria-label="Refresh mail" disabled={loading} onClick={refreshAll}>↻</button></div>
        {!['drafts', 'outbox'].includes(destination) && <><form className="mail-search" onSubmit={search}><input aria-label="Search mail" placeholder="Search this mailbox" value={queryText} maxLength={256} onChange={e => setQueryText(e.target.value)} /><button className="button" type="submit">Search</button>{query && <button className="button subtle" type="button" onClick={() => { setQuery(''); setQueryText(''); }}>Clear</button>}</form><div className="mail-filters"><button className="filter-chip" aria-pressed={unread} onClick={() => setUnread(v => !v)}>Unread</button><button className="filter-chip" aria-pressed={starred} onClick={() => setStarred(v => !v)}>Starred</button><select aria-label="Mail list layout" value={view} onChange={e => setView(e.target.value as typeof view)}><option value="messages">Messages</option><option value="threads">Conversations</option></select></div></>}
        {error && <div className="error-panel list-error" role="alert">{error}<button className="button" onClick={refreshAll}>Refresh</button><button className="button subtle" onClick={() => window.dispatchEvent(new Event('focus'))}>Refresh session</button></div>}
        {currentContent && notice && <div className="mail-notice" role="status"><span>{notice}</span>{undo && <button className="button" disabled={busy || !active} onClick={() => void undoOperation(undo)}>Undo</button>}<button aria-label="Dismiss notification" onClick={() => setNotice('')}>×</button></div>}
        {selected.size > 0 && <div className="bulk-toolbar" aria-label="Selected message actions"><strong>{selected.size} selected</strong><button className="button subtle" onClick={() => setSelected(new Map())}>Clear</button><button className="button" disabled={busy || !capabilities.canSetPersonalFlags} onClick={() => void mutate(selectedItems, { set: { read: true } })}>Read</button><button className="button" disabled={busy || !capabilities.canSetPersonalFlags} onClick={() => void mutate(selectedItems, { set: { read: false } })}>Unread</button><button className="button" disabled={busy || !capabilities.canSetPersonalFlags} onClick={() => void mutate(selectedItems, { set: { starred: true } })}>Star</button><button className="button" disabled={busy || !capabilities.canSetPersonalFlags} onClick={() => void mutate(selectedItems, { set: { starred: false } })}>Unstar</button>{capabilities.canManageMessages && <><select aria-label="Move selected messages" value="" disabled={busy} onChange={e => { if (e.target.value) void mutate(selectedItems, { set: { folder: e.target.value as MailState['folder'] } }); }}><option value="">Move to…</option><option value="inbox">Inbox</option><option value="archive">Archive</option><option value="trash">Trash</option><option value="spam">Spam</option></select><select aria-label="Label selected messages" value={actionLabel} onChange={e => setActionLabel(e.target.value)}><option value="">Choose label</option>{labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select><button className="button" disabled={!actionLabel || busy} onClick={() => void mutate(selectedItems, { addLabelIds: [actionLabel] })}>Add label</button><button className="button" disabled={!actionLabel || busy} onClick={() => void mutate(selectedItems, { removeLabelIds: [actionLabel] })}>Remove label</button></>}</div>}
        {currentContent && labelsOpen && capabilities.canManageLabels && <section className="label-manager" aria-label="Manage labels"><form onSubmit={e => { e.preventDefault(); if (labelName.trim()) void labelChange(editLabel ? 'PATCH' : 'POST', editLabel ?? undefined); }}><label htmlFor="label-name">{editLabel ? 'Rename label' : 'New label'}</label><input id="label-name" value={labelName} maxLength={80} onChange={e => setLabelName(e.target.value)} required /><button className="button" disabled={busy}>{editLabel ? 'Rename' : 'Create'}</button>{editLabel && <button className="button subtle" type="button" onClick={() => { setEditLabel(null); setLabelName(''); }}>Cancel</button>}</form>{labels.map(label => <div key={label.id}><span>{label.name}</span><button className="button subtle" onClick={() => { setEditLabel(label); setLabelName(label.name); }}>Rename</button><button className="button subtle" disabled={busy} onClick={() => { if (window.confirm(`Delete label “${label.name}”? Messages will remain.`)) void labelChange('DELETE', label); }}>Delete</button></div>)}</section>}
        {destination === 'drafts' ? <ul className="message-list draft-list">{drafts.map(draft => <li key={draft.id}><button className="message-item" disabled={busy} onClick={() => void openDraft(draft.id)}><div className="message-row"><strong>{draft.to.map(a => a.name || a.address).join(', ') || (draft.recipientCount ? 'Recipients in Cc/Bcc' : 'No recipients yet')}</strong><time>{date(draft.updatedAt)}</time></div><span className="message-subject">{draft.subject || '(No subject)'}</span><span className="message-preview">{draft.recipientCount} recipient{draft.recipientCount === 1 ? '' : 's'}</span><span className="message-status">Draft · {draft.attachmentCount} attachments</span></button></li>)}{!drafts.length && !loading && <li className="mail-empty">No saved drafts.</li>}</ul>
          : destination === 'outbox' ? <div className="outbox-list">{outbox.map(item => <article key={item.id} className="outbox-item"><div><strong>{item.subject || '(No subject)'}</strong><span className={`submission-state state-${item.state}`}>{item.state.replaceAll('_', ' ')}</span></div><p>From {item.from.address} · To {item.to.map(a => a.address).join(', ') || '(no visible To)'}</p>{item.cc.length > 0 && <p>Cc {item.cc.map(a => a.address).join(', ')}</p>}{item.bcc.length > 0 && <p>Bcc {item.bcc.map(a => a.address).join(', ')} · visible only to you</p>}{item.state === 'unknown' && <p className="composer-warning">The provider outcome is unknown. DreamPost will not resend automatically.</p>}{item.errorCode && <p role="status">{item.errorCode.replaceAll('_', ' ')}</p>}<details><summary>Recipient outcomes</summary><ul>{item.recipients.map(r => <li key={r.address}>{r.address} · {r.status}{r.code ? ` · ${r.code}` : ''}</li>)}</ul></details>{canCompose && <button className="button subtle" disabled={busy} onClick={() => void recoverSubmission(item)}>Edit as a new draft</button>}{item.state === 'queued' && <button className="button" disabled={busy || !active} onClick={() => { setBusy(true); void cancelSubmission(item, csrf).then(() => { setNotice('Queued send cancelled.'); refresh(); }).catch(f => setError(errorMessage(f))).finally(() => setBusy(false)); }}>Cancel queued send</button>}</article>)}{!outbox.length && !loading && <p className="mail-empty">No outgoing submissions.</p>}</div>
          : <><div className="list-selection-heading">{view === 'messages' && page && page.messages.length > 0 && <label><input type="checkbox" aria-label="Select loaded messages" disabled={loading} checked={page.messages.every(m => selected.has(m.id))} onChange={e => setSelected(e.target.checked ? new Map(page.messages.slice(0, 100).map(m => [m.id, m])) : new Map())} /> Select loaded</label>}<span>{view === 'messages' ? page?.messages.length ?? 0 : page?.threads.length ?? 0} loaded</span></div><ul className="message-list">
            {view === 'messages' ? page?.messages.map(message => <li key={message.id} className={`mail-list-row ${message.read ? '' : 'unread'} ${selection?.id === message.id ? 'selected' : ''}`}><input type="checkbox" aria-label={`Select ${message.subject || 'message'}`} disabled={loading} checked={selected.has(message.id)} onChange={() => toggleSelected(message)} /><button className="message-item" aria-current={selection?.id === message.id ? 'true' : undefined} onClick={() => { suppressRead.current.clear(); setSelection({ opening: ++opening.current, kind: 'message', id: message.id, message }); }}><div className="message-row"><strong dir="auto">{message.direction === 'outbound' ? message.to ? `To ${message.to}` : 'No visible To recipient' : message.from || 'Unknown sender'}</strong><time>{date(message.receivedAt)}</time></div><span className="message-subject" dir="auto">{message.subject || '(No subject)'}</span><span className="message-preview" dir="auto">{message.preview || 'No preview'}</span>{message.labelIds.length > 0 && <span className="message-labels">{message.labelIds.map(id => <span key={id}>{labels.find(l => l.id === id)?.name ?? 'Label'}</span>)}</span>}</button><button className={`star-button ${message.starred ? 'starred' : ''}`} aria-label={message.starred ? `Unstar ${message.subject}` : `Star ${message.subject}`} disabled={busy || !capabilities.canSetPersonalFlags} onClick={() => void mutate([message], { set: { starred: !message.starred } })}>{message.starred ? '★' : '☆'}</button></li>)
              : page?.threads.map(thread => <li key={thread.id}><button className={`message-item ${thread.unreadCount ? 'unread' : ''} ${selection?.id === thread.id ? 'selected' : ''}`} onClick={() => { suppressRead.current.clear(); setSelection({ opening: ++opening.current, kind: 'thread', id: thread.id, lastMessageId: thread.lastMessageId }); }}><div className="message-row"><strong>{thread.from}</strong><time>{date(thread.receivedAt)}</time></div><span className="message-subject">{thread.subject || '(No subject)'}</span><span className="message-preview">{thread.preview}</span><span className="message-status">{thread.messageCount} messages{thread.matchedCount !== thread.messageCount ? ` · ${thread.matchedCount} match` : ''}{thread.unreadCount ? ` · ${thread.unreadCount} unread` : ''}</span></button></li>)}
            {!loading && (view === 'messages' ? !page?.messages.length : !page?.threads.length) && <li className="mail-empty">{query || unread || starred || labelId ? 'No messages match these filters.' : 'This folder is empty.'}</li>}
          </ul>{page?.nextCursor && <button className="button load-more" disabled={loading} onClick={() => void more()}>Load more</button>}</>}
        {loading && <p className="list-loading" role="status">Loading…</p>}
      </section>
      {selection ? <ThreadPane key={`${mailbox.id}:${selection.kind}:${selection.id}:${selection.opening}`} mailboxId={mailbox.id} selection={selection} folder={folder} revision={revision} csrf={csrf} imagePreference={autoLoadExternalImages} attachmentConfig={attachmentConfig} capabilities={capabilities} canCompose={canCompose} selected={new Set(selected.keys())} onSelect={toggleSelected} onMutate={(messages, set) => void mutate(messages, { set })} onCompose={(mode, id, person) => void startCompose(mode, id, person)} onRead={onRead} onOpenMessage={id => suppressRead.current.delete(id)} onBack={() => setSelection(null)} /> : <section className="reading-panel empty-reader"><div className="state-panel"><h2>A little space for your mail</h2><p>Select a message or conversation. Your draft stays with you as you read.</p></div></section>}
    </main>
    {composer && <Composer key={composer.id} initial={composer} csrf={csrf} active={active && deniedAccessKey !== accessKey && accessibleMailboxIds.includes(composer.mailboxId)} outbound={outbound} onClose={() => { setComposer(null); setComposerDirty(false); onComposerState(false, false); }} onSent={submission => { setComposer(null); setComposerDirty(false); onComposerState(false, false); setDestination('outbox'); setNotice(`Message ${submission.state === 'queued' ? 'queued' : submission.state}.`); refresh(); }} onState={composerState} onSaved={refresh} />}
  </>;
}
