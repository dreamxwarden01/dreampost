import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errorMessage, sessionRequest } from './api';
import type { UserSession } from './SsoWorkspace';

import type { AddressView, AddressesResponse } from './address-types';

export function AddressSettings({ session, onChanged }: { session: UserSession; onChanged: () => void }) {
  const [data, setData] = useState<AddressesResponse | null>(null);
  const [candidate, setCandidate] = useState('');
  const [eligible, setEligible] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mailboxUser = session.actor?.permissions.includes('mailbox.use') === true;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = mailboxUser ? await sessionRequest<AddressesResponse>('/api/addresses', { signal }) : { mailbox: null, addresses: [], requests: [] };
      const senders = mailboxUser ? await sessionRequest<{ identities: Array<{ allocationId: string; eligible: boolean }> }>('/api/sending-identities', { signal }) : { identities: [] };
      if (signal?.aborted) return;
      setData(result); setError('');
      setEligible(new Set(senders.identities.filter(identity => identity.eligible).map(identity => identity.allocationId)));

    } catch (failure) { if (!signal?.aborted) setError(errorMessage(failure)); }
  }, [mailboxUser]);
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
  const visibleAddresses = [...new Map((data?.addresses ?? []).filter(address => address.current
    || !(data?.addresses ?? []).some(other => other.current && other.address === address.address)).map(address => [address.address, address])).values()];
  return <main className="settings-page page-enter">
    <div className="settings-heading"><div><p className="eyebrow">One mailbox, your addresses</p><h1>Addresses</h1><p>All your personal addresses share the same mailbox and message history.</p></div><button className="button subtle" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
    {error && <div className="error-panel" role="alert">{error}</div>}{notice && <p className="notice-panel" role="status">{notice}</p>}
    {data?.mailbox?.provisioning_status === 'needs_address' && <div className="notice-panel">Your username-based address could not be assigned. Request another address below; an administrator will review it.</div>}
    {mailboxUser && <section className="settings-card" aria-labelledby="my-addresses"><h2 id="my-addresses">Your addresses</h2>{!data ? <p>Loading addresses…</p> : data.addresses.length === 0 ? <p>No addresses have been assigned yet.</p> : <ul className="address-list">{visibleAddresses.map(address => <li key={address.allocationId}><div><strong>{address.address}</strong><span>{state(address)}</span>{!address.policyAcknowledged && (address.ownerPaused || address.adminPaused) && <small>Sending is blocked. Receiving update is syncing.</small>}</div>{!address.current && <button className="button subtle" disabled={busy} onClick={() => void mutate('/api/address-requests', { address: address.address, action: 'reactivate' }, 'POST', 'Reactivation requested. An administrator must approve it.')}>Request reactivation</button>}{address.current && <button className="button subtle" disabled={busy} onClick={() => void mutate(`/api/addresses/${address.allocationId}/owner-pause`, { paused: !address.ownerPaused }, 'PUT')}>{address.ownerPaused ? 'Resume address' : 'Pause address'}</button>}</li>)}</ul>}<p className="field-help">Pausing blocks both receiving and sending. Your address and existing messages stay yours.</p></section>}
    {mailboxUser && <section className="settings-card"><h2>Request an address</h2><form className="address-request-form" onSubmit={requestAddress}><label htmlFor="new-address">Email address</label><div><input id="new-address" type="email" autoComplete="off" value={candidate} onChange={event => setCandidate(event.target.value)} placeholder="name@example.com" required disabled={busy} /><button className="button primary" disabled={busy}>Submit request</button></div></form><p className="field-help">An administrator must approve additional addresses before they become available.</p>{data && data.requests.length > 0 && <ul className="request-list">{data.requests.map(request => <li key={request.id}><span>{request.address}</span><span className="message-status">{request.status.replaceAll('_', ' ')}</span></li>)}</ul>}</section>}

  </main>;
}
