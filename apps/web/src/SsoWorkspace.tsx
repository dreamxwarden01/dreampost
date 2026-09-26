import { useCallback, useEffect, useState, useRef } from 'react';
import { Inbox } from './App';
import { errorMessage, getMailboxes, sessionRequest, type Mailbox } from './api';
import { AddressSettings } from './AddressSettings';

export interface UserSession {
  actor: { principalId: string; username: string; roleId: number; permissions: string[] } | null;
  csrfToken: string | null;
  profile: { display_name?: string; email?: string | null } | null;
  accountPortalUrl: string | null;
  catalog: { configured?: boolean; syncedAt: string | null };
}

export function SsoWorkspace() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'inbox' | 'addresses'>('inbox');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const navigating = useRef(false);
  const profileRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!profileOpen) return;
    const click = (event: PointerEvent) => { if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setProfileOpen(false); };
    document.addEventListener('pointerdown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', click); document.removeEventListener('keydown', key); };
  }, [profileOpen]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (navigating.current) return;
    try {
      const current = await sessionRequest<UserSession>('/auth/session', { signal });
      if (signal?.aborted) return;
      setSession(current);
      if (!current.actor) {
        setMailboxes([]); setSelected(''); setError('');
        if (current.catalog.syncedAt && !navigating.current) {
          navigating.current = true;
          setRedirecting(true);
          window.location.replace('/auth/login');
        }
        return;
      }
      if (!current.actor.permissions.includes('mailbox.use')) { setMailboxes([]); setSelected(''); setView('addresses'); setError(''); return; }
      const boxes = await getMailboxes(signal ?? new AbortController().signal);
      if (signal?.aborted) return;
      setMailboxes(boxes);
      if (boxes.length && !boxes[0]?.address) setView('addresses');
      setSelected(previous => boxes.some(box => box.id === previous) ? previous : boxes[0]?.id ?? '');
      setError('');
    } catch (failure) { if (!signal?.aborted) { navigating.current = false; setRedirecting(false); setError(errorMessage(failure)); } }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
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
    try {
      const result = await sessionRequest<{ logoutUrl: string }>('/auth/logout', { method: 'POST', csrfToken: session.csrfToken });
      navigating.current = true; setRedirecting(true);
      setSession(null); setMailboxes([]); setSelected('');
      window.location.assign(result.logoutUrl);
    } catch (failure) { navigating.current = false; setRedirecting(false); setError(errorMessage(failure)); }
  }
  if (redirecting) return <main className="connection-page"><section className="connection-card"><h1>DreamPost</h1><p role="status">Redirecting to DreamSSO…</p></section></main>;
  if (loading) return <main className="connection-page"><section className="connection-card"><h1>DreamPost</h1><p>Loading your account…</p></section></main>;
  if (!session?.actor) return <main className="connection-page"><section className="connection-card"><p className="eyebrow">Local mail, in your hands</p><h1>{error ? 'Unable to sign you in' : 'Sign-in is not ready'}</h1>{error ? <p className="error-panel" role="alert">{error}</p> : <p role="status">Your administrator needs to finish connecting DreamSSO.</p>}<button className="button primary" onClick={() => void reload()}>Try again</button></section></main>;
  const mailbox = mailboxes.find(item => item.id === selected);
  const name = session.profile?.display_name || session.actor.username;
  const accountUrl = session.accountPortalUrl && /^https?:\/\//.test(session.accountPortalUrl) ? session.accountPortalUrl : null;
  return <div className="app-shell">
    <header className="app-header"><div className="brand">DreamPost</div><nav className="workspace-tabs" aria-label="Workspace"><button className={`button subtle ${view === 'inbox' ? 'selected-tab' : ''}`} disabled={!session.actor.permissions.includes('mailbox.use')} onClick={() => setView('inbox')}>Mail</button><button className={`button subtle ${view === 'addresses' ? 'selected-tab' : ''}`} onClick={() => setView('addresses')}>Addresses</button></nav><div className="header-actions">
      {mailboxes.length > 1 && <select aria-label="Mailbox" value={selected} onChange={event => setSelected(event.target.value)}>{mailboxes.map(box => <option key={box.id} value={box.id}>{box.name}</option>)}</select>}
      <div className="profile-entry" ref={profileRef}><button className="profile-button" aria-label="Account menu" aria-expanded={profileOpen} onClick={() => setProfileOpen(value => !value)}>{name.slice(0, 1).toUpperCase()}</button>{profileOpen && <div className="profile-popover" onKeyDown={event => { if (event.key === 'Escape') setProfileOpen(false); }}><strong>{name}</strong>{session.profile?.email && <span>{session.profile.email}</span>}{accountUrl && <a href={accountUrl} target="_blank" rel="noreferrer">View account</a>}<button className="button subtle" onClick={() => void logout()}>Sign out</button></div>}</div>
    </div></header>
    {error && <div className="error-panel" role="alert">{error}<button className="text-button" onClick={() => void reload()}>Refresh session</button></div>}
    {view === 'addresses' ? <AddressSettings session={session} onChanged={() => void reload()} /> : mailbox ? <Inbox key={mailbox.id} session={{ token: '', mailbox }} /> : <main className="settings-page"><h1>Your mailbox</h1><p>No mailbox is available yet. Open Addresses to review your access or request an address.</p><button className="button primary" onClick={() => setView('addresses')}>Manage addresses</button></main>}
  </div>;
}
