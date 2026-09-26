import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage, getMailbox, getMessage, getMessages, getRawMessage, type Mailbox, type MessageDetail, type MessageSummary } from './api';

interface Session {
  token: string;
  mailbox: Mailbox;
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

function MessageReader({ session, messageId, revision, onBack }: { session: Session; messageId: string; revision: number; onBack: () => void }) {
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const rawController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setMessage(null);
    getMessage(session.mailbox.id, messageId, session.token, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setMessage(data); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session, messageId, revision, retry]);

  useEffect(() => {
    setDownloading(false);
    setDownloadError(null);
    return () => rawController.current?.abort();
  }, [messageId]);

  async function downloadRaw() {
    rawController.current?.abort();
    const controller = new AbortController();
    rawController.current = controller;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await getRawMessage(session.mailbox.id, messageId, session.token, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${messageId.replace(/[^a-zA-Z0-9-]/g, '_')}.eml`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) setDownloadError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return <section className="reading-panel" aria-label="Message reader" aria-busy={loading}>
    <div className="reader-toolbar">
      <button className="button subtle back-button" onClick={onBack}><Icon name="back" /><span>Inbox</span></button>
      <span className="reader-mode">Plain text</span>
      <button className="button subtle download-button" onClick={downloadRaw} disabled={downloading}><Icon name="download" /><span>{downloading ? 'Downloading…' : 'Download original'}</span></button>
    </div>
    {downloadError && <div className="reader-error error-panel" role="alert">{downloadError}</div>}
    {loading ? <StatePanel title="Loading message" busy /> : error ? <div className="reader-failure">
      <div className="error-panel" role="alert">{error}</div>
      <button className="button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
    </div> : message && <article className="message-content">
      <header className="message-header">
        <div className="message-heading-meta"><Status status={message.status} /><span>{formatBytes(message.sizeBytes)}</span></div>
        <h1>{message.subject || '(No subject)'}</h1>
        <dl className="message-addresses">
          <div><dt>From</dt><dd dir="auto">{message.from || '(Sender unavailable)'}</dd></div>
          <div><dt>To</dt><dd dir="auto">{message.to || '(Not specified)'}</dd></div>
          <div><dt>Received</dt><dd><time dateTime={message.receivedAt}>{formatDate(message.receivedAt, true)}</time></dd></div>
        </dl>
      </header>
      {message.text ? <div className="message-body" dir="auto">{message.text}</div> : <div className="body-empty">
        <p>No plain-text body is available.</p>
        <p>The message may still be waiting for parsing, contain only HTML, or have no readable body. Check its status or download the original message.</p>
      </div>}
    </article>}
  </section>;
}

function Inbox({ session }: { session: Session }) {
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
      const items = await getMessages(session.mailbox.id, session.token, controller.signal);
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
  }, [session]);

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
    {selectedId ? <MessageReader session={session} messageId={selectedId} revision={revision} onBack={() => setSelectedId(null)} /> : <section className="reading-panel empty-reader" aria-label="Message reader"><StatePanel title="A little space for your mail">Select a message to read its plain-text content and inspect the original delivery.</StatePanel><p className="reader-footnote">Your inbox works independently of AI.</p></section>}
  </main>;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-symbol"><Icon name="mail" /></span><span>DreamPost</span></div><span className="development-label">Development inbox</span><div className="header-actions">{session ? <><span className="connection-label"><span className="status-dot connected" />Mailbox connected</span><button className="button subtle" onClick={() => setSession(null)} aria-label="Disconnect"><Icon name="disconnect" /><span>Disconnect</span></button></> : <span className="connection-label">Read-only local view</span>}</div></header>
    {session ? <Inbox session={session} /> : <ConnectionForm onConnect={setSession} />}
  </div>;
}
