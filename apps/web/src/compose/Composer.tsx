import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../api';
import { MailApiError, mutationKey } from '../mailbox/api';
import { DraftSession } from './DraftSession';
import { RecipientField } from './RecipientField';
import { duplicateDraft, discardDraft, loadDraft, removeDraftAttachment, saveDraft, sendDraft, sendingIdentities, uploadDraftAttachment, type Draft, type OutboundConfig, type SendingIdentity, type Submission } from './api';

interface Props { initial: Draft; csrf: string; active: boolean; outbound?: OutboundConfig; onClose: () => void; onSent: (s: Submission) => void; onState: (open: boolean, dirty: boolean) => void; onSaved: () => void }
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
export function Composer({ initial, csrf, active, outbound, onClose, onSent, onState, onSaved }: Props) {
  const csrfRef = useRef(csrf); csrfRef.current = csrf;
  const [session] = useState(() => new DraftSession(initial, (d, fields, key, signal) => saveDraft(d.mailboxId, d.id, fields, d.version, key, csrfRef.current, signal, !!d.quote)));
  const state = useSyncExternalStore(session.subscribe, session.snapshot), { draft, fields } = state;
  const [size, setSize] = useState<'compact' | 'minimized' | 'expanded'>('compact');
  const [identities, setIdentities] = useState<SendingIdentity[]>([]); const [identityError, setIdentityError] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [quoteOpen, setQuoteOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [latest, setLatest] = useState<Draft | null>(null); const [retryVersion, setRetryVersion] = useState(0);
  const pendingAction = useRef<null | (() => Promise<void>)>(null); const mounted = useRef(0); const input = useRef<HTMLInputElement>(null);
  const dirty = state.sequence !== state.savedSequence;
  const blocked = busy || !active || state.conflict || !!pendingAction.current;
  const eligible = identities.filter(i => i.mailboxId === draft.mailboxId && i.eligible);
  const selectedEligible = eligible.some(i => i.allocationId === fields.fromAllocationId);
  const notVisible = draft.warnings.includes('reply_all_not_visible');
  const duplicatePossible = draft.warnings.includes('duplicate_delivery_possible');
  useEffect(() => { const generation = ++mounted.current; return () => { queueMicrotask(() => { if (mounted.current === generation) session.dispose(); }); }; }, [session]);
  useEffect(() => { onState(true, dirty || state.saving || busy || !!pendingAction.current); }, [dirty, state.saving, busy, retryVersion, onState]);
  useEffect(() => {
    session.configureAutosave({ enabled: !blocked, accessActive: active, authContext: csrf, onSaved });
  }, [active, blocked, csrf, onSaved, session]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty || state.saving || busy || pendingAction.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, state.saving, busy]);
  useEffect(() => { const controller = new AbortController(); sendingIdentities(controller.signal).then(value => { if (!controller.signal.aborted) { setIdentities(value); setIdentityError(''); } }).catch(f => { if (!controller.signal.aborted) setIdentityError(errorMessage(f)); }); return () => controller.abort(); }, [draft.mailboxId, csrf, active, retryVersion]);

  async function retryPending() {
    if (!pendingAction.current || busy || !active) return; setBusy(true); setError('');
    try { await pendingAction.current(); pendingAction.current = null; setRetryVersion(v => v + 1); }
    catch (failure) { setError(errorMessage(failure)); if (failure instanceof MailApiError && [400, 403, 404, 409, 413, 422].includes(failure.status ?? 0)) { pendingAction.current = null; setRetryVersion(v => v + 1); } }
    finally { setBusy(false); }
  }
  async function action(run: (base: Draft, key: string) => Promise<void>, saveFirst = true) {
    if (blocked) return; setBusy(true); setError('');
    try {
      const base = saveFirst ? await session.save() : await session.settle(), key = mutationKey();
      pendingAction.current = () => run(base, key);
      await pendingAction.current(); pendingAction.current = null; setRetryVersion(v => v + 1);
    } catch (failure) { setError(errorMessage(failure)); if (failure instanceof MailApiError && [400, 403, 404, 409, 413, 422].includes(failure.status ?? 0)) { pendingAction.current = null; setRetryVersion(v => v + 1); } }
    finally { setBusy(false); }
  }
  async function saveAndClose() { if (blocked) return; setBusy(true); try { await session.save(); onState(false, false); onSaved(); onClose(); } catch {} finally { setBusy(false); } }
  async function makeCopy() {
    if (!active || busy) return; setBusy(true); setError('');
    try {
      const copy = await duplicateDraft(draft.mailboxId, draft.id, csrf, mutationKey(), session.signal);
      const currentIdentities = await sendingIdentities(session.signal);
      const fromAllocationId = currentIdentities.some(identity => identity.eligible && identity.mailboxId === copy.mailboxId && identity.allocationId === fields.fromAllocationId) ? fields.fromAllocationId : null;
      const saved = await saveDraft(copy.mailboxId, copy.id, { ...fields, fromAllocationId }, copy.version, mutationKey(), csrf, session.signal, !!copy.quote);
      session.replaceWithLatest(saved); setLatest(null); onSaved();
      setError('');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  const status = state.conflict ? 'Conflict · edits kept here' : state.saving ? 'Saving…' : dirty ? state.retryAt ? 'Retrying save automatically…' : state.error ? 'Save failed · edits kept here' : 'Unsaved changes' : 'Saved';
  if (size === 'minimized') return <aside className="composer-minimized" aria-label="Minimized composer"><button onClick={() => setSize('compact')}><strong>{fields.subject || 'New message'}</strong><span>{status}</span></button><button aria-label="Restore composer" onClick={() => setSize('compact')}>↗</button></aside>;
  return <section className={`composer composer-${size}`} aria-label="Compose message">
    <header className="composer-header"><div><strong>{draft.mode === 'new' ? 'New message' : draft.mode === 'forward' ? 'Forward' : 'Reply'}</strong><span role="status">{status}</span></div><div className="composer-window-actions"><button aria-label="Minimize composer" onClick={() => setSize('minimized')}>−</button><button aria-label={size === 'expanded' ? 'Restore composer size' : 'Maximize composer'} onClick={() => setSize(v => v === 'expanded' ? 'compact' : 'expanded')}>{size === 'expanded' ? '↙' : '↗'}</button><button aria-label="Save and close composer" onClick={() => void saveAndClose()} disabled={blocked}>×</button></div></header>
    <div className="composer-scroll">
      {!active && <div className="error-panel" role="alert">Your session or mailbox access is unavailable. Your text is still here. <a href="/auth/login" target="_blank" rel="noopener noreferrer">Sign in in another tab</a>, then return to retry.</div>}
      {(error || state.error || identityError) && <div className="error-panel" role="alert">{error || state.error || identityError}{state.retryAt && !pendingAction.current && <p role="status">Your edits are kept in this tab. The next automatic save retry is scheduled for {new Date(state.retryAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.</p>}{pendingAction.current ? <><p>The result was not confirmed. Retry the same operation before making another change.</p><button className="button" disabled={busy || !active} onClick={() => void retryPending()}>Retry operation</button></> : !state.conflict && <button className="button" disabled={busy || !active} onClick={() => { setError(''); setRetryVersion(v => v + 1); void session.save().then(onSaved).catch(() => {}); }}>Retry save</button>}</div>}
      {state.conflict && <div className="draft-conflict" role="alert"><strong>This draft changed elsewhere.</strong><p>Your current text is preserved. Review the server version or save your text as a separate draft.</p><div className="row-actions"><button className="button" disabled={busy || !active} onClick={() => { void loadDraft(draft.mailboxId, draft.id, session.signal).then(setLatest).catch(f => setError(errorMessage(f))); }}>Review latest</button><button className="button" disabled={busy || !active} onClick={() => void makeCopy()}>Save separate copy</button><button className="button subtle" disabled={busy} onClick={() => { if (window.confirm('Close without saving your local edits? The latest server draft will remain.')) { onState(false, false); onClose(); } }}>Close without saving</button></div>{latest && <div className="draft-comparison"><strong>Latest saved version · {latest.subject || '(No subject)'}</strong><pre>{latest.bodyText}</pre><button className="button" onClick={() => { if (window.confirm('Replace your unsaved text with the latest saved draft?')) { session.replaceWithLatest(latest); setLatest(null); } }}>Use latest saved version</button></div>}</div>}
      {draft.warnings.some(warning => ['seeded_subject_adjusted', 'seeded_recipient_name_adjusted', 'inherited_fields_adjusted'].includes(warning)) && <div className="composer-notice" role="status">Some inherited subject or recipient-name characters were adjusted to make this draft editable. Review them before sending; the original message is unchanged.</div>}
      {draft.warnings.includes('recipient_review_required') && <div className="composer-warning" role="alert">An inherited recipient address needs review. Its text is preserved in the recipient chips; correct or remove it before sending.</div>}
      <div className="composer-from"><label htmlFor="compose-from">From</label><select id="compose-from" value={fields.fromAllocationId ?? ''} disabled={blocked} onChange={e => session.edit('fromAllocationId', e.target.value || null)}><option value="">Choose a sending address</option>{identities.filter(i => i.mailboxId === draft.mailboxId).map(i => <option key={i.allocationId} value={i.allocationId} disabled={!i.eligible}>{i.address ?? i.allocationId}{i.eligible ? '' : ` · ${i.reason?.replaceAll('_', ' ') ?? 'unavailable'}`}</option>)}</select></div>
      {(!fields.fromAllocationId || !selectedEligible) && <p className="composer-notice">Choose an eligible From address. An old or paused alias is never substituted silently.</p>}
      <RecipientField label="To" values={fields.to} disabled={blocked} onChange={v => { session.edit('to', v); setAcknowledged(false); }} />
      <RecipientField label="Cc" values={fields.cc} disabled={blocked} onChange={v => { session.edit('cc', v); setAcknowledged(false); }} />
      <RecipientField label="Bcc" values={fields.bcc} disabled={blocked} onChange={v => session.edit('bcc', v)} />
      <div className="composer-subject"><label htmlFor="compose-subject">Subject</label><input id="compose-subject" value={fields.subject} disabled={blocked} maxLength={998} onChange={e => session.edit('subject', e.target.value)} /></div>
      {notVisible && <div className="composer-warning"><strong>Review Reply all recipients.</strong><p>Your receiving address was not visible in To/Cc. This can happen with blind copies, lists or forwarding. Replying may reveal your participation.</p><label><input type="checkbox" checked={acknowledged} disabled={blocked} onChange={e => setAcknowledged(e.target.checked)} /> I reviewed the visible recipients and want to reply to them.</label></div>}
      {duplicatePossible && <div className="composer-warning"><strong>The earlier email may already have been sent.</strong><p>Sending this separate draft may create a duplicate. The earlier submission will not be retried.</p><label><input type="checkbox" checked={duplicateAcknowledged} disabled={blocked} onChange={event => setDuplicateAcknowledged(event.target.checked)} /> I understand this may send another copy.</label></div>}
      <textarea className="composer-body" aria-label="Message body" placeholder="Write your message…" value={fields.bodyText} readOnly={blocked} onChange={e => session.edit('bodyText', e.target.value)} />
      {draft.quote && <div className="composer-quote"><div><button className="button subtle" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(v => !v)}>{quoteOpen ? 'Hide quoted message' : 'Show quoted message'}</button><label><input type="checkbox" checked={fields.includeQuote} disabled={blocked} onChange={e => session.edit('includeQuote', e.target.checked)} /> Include quoted message</label></div>{quoteOpen && <blockquote><strong>{draft.quote.attribution.from.map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ')}</strong><span>{draft.quote.attribution.subject}</span><pre>{draft.quote.text}</pre></blockquote>}</div>}
      {draft.attachments.length > 0 && <ul className="compose-attachments" aria-label="Draft attachments">{draft.attachments.map(file => <li key={file.id}><span><strong>{file.filename}</strong><small>{sizeLabel(file.sizeBytes)}</small></span><button className="button subtle" aria-label={`Remove attachment ${file.filename}`} disabled={blocked} onClick={() => void action(async (base, key) => { session.acceptAction(await removeDraftAttachment(base, file.id, csrfRef.current, key, session.signal)); onSaved(); })}>×</button></li>)}</ul>}

    </div>
    <footer className="composer-footer"><div className="row-actions"><button className="button primary" disabled={blocked || !outbound?.enabled || !selectedEligible || notVisible && !acknowledged || duplicatePossible && !duplicateAcknowledged} onClick={() => void action(async (base, key) => { const submission = await sendDraft(base, csrfRef.current, key, acknowledged, session.signal, duplicateAcknowledged); onState(false, false); onSent(submission); })}>{busy ? 'Working…' : 'Send'}</button><button className="button" disabled={blocked} onClick={() => input.current?.click()}>Attach file</button><input ref={input} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (outbound?.maxAttachmentBytes && file.size > outbound.maxAttachmentBytes) { setError(`The attachment limit is ${sizeLabel(outbound.maxAttachmentBytes)}. No sharing link was created.`); return; } void action(async (base, key) => { session.acceptAction(await uploadDraftAttachment(base, file, csrfRef.current, key, session.signal)); onSaved(); }); }} /><button className="button subtle" disabled={blocked} onClick={() => { void session.save().then(onSaved).catch(() => {}); }}>Save</button></div><button className="button subtle" disabled={busy || !active || state.conflict || !!pendingAction.current} onClick={() => { if (!window.confirm('Discard this draft and its unsent changes?')) return; void action(async (base, key) => { await discardDraft(base, csrfRef.current, key, session.signal); onState(false, false); onSaved(); onClose(); }, false); }}>Discard</button></footer>
    {outbound?.enabled && outbound.maxMessageBytes && <p className="composer-disabled-note">Complete message limit: {sizeLabel(outbound.maxMessageBytes)}, including encoded attachments and quoted text.</p>}
    {!outbound?.enabled && <p className="composer-disabled-note">Sending is not configured. You can write, attach files and save drafts.</p>}
  </section>;
}
