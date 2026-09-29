import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, sessionRequest } from './api';
import type { UserSession } from './SsoWorkspace';
import type { AddressView, RequestView } from './address-types';

/** Console entry is a presentation boundary; API capabilities remain authoritative. */
export function canOpenPostmaster(session: UserSession): boolean {
  return session.actor?.permissions.includes('addresses.manage') === true;
}
export function PostmasterWorkspace({ session, onBack, onChanged, active = true }: { session: UserSession; active?: boolean; onBack: () => void; onChanged: () => void }) {
  const [section, setSection] = useState<'overview' | 'addresses'>('overview');
  const canManageAddresses = session.actor?.permissions.includes('addresses.manage') === true;
  const allowed = active && canOpenPostmaster(session);
  return <div className="postmaster-shell">
    <header className="app-header postmaster-header"><div className="brand">DreamPost <span className="console-badge">Postmaster</span></div><div className="header-actions"><span className="console-user">{session.profile?.display_name || session.actor?.username}</span><button className="button" onClick={onBack}>Back to mail</button></div></header>
    {!allowed ? <main className="settings-page page-enter"><h1>Administrative access required</h1><p>{active ? 'Your account does not have access to this console.' : 'Sign in again to continue using this console.'}</p><button className="button primary" onClick={onBack}>Return to mail</button></main> : <div className="console-layout">
      <aside className="console-sidebar"><p className="sidebar-label">Administration</p><nav aria-label="Postmaster"><button className={`folder-button ${section === 'overview' ? 'active' : ''}`} aria-current={section === 'overview' ? 'page' : undefined} onClick={() => setSection('overview')}>Overview</button>{canManageAddresses && <button className={`folder-button ${section === 'addresses' ? 'active' : ''}`} aria-current={section === 'addresses' ? 'page' : undefined} onClick={() => setSection('addresses')}>Addresses</button>}</nav><p className="console-note">Manage the mail service here. Personal preferences stay in your mailbox.</p></aside>
      {section === 'addresses' && canManageAddresses ? <AdminAddresses key={session.actor!.principalId} session={session} onChanged={onChanged} /> : <main className="settings-page page-enter" key="overview"><div className="settings-heading"><div><p className="eyebrow">Mail service administration</p><h1>Postmaster</h1><p>Manage shared service resources separately from your personal mailbox.</p></div></div>{canManageAddresses && <button className="console-section-card" onClick={() => setSection('addresses')}><strong>Addresses</strong><span>Review requests, assign addresses and manage receiving and sending availability.</span><span aria-hidden="true">Open addresses →</span></button>}<section className="settings-card"><h2>Administrative access</h2><p>Administrative permissions do not automatically grant access to mailbox contents or permission to send as another address.</p><ul className="console-capabilities">{session.actor!.permissions.filter(permission => permission === 'addresses.manage').map(permission => <li key={permission}>Address administration</li>)}</ul></section></main>}
    </div>}
  </div>;
}
function AdminAddresses({ session, onChanged }: { session: UserSession; onChanged: () => void }) {
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged;
  const readController = useRef<AbortController | null>(null), readEpoch = useRef(0);
  useEffect(() => () => { readEpoch.current++; readController.current?.abort(); }, []);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [adminAddresses, setAdminAddresses] = useState<AddressView[]>([]);
  const [adminMailboxes, setAdminMailboxes] = useState<Array<{ id: string; name: string; ownerUsername: string | null }>>([]);
  const [targetMailbox, setTargetMailbox] = useState('');
  const [adminCandidate, setAdminCandidate] = useState('');
  const [allocationAction, setAllocationAction] = useState<'add' | 'reactivate' | 'reassign'>('add');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const clearUnauthorized = useCallback(() => {
    readEpoch.current++; readController.current?.abort();
    setRequests([]); setAdminAddresses([]); setAdminMailboxes([]); setTargetMailbox(''); setNotice(''); setLoading(false); setLoaded(false);
    onChangedRef.current();
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    const generation = ++readEpoch.current;
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    setLoading(true);
    try {
      const [managed, targets, pending] = await Promise.all([
        sessionRequest<{ addresses: AddressView[] }>('/api/admin/addresses', { signal: activeSignal }),
        sessionRequest<{ mailboxes: Array<{ id: string; name: string; ownerUsername: string | null }> }>('/api/admin/mailboxes', { signal: activeSignal }),
        sessionRequest<{ requests: RequestView[] }>('/api/admin/address-requests', { signal: activeSignal }),
      ]);
      if (activeSignal.aborted || generation !== readEpoch.current) return;
      setRequests(pending.requests.filter(request => request.status === 'pending')); setError(''); setLoaded(true);
      setAdminAddresses(managed.addresses); setAdminMailboxes(targets.mailboxes);
      setTargetMailbox(previous => targets.mailboxes.some(mailbox => mailbox.id === previous) ? previous : targets.mailboxes[0]?.id ?? '');
    } catch (failure) {
      if (!activeSignal.aborted && generation === readEpoch.current) {
        setRequests([]); setAdminAddresses([]); setAdminMailboxes([]); setTargetMailbox(''); setError(errorMessage(failure)); setLoaded(false);
        if (failure instanceof ApiError && [401, 403].includes(failure.status ?? 0)) clearUnauthorized();
      }
    } finally { if (!activeSignal.aborted && generation === readEpoch.current) setLoading(false); }
  }, [clearUnauthorized]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  async function mutate(path: string, body: unknown, method = 'POST', message = 'Change saved. Receiving changes may still be syncing.') {
    if (!session.csrfToken) return;
    setBusy(true); setError(''); setNotice('');
    try { await sessionRequest(path, { method, body, csrfToken: session.csrfToken }); setNotice(message); await refresh(); onChanged(); }
    catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && [401, 403].includes(failure.status ?? 0)) {
        clearUnauthorized();
      }
    }
    finally { setBusy(false); }
  }
  async function addAddress(event: FormEvent) {
    event.preventDefault(); const suffix = allocationAction === 'add' ? '' : `/${allocationAction}`;
    await mutate(`/api/admin/addresses${suffix}`, { address: adminCandidate, mailboxId: targetMailbox });
  }
  return <main className="settings-page page-enter">
    <div className="settings-heading"><div><p className="eyebrow">Postmaster</p><h1>Addresses</h1><p>Manage address assignments and availability across mailboxes.</p></div><button className="button subtle" disabled={busy || loading} onClick={() => void refresh()}>Refresh</button></div>
    {error && <div className="error-panel" role="alert">{error}</div>}{notice && <p className="notice-panel" role="status">{notice}</p>}
    {loading && <p role="status">Loading address administration…</p>}
    {!loading && loaded && <section className="settings-card"><h2>Address requests</h2>{requests.length === 0 ? <p>No pending requests.</p> : <ul className="address-list">{requests.map(request => <li key={request.id}><div><strong>{request.address}</strong>{request.requesterName && <span>{request.requesterName}</span>}</div><div className="row-actions"><button className="button primary" disabled={busy} onClick={() => void mutate(`/api/admin/address-requests/${request.id}/approve`, {})}>Approve</button><button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/admin/address-requests/${request.id}/reject`, {})}>Reject</button></div></li>)}</ul>}</section>}
    {!loading && loaded && <section className="settings-card"><h2>Manage addresses</h2><form className="address-request-form admin-address-form" onSubmit={addAddress}>
      <label htmlFor="target-mailbox">Mailbox</label><select id="target-mailbox" value={targetMailbox} onChange={event => setTargetMailbox(event.target.value)} required>{adminMailboxes.map(mailbox => <option key={mailbox.id} value={mailbox.id}>{mailbox.name}{mailbox.ownerUsername ? ` (${mailbox.ownerUsername})` : ''}</option>)}</select>
      <label htmlFor="allocation-action">Action</label><select id="allocation-action" value={allocationAction} onChange={event => setAllocationAction(event.target.value as typeof allocationAction)}><option value="add">Add address</option><option value="reactivate">Reactivate a former address</option><option value="reassign">Reassign a retired address</option></select>
      <label htmlFor="admin-address">Address</label><div><input id="admin-address" type="email" value={adminCandidate} onChange={event => setAdminCandidate(event.target.value)} required placeholder="name@example.com" /><button className="button primary" disabled={busy || !targetMailbox}>Apply</button></div>
      <p className="field-help">Reassignment directs future mail to the selected mailbox. Previous messages remain in their original mailbox.</p>
    </form><ul className="address-list admin-address-list">{adminAddresses.map(address => <li key={address.allocationId}><div><strong>{address.address}</strong><span>{address.mailboxName}{address.ownerUsername ? ` · ${address.ownerUsername}` : ''}</span><span>{!address.current ? 'Removed' : address.adminPaused ? 'Administrator pause' : address.ownerPaused ? 'Owner pause' : address.systemPaused ? 'Policy pause' : address.policyStatus === 'blocked' ? 'Sync blocked · configuration needs attention' : !address.policyAcknowledged ? 'Sync pending' : address.receiveOnly ? 'Receive only' : 'Enabled'}</span></div>{address.current && <div className="row-actions"><button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/admin/addresses/${address.allocationId}/admin-pause`, { paused: !address.adminPaused }, 'PUT')}>{address.adminPaused ? 'Clear admin pause' : 'Admin pause'}</button><button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/admin/addresses/${address.allocationId}/receive-only`, { receiveOnly: !address.receiveOnly }, 'PUT')}>{address.receiveOnly ? 'Allow sending' : 'Receive only'}</button><button className="button subtle" disabled={busy} onClick={() => { if (window.confirm(`Remove ${address.address}? Its message history will remain in the mailbox.`)) void mutate(`/api/admin/addresses/${address.allocationId}/remove`, {}); }}>Remove</button></div>}</li>)}</ul></section>}
  </main>;
}
