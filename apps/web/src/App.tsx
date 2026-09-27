import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage, getMailbox, getMessages, type Mailbox, type MessageSummary } from './api';
import { SsoWorkspace } from './SsoWorkspace';
import { MessageReader } from './MessageReader';
import { clearAttachmentAccessCache, parseAttachmentConfig, type AttachmentConfig } from './attachments/api';

export interface Session {
  token: string;
  mailbox: Mailbox;
  csrfToken?: string;
}

type IconName = 'mail' | 'refresh' | 'back' | 'download' | 'disconnect' | 'lock';

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>,
    refresh: <><path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6M4 14a8 8 0 0 0 14 4l3-3m0 6v-6h-6" /></>,
    back: <path d="m14 5-7 7 7 7M7 12h14" />,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5" /></>,
    disconnect: <><path d="M9 4H4v16h5m5-13 5 5-5 5m-7-5h12" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  };
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function formatDate(value: string, full = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat('en', full
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function Status({ status }: { status: string }) {
  return <span className="message-status">{status.replaceAll('_', ' ')}</span>;
}

function StatePanel({ title, children, busy = false }: { title: string; children?: ReactNode; busy?: boolean }) {
  return <div className="state-panel" role="status">
    <span className={`state-icon ${busy ? 'is-loading' : ''}`}><Icon name={busy ? 'refresh' : 'mail'} /></span>
    <h2>{title}</h2>
    {children && <p>{children}</p>}
  </div>;
}

function ConnectionForm({ onConnect }: { onConnect: (session: Session) => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controller.current?.abort();
    const attempt = new AbortController();
    controller.current = attempt;
    setBusy(true);
    setError(null);
    try {
      const mailbox = await getMailbox(token, attempt.signal);
      if (!attempt.signal.aborted) onConnect({ token, mailbox });
    } catch (failure) {
      if (!attempt.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!attempt.signal.aborted) setBusy(false);
    }
  }

  return <main className="connection-page">
    <section className="connection-card" aria-labelledby="connect-title">
      <span className="connection-symbol"><Icon name="lock" /></span>
      <p className="eyebrow">Local mail, in your hands</p>
      <h1 id="connect-title">Open your development inbox</h1>
      <p className="connection-description">Inspect messages delivered to the configured test mailbox. This is a read-only development view, before DreamSSO integration.</p>
      <form onSubmit={connect}>
        <label htmlFor="view-token">Development view token</label>
        <input id="view-token" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={token} onChange={(event) => setToken(event.target.value)} required minLength={32} disabled={busy} aria-describedby="token-help" />
        <p id="token-help" className="field-help">Use the API's DEV_VIEW_TOKEN. It stays in this tab's memory and is cleared when you disconnect or reload.</p>
        {error && <div className="error-panel" role="alert">{error}</div>}
        <button className="button primary connect-button" disabled={busy}>{busy ? 'Connecting…' : 'Connect to mailbox'}</button>
      </form>
      <span className="disconnected-note"><span className="status-dot" />Disconnected</span>
    </section>
  </main>;
}

export function Inbox({ session, autoLoadExternalImages = false, attachmentConfig }: { session: Session; autoLoadExternalImages?: boolean; attachmentConfig?: AttachmentConfig }) {
  const { token, mailbox } = session;
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [revision, setRevision] = useState(0);
  const requestController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(null);
    try {
      const items = await getMessages(mailbox.id, token, controller.signal);
      if (controller.signal.aborted) return;
      setMessages(items);
      setSelectedId((current) => items.some((item) => item.id === current) ? current : null);
      setRefreshedAt(new Date());
      setRevision((value) => value + 1);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [mailbox.id, token]);

  useEffect(() => {
    void refresh();
    return () => requestController.current?.abort();
  }, [refresh]);

  return <main className={`inbox-workspace ${selectedId ? 'has-selection' : ''}`}>
    <aside className="mailbox-sidebar" aria-label="Mailbox navigation">
      <div className="mailbox-identity"><span className="mailbox-avatar"><Icon name="mail" /></span><div><strong>{session.mailbox.name}</strong><span title={session.mailbox.address}>{session.mailbox.address}</span></div></div>
      <p className="sidebar-label">Mailbox</p>
      <button className="folder-button active" onClick={() => setSelectedId(null)} aria-current="page" aria-label="Inbox"><Icon name="mail" /><span>Inbox</span><span className="message-count">{messages.length}</span></button>
      <div className="sidebar-footer"><span className="sidebar-note">Read-only access</span><p>Messages are stored by your local mail service.</p></div>
    </aside>
    <section className="list-panel" aria-labelledby="inbox-heading" aria-busy={loading}>
      <div className="list-heading"><div><h1 id="inbox-heading">Inbox</h1><p>Up to 100 most recent messages</p></div><button className="icon-button" onClick={() => void refresh()} disabled={loading} aria-label={loading ? 'Refreshing inbox' : 'Refresh inbox'} title="Refresh inbox"><Icon name="refresh" className={loading ? 'is-loading' : ''} /></button></div>
      <div className="list-sync" role="status">{loading ? 'Checking for messages…' : error ? refreshedAt ? 'Refresh failed · showing last loaded messages' : 'Could not load messages' : refreshedAt ? `Updated ${refreshedAt.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })} · manual refresh` : 'Not yet refreshed'}</div>
      {error && <div className="list-error error-panel" role="alert">{error}<button className="text-button" onClick={() => void refresh()} disabled={loading}>Try again</button></div>}
      {messages.length === 0 ? loading ? <StatePanel title="Loading inbox" busy /> : !error && <StatePanel title="Your inbox is ready">Messages delivered to {session.mailbox.address} will appear here. Refresh after a delivery to see them.</StatePanel> : <ul className="message-list" aria-label="Messages">{messages.map((message) => <li key={message.id}><button className={`message-item ${selectedId === message.id ? 'selected' : ''}`} onClick={() => setSelectedId(message.id)} aria-current={selectedId === message.id ? 'true' : undefined}>
        <div className="message-row"><strong dir="auto">{message.from || '(Sender unavailable)'}</strong><time dateTime={message.receivedAt}>{formatDate(message.receivedAt)}</time></div>
        <span className="message-subject" dir="auto">{message.subject || '(No subject)'}</span>
        <span className="message-preview" dir="auto">{message.preview || 'No preview available'}</span>
        <div className="message-row message-row-bottom"><Status status={message.status} /><span>{formatBytes(message.sizeBytes)}</span></div>
      </button></li>)}</ul>}
    </section>
    {selectedId ? <MessageReader key={`${mailbox.id}:${selectedId}`} mailboxId={mailbox.id} token={token} messageId={selectedId} revision={revision} autoLoadExternalImages={autoLoadExternalImages} csrfToken={session.csrfToken} attachmentConfig={attachmentConfig} onBack={() => setSelectedId(null)} /> : <section className="reading-panel empty-reader" aria-label="Message reader"><StatePanel title="A little space for your mail">Select a message to read it and inspect its delivery details.</StatePanel><p className="reader-footnote">Your inbox works independently of AI.</p></section>}
  </main>;
}

function DevelopmentApp({ attachmentConfig }: { attachmentConfig?: AttachmentConfig }) {
  const [session, setSession] = useState<Session | null>(null);

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-symbol"><Icon name="mail" /></span><span>DreamPost</span></div><span className="development-label">Development inbox</span><div className="header-actions">{session ? <><span className="connection-label"><span className="status-dot connected" />Mailbox connected</span><button className="button subtle" onClick={() => { clearAttachmentAccessCache(); setSession(null); }} aria-label="Disconnect"><Icon name="disconnect" /><span>Disconnect</span></button></> : <span className="connection-label">Read-only local view</span>}</div></header>
    {session ? <Inbox session={session} attachmentConfig={attachmentConfig} /> : <ConnectionForm onConnect={setSession} />}
  </div>;
}

export function App() {
  const [attachmentConfig, setAttachmentConfig] = useState<AttachmentConfig | undefined>();
  const [mode, setMode] = useState<'loading' | 'development' | 'sso' | 'error'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Unavailable');
        const config: unknown = await response.json();
        if (!config || typeof config !== 'object' || !('authentication' in config) || !['development', 'sso'].includes(String(config.authentication))) throw new Error('Invalid configuration');
        if (!controller.signal.aborted) {
          const attachments = 'attachments' in config ? parseAttachmentConfig(config.attachments, window.location.origin) : undefined;
          setAttachmentConfig(attachments); setMode(config.authentication as 'development' | 'sso');
        }
      }).catch(() => { if (!controller.signal.aborted) setMode('error'); });
    return () => controller.abort();
  }, []);
  if (mode === 'development') return <DevelopmentApp attachmentConfig={attachmentConfig} />;
  if (mode === 'sso') return <SsoWorkspace attachmentConfig={attachmentConfig} />;
  return <main className="connection-page"><section className="connection-card"><h1>DreamPost</h1><p>{mode === 'error' ? 'Cannot reach the mail service. Check the connection and reload.' : 'Connecting to your mail service…'}</p>{mode === 'error' && <button className="button primary" onClick={() => window.location.reload()}>Reload</button>}</section></main>;
}
