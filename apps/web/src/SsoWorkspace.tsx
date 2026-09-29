import { useCallback, useEffect, useState, useRef } from 'react';
import { Inbox } from './App';
import { MailboxWorkspace } from './mailbox/MailboxWorkspace';
import type { OutboundConfig } from './compose/api';
import { errorMessage, getMailboxes, getReadingPreferences, sessionRequest, type Mailbox, type ReadingPreferences } from './api';
import { AddressSettings } from './AddressSettings';
import { ReadingSettings } from './ReadingSettings';
import { PostmasterWorkspace, canOpenPostmaster } from './PostmasterWorkspace';
import { MotionPresence } from './MotionPresence';
import { workspacePaths, workspaceView, type WorkspaceView } from './workspace-navigation';
import { clearAttachmentAccessCache, type AttachmentConfig } from './attachments/api';

export interface UserSession {
  actor: { principalId: string; username: string; roleId: number; permissions: string[] } | null;
  csrfToken: string | null;
  profile: { display_name?: string; email?: string | null } | null;
  accountPortalUrl: string | null;
  catalog: { configured?: boolean; syncedAt: string | null };
}

export function SsoWorkspace({ attachmentConfig, everydayMail = false, outbound }: { attachmentConfig?: AttachmentConfig; everydayMail?: boolean; outbound?: OutboundConfig }) {
  const [session, setSession] = useState<UserSession | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const composerOpen = useRef(false), composerDirty = useRef(false);
  const [hasComposer, setHasComposer] = useState(false);
  const lastMailbox = useRef<Mailbox | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const onComposerState = useCallback((open: boolean, dirty: boolean) => { composerOpen.current = open; composerDirty.current = dirty; setHasComposer(open); }, []);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<WorkspaceView>(() => workspaceView(window.location.pathname));
  const viewRef = useRef(view); viewRef.current = view;
  const navigate = useCallback((next: WorkspaceView, replace = false) => {
    const path = workspacePaths[next];
    if (window.location.pathname !== path) window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setView(next); setProfileOpen(false);
  }, []);
  useEffect(() => {
    const restore = () => { setView(workspaceView(window.location.pathname)); setProfileOpen(false); };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const navigating = useRef(false);
  const reloadController = useRef<AbortController | null>(null);
  const preferenceController = useRef<AbortController | null>(null);
  const preferencePrincipal = useRef<string | null>(null);
  const [preferences, setPreferences] = useState<ReadingPreferences | null>(null);
  const [preferenceError, setPreferenceError] = useState('');
  const reloadPreferences = useCallback(async (principalId: string) => {
    preferenceController.current?.abort();
    const controller = new AbortController(); preferenceController.current = controller;
    try {
      const result = await getReadingPreferences(controller.signal);
      if (!controller.signal.aborted && preferencePrincipal.current === principalId) { setPreferences(result); setPreferenceError(''); }
    } catch (failure) {
      if (!controller.signal.aborted && preferencePrincipal.current === principalId) { setPreferences(null); setPreferenceError(errorMessage(failure)); }
    }
  }, []);
  useEffect(() => () => { reloadController.current?.abort(); preferenceController.current?.abort(); }, []);
  const profileRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!profileOpen) return;
    const click = (event: PointerEvent) => { if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setProfileOpen(false); profileRef.current?.querySelector<HTMLButtonElement>('.profile-button')?.focus(); } };
    document.addEventListener('pointerdown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', click); document.removeEventListener('keydown', key); };
  }, [profileOpen]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (navigating.current) return;
    reloadController.current?.abort();
    const controller = new AbortController(); reloadController.current = controller;
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const current = await sessionRequest<UserSession>('/auth/session', { signal: activeSignal });
      if (activeSignal.aborted) return;
      const principalId = current.actor?.principalId ?? null;
      if (!current.actor && composerOpen.current && sessionRef.current?.actor) {
        setSessionExpired(true); setError('Your session expired. The open draft is preserved in this tab. Sign in in another tab, then refresh your session.'); return;
      }
      setSessionExpired(false);
      if (preferencePrincipal.current !== principalId) {
        preferenceController.current?.abort(); setPreferences(null); setPreferenceError('');
        composerOpen.current = false; composerDirty.current = false; setHasComposer(false); lastMailbox.current = null;
        if (preferencePrincipal.current !== null) clearAttachmentAccessCache();
        setMailboxes([]); setSelected('');
        preferencePrincipal.current = principalId;
      }
      setSession(current);
      if (!current.actor) {
        clearAttachmentAccessCache();
        setMailboxes([]); setSelected(''); setError('');
        if (current.catalog.syncedAt && !navigating.current) {
          navigating.current = true;
          setRedirecting(true);
          window.location.replace(`/auth/login?returnTo=${encodeURIComponent(workspacePaths[viewRef.current])}`);
        }
        return;
      }
      void reloadPreferences(current.actor.principalId);
      if (!current.actor.permissions.includes('mailbox.use')) { setMailboxes([]); setSelected(''); if (viewRef.current === 'inbox') navigate('reading', true); setError(''); return; }
      const boxes = await getMailboxes(activeSignal);
      if (activeSignal.aborted) return;
      setMailboxes(boxes);
      if (boxes.length && !boxes[0]?.address && viewRef.current === 'inbox') navigate('addresses', true);
      setSelected(previous => boxes.some(box => box.id === previous) ? previous : boxes[0]?.id ?? '');
      setError('');
    } catch (failure) { if (!activeSignal.aborted) { navigating.current = false; setRedirecting(false); setError(errorMessage(failure)); } }
    finally { if (!activeSignal.aborted) setLoading(false); }
  }, [reloadPreferences, navigate]);
  useEffect(() => {
    const controller = new AbortController(); void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    const onFocus = () => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  async function logout() {
    if (!session?.csrfToken) return;
    if (composerDirty.current && !window.confirm('Sign out with unsaved draft changes? Only the last saved version will be recoverable.')) return;
    try {
      const result = await sessionRequest<{ logoutUrl: string }>('/auth/logout', { method: 'POST', csrfToken: session.csrfToken });
      navigating.current = true; setRedirecting(true);
      reloadController.current?.abort(); preferenceController.current?.abort(); preferencePrincipal.current = null;
      setSession(null); setMailboxes([]); setSelected(''); setPreferences(null); clearAttachmentAccessCache();
      window.location.assign(result.logoutUrl);
    } catch (failure) { navigating.current = false; setRedirecting(false); setError(errorMessage(failure)); }
  }
  if (redirecting) return <main className="connection-page"><section className="connection-card"><h1>DreamPost</h1><p role="status">Redirecting to DreamSSO…</p></section></main>;
  if (loading) return <main className="connection-page"><section className="connection-card"><h1>DreamPost</h1><p>Loading your account…</p></section></main>;
  if (!session?.actor) return <main className="connection-page"><section className="connection-card"><p className="eyebrow">Local mail, in your hands</p><h1>{error ? 'Unable to sign you in' : 'Sign-in is not ready'}</h1>{error ? <p className="error-panel" role="alert">{error}</p> : <p role="status">Your administrator needs to finish connecting DreamSSO.</p>}<button className="button primary" onClick={() => void reload()}>Try again</button></section></main>;
  const mailbox = mailboxes.find(item => item.id === selected);
  if (mailbox) lastMailbox.current = mailbox;
  const workspaceMailbox = mailbox ?? (hasComposer ? lastMailbox.current : null);
  const name = session.profile?.display_name || session.actor.username;
  const accountUrl = session.accountPortalUrl && /^https?:\/\//.test(session.accountPortalUrl) ? session.accountPortalUrl : null;
  const inConsole = view === 'postmaster';
  const inSettings = view === 'reading' || view === 'addresses';
  return <div className={`app-shell ${inConsole ? 'admin-workspace' : 'personal-workspace'}`}>
    {!inConsole && <header className="app-header"><div className="brand">DreamPost</div><nav className="workspace-tabs" aria-label="Workspace"><button className={`button subtle ${view === 'inbox' ? 'selected-tab' : ''}`} aria-current={view === 'inbox' ? 'page' : undefined} disabled={!session.actor.permissions.includes('mailbox.use')} onClick={() => navigate('inbox')}>Mail</button><button className={`button subtle ${inSettings ? 'selected-tab' : ''}`} aria-current={inSettings ? 'page' : undefined} onClick={() => navigate('reading')}>Settings</button></nav><div className="header-actions">
      {mailboxes.length > 1 && <select aria-label="Mailbox" value={selected} onChange={event => setSelected(event.target.value)}>{mailboxes.map(box => <option key={box.id} value={box.id}>{box.name}</option>)}</select>}
      <div className="profile-entry" ref={profileRef}><button className="profile-button" aria-label="Account menu" aria-expanded={profileOpen} onClick={() => setProfileOpen(value => !value)}>{name.slice(0, 1).toUpperCase()}</button><MotionPresence open={profileOpen} className="profile-presence"><div className="profile-popover"><strong>{name}</strong>{session.profile?.email && <span>{session.profile.email}</span>}{accountUrl && <a href={accountUrl} target="_blank" rel="noreferrer">View account</a>}<button className="button subtle" onClick={() => navigate('reading')}>Personal settings</button><button className="button subtle" onClick={() => void logout()}>Sign out</button></div></MotionPresence></div>
    </div></header>}
    {error && <div className="error-panel" role="alert">{error}<button className="text-button" onClick={() => void reload()}>Refresh session</button></div>}
    {inConsole ? <PostmasterWorkspace key={session.actor.principalId} active={!sessionExpired} session={session} onBack={() => navigate(session.actor!.permissions.includes('mailbox.use') ? 'inbox' : 'reading')} onChanged={() => void reload()} /> : inSettings ? <div className="personal-settings-layout page-enter">
      <aside className="settings-sidebar"><p className="sidebar-label">Personal settings</p><nav aria-label="Personal settings"><button className={`folder-button ${view === 'reading' ? 'active' : ''}`} aria-current={view === 'reading' ? 'page' : undefined} onClick={() => navigate('reading')}>Reading</button><button className={`folder-button ${view === 'addresses' ? 'active' : ''}`} aria-current={view === 'addresses' ? 'page' : undefined} onClick={() => navigate('addresses')}>Addresses</button></nav>{canOpenPostmaster(session) && <div className="administration-entry"><p>Administration</p><button className="button" onClick={() => navigate('postmaster')}>Open Postmaster <span aria-hidden="true">↗</span></button><small>Open the separate mail service console.</small></div>}</aside>
      {view === 'reading' ? <ReadingSettings key={session.actor.principalId} preferences={preferences} csrfToken={session.csrfToken ?? ''} error={preferenceError} onReload={() => void reloadPreferences(session.actor!.principalId)} onChanged={value => { preferenceController.current?.abort(); setPreferences(value); setPreferenceError(''); }} /> : <AddressSettings key={session.actor.principalId} session={session} onChanged={() => void reload()} />}
    </div> : mailbox ? everydayMail ? null : <Inbox key={`${session.actor.principalId}:${mailbox.id}`} session={{ token: '', mailbox, csrfToken: session.csrfToken ?? undefined }} attachmentConfig={attachmentConfig} autoLoadExternalImages={preferences?.autoLoadExternalImages ?? false} /> : <main className="settings-page page-enter"><h1>Your mailbox</h1><p>No mailbox is available yet. Open your address settings to review your access or request an address.</p><button className="button primary" onClick={() => navigate('addresses')}>Manage addresses</button></main>}
    <div className="mail-workspace-host" hidden={inConsole}>
      {everydayMail && workspaceMailbox && <MailboxWorkspace key={session.actor.principalId} mailbox={workspaceMailbox} accessibleMailboxIds={mailboxes.map(box => box.id)} csrf={session.csrfToken ?? ''} permissions={session.actor.permissions} active={!sessionExpired && !!mailbox} visible={view === 'inbox' && !!mailbox} outbound={outbound} attachmentConfig={attachmentConfig} autoLoadExternalImages={preferences?.autoLoadExternalImages ?? false} onComposerState={onComposerState} />}
    </div>
  </div>;
}
