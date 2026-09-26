import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errorMessage, sessionRequest } from './api';
import type { UserSession } from './SsoWorkspace';

interface AddressView {
  allocationId: string; address: string; ownerPaused: boolean; adminPaused: boolean;
  receiveOnly: boolean; current: boolean; systemPaused: boolean; policyAcknowledged: boolean;
  receiveEnabled: boolean; mailboxId: string; mailboxName?: string; ownerUsername?: string | null;
  policyStatus?: string; policyError?: string | null;
}
interface RequestView { id: string; address: string; status: string; requesterName?: string; }
interface AddressesResponse {
  mailbox: { id: string; provisioning_status: string } | null;
  addresses: AddressView[];
  requests: RequestView[];
}
export function AddressSettings({ session, onChanged }: { session: UserSession; onChanged: () => void }) {
  const [data, setData] = useState<AddressesResponse | null>(null);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [candidate, setCandidate] = useState('');
  const [eligible, setEligible] = useState<Set<string>>(new Set());
  const [adminAddresses, setAdminAddresses] = useState<AddressView[]>([]);
  const [adminMailboxes, setAdminMailboxes] = useState<Array<{ id: string; name: string; ownerUsername: string | null }>>([]);
  const [targetMailbox, setTargetMailbox] = useState('');
  const [adminCandidate, setAdminCandidate] = useState('');
  const [allocationAction, setAllocationAction] = useState<'add' | 'reactivate' | 'reassign'>('add');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const admin = session.actor?.permissions.includes('addresses.manage') === true;
  const mailboxUser = session.actor?.permissions.includes('mailbox.use') === true;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = mailboxUser ? await sessionRequest<AddressesResponse>('/api/addresses', { signal }) : { mailbox: null, addresses: [], requests: [] };
      const senders = mailboxUser ? await sessionRequest<{ identities: Array<{ allocationId: string; eligible: boolean }> }>('/api/sending-identities', { signal }) : { identities: [] };
      const managed = admin ? await sessionRequest<{ addresses: AddressView[] }>('/api/admin/addresses', { signal }) : { addresses: [] };
      const targets = admin ? await sessionRequest<{ mailboxes: Array<{ id: string; name: string; ownerUsername: string | null }> }>('/api/admin/mailboxes', { signal }) : { mailboxes: [] };
      const pending = admin ? await sessionRequest<{ requests: RequestView[] }>('/api/admin/address-requests', { signal }) : { requests: [] };
      if (signal?.aborted) return;
      setData(result); setRequests(pending.requests.filter(request => request.status === 'pending')); setError('');
      setEligible(new Set(senders.identities.filter(identity => identity.eligible).map(identity => identity.allocationId)));
      setAdminAddresses(managed.addresses); setAdminMailboxes(targets.mailboxes);
      setTargetMailbox(previous => targets.mailboxes.some(mailbox => mailbox.id === previous) ? previous : targets.mailboxes[0]?.id ?? '');
    } catch (failure) { if (!signal?.aborted) setError(errorMessage(failure)); }
  }, [admin, mailboxUser]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  async function mutate(path: string, body: unknown, method = 'POST', message = 'Change saved. Receiving changes may still be syncing.') {
    if (!session.csrfToken) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await sessionRequest(path, { method, body, csrfToken: session.csrfToken });
      setNotice(message); await refresh(); onChanged();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function requestAddress(event: FormEvent) {
    event.preventDefault();
    await mutate('/api/address-requests', { address: candidate }, 'POST', 'Address request submitted for administrator approval.');
  }
  function state(address: AddressView) {
    if (!address.current) return 'Removed · history retained';
    if (address.adminPaused) return 'Paused by administrator';
    if (address.systemPaused) return 'Paused by policy';
    if (address.ownerPaused) return 'Paused by you';
    if (address.policyStatus === 'blocked') return 'Receiving sync needs administrator attention';
    if (!address.policyAcknowledged) return 'Activation pending';
    return address.receiveOnly || !eligible.has(address.allocationId) ? 'Receive only' : 'Active';
  }
  async function addAddress(event: FormEvent) {
    event.preventDefault();
    const suffix = allocationAction === 'add' ? '' : `/${allocationAction}`;
    await mutate(`/api/admin/addresses${suffix}`, { address: adminCandidate, mailboxId: targetMailbox });
  }
  const visibleAddresses = [...new Map((data?.addresses ?? []).filter(address => address.current
    || !(data?.addresses ?? []).some(other => other.current && other.address === address.address)).map(address => [address.address, address])).values()];
  return <main className="settings-page">
    <div className="settings-heading"><div><p className="eyebrow">One mailbox, your addresses</p><h1>Addresses</h1><p>All your personal addresses share the same mailbox and message history.</p></div><button className="button subtle" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
    {error && <div className="error-panel" role="alert">{error}</div>}{notice && <p className="notice-panel" role="status">{notice}</p>}
    {data?.mailbox?.provisioning_status === 'needs_address' && <div className="notice-panel">Your username-based address could not be assigned. Request another address below; an administrator will review it.</div>}
    {mailboxUser && <section className="settings-card" aria-labelledby="my-addresses"><h2 id="my-addresses">Your addresses</h2>{!data ? <p>Loading addresses…</p> : data.addresses.length === 0 ? <p>No addresses have been assigned yet.</p> : <ul className="address-list">{visibleAddresses.map(address => <li key={address.allocationId}><div><strong>{address.address}</strong><span>{state(address)}</span>{!address.policyAcknowledged && (address.ownerPaused || address.adminPaused) && <small>Sending is blocked. Receiving update is syncing.</small>}</div>{!address.current && <button className="button subtle" disabled={busy} onClick={() => void mutate('/api/address-requests', { address: address.address, action: 'reactivate' }, 'POST', 'Reactivation requested. An administrator must approve it.')}>Request reactivation</button>}{address.current && <button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/addresses/${address.allocationId}/owner-pause`, { paused: !address.ownerPaused }, 'PUT')}>{address.ownerPaused ? 'Resume address' : 'Pause address'}</button>}</li>)}</ul>}<p className="field-help">Pausing blocks both receiving and sending. Your address and existing messages stay yours.</p></section>}
    {mailboxUser && <section className="settings-card"><h2>Request an address</h2><form className="address-request-form" onSubmit={requestAddress}><label htmlFor="new-address">Email address</label><div><input id="new-address" type="email" autoComplete="off" value={candidate} onChange={event => setCandidate(event.target.value)} placeholder="name@example.com" required disabled={busy} /><button className="button primary" disabled={busy}>Submit request</button></div></form><p className="field-help">An administrator must approve additional addresses before they become available.</p>{data && data.requests.length > 0 && <ul className="request-list">{data.requests.map(request => <li key={request.id}><span>{request.address}</span><span className="message-status">{request.status.replaceAll('_', ' ')}</span></li>)}</ul>}</section>}
    {admin && <section className="settings-card"><h2>Postmaster · address requests</h2>{requests.length === 0 ? <p>No pending requests.</p> : <ul className="address-list">{requests.map(request => <li key={request.id}><div><strong>{request.address}</strong>{request.requesterName && <span>{request.requesterName}</span>}</div><div className="row-actions"><button className="button primary" disabled={busy} onClick={() => void mutate(`/api/admin/address-requests/${request.id}/approve`, {})}>Approve</button><button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/admin/address-requests/${request.id}/reject`, {})}>Reject</button></div></li>)}</ul>}</section>}
    {admin && <section className="settings-card"><h2>Postmaster · manage addresses</h2><form className="address-request-form admin-address-form" onSubmit={addAddress}>
      <label htmlFor="target-mailbox">Mailbox</label><select id="target-mailbox" value={targetMailbox} onChange={event => setTargetMailbox(event.target.value)} required>{adminMailboxes.map(mailbox => <option key={mailbox.id} value={mailbox.id}>{mailbox.name}{mailbox.ownerUsername ? ` (${mailbox.ownerUsername})` : ''}</option>)}</select>
      <label htmlFor="allocation-action">Action</label><select id="allocation-action" value={allocationAction} onChange={event => setAllocationAction(event.target.value as typeof allocationAction)}><option value="add">Add address</option><option value="reactivate">Reactivate a former address</option><option value="reassign">Reassign a retired address</option></select>
      <label htmlFor="admin-address">Address</label><div><input id="admin-address" type="email" value={adminCandidate} onChange={event => setAdminCandidate(event.target.value)} required placeholder="name@example.com" /><button className="button primary" disabled={busy || !targetMailbox}>Apply</button></div>
      <p className="field-help">Reassignment directs future mail to the selected mailbox. Previous messages remain in their original mailbox.</p>
    </form><ul className="address-list admin-address-list">{adminAddresses.map(address => <li key={address.allocationId}><div><strong>{address.address}</strong><span>{address.mailboxName}{address.ownerUsername ? ` · ${address.ownerUsername}` : ''}</span><span>{!address.current ? 'Removed' : address.adminPaused ? 'Administrator pause' : address.ownerPaused ? 'Owner pause' : address.systemPaused ? 'Policy pause' : address.policyStatus === 'blocked' ? 'Sync blocked · configuration needs attention' : !address.policyAcknowledged ? 'Sync pending' : address.receiveOnly ? 'Receive only' : 'Enabled'}</span></div>{address.current && <div className="row-actions"><button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/admin/addresses/${address.allocationId}/admin-pause`, { paused: !address.adminPaused }, 'PUT')}>{address.adminPaused ? 'Clear admin pause' : 'Admin pause'}</button><button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/admin/addresses/${address.allocationId}/receive-only`, { receiveOnly: !address.receiveOnly }, 'PUT')}>{address.receiveOnly ? 'Allow sending' : 'Receive only'}</button><button className="button subtle" disabled={busy} onClick={() => { if (window.confirm(`Remove ${address.address}? Its message history will remain in the mailbox.`)) void mutate(`/api/admin/addresses/${address.allocationId}/remove`, {}); }}>Remove</button></div>}</li>)}</ul></section>}
  </main>;
}
