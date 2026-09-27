import { useEffect, useRef, useState } from 'react';
import { errorMessage, getMessage, getRawMessage, getRenderedMessage, type MessageDetail, type RenderedMessage } from './api';

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function MessageDetails({ message }: { message: MessageDetail }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [open]);
  const fields = [
    ['From', message.from], ['Reply-To', message.reader.replyTo], ['To', message.to], ['Cc', message.reader.cc],
    ['Date', message.reader.sentAt ? dateLabel(message.reader.sentAt) : ''], ['Subject', message.subject],
    ['Received at', dateLabel(message.receivedAt)], ['Envelope sender', message.reader.envelopeFrom], ['Envelope recipient', message.reader.envelopeTo],
  ].filter(([, value]) => value);
  return <div className="message-details" ref={container}>
    <button ref={button} className="details-button" aria-expanded={open} aria-controls="message-details-popover" onClick={() => setOpen(value => !value)}>Message details <span aria-hidden="true">⌄</span></button>
    {open && <div id="message-details-popover" className="message-details-popover" role="region" aria-label="Message details"><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd dir="auto">{value}</dd></div>)}</dl></div>}
  </div>;
}

interface ReaderProps {
  mailboxId: string;
  token: string;
  messageId: string;
  revision: number;
  autoLoadExternalImages: boolean;
  onBack: () => void;
}

export function MessageReader({ mailboxId, token, messageId, revision, autoLoadExternalImages, onBack }: ReaderProps) {
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<'html' | 'text'>('html');
  const [imageChoice, setImageChoice] = useState<'allowed' | 'blocked' | null>(null);
  const [rendered, setRendered] = useState<{ body: RenderedMessage; imageMode: 'allowed' | 'blocked'; contentVersion: string } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderRetry, setRenderRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const rawController = useRef<AbortController | null>(null);
  const imageMode = imageChoice ?? (autoLoadExternalImages ? 'allowed' : 'blocked');
  const showHtml = mode === 'html' && message?.reader.hasHtml === true;
  const contentVersion = message?.reader.contentVersion ?? null;
  const visibleRender = rendered?.imageMode === imageMode && rendered.contentVersion === contentVersion ? rendered.body : null;

  useEffect(() => {
    const controller = new AbortController();
    // The parent keys this component by mailbox/message. A same-message refresh keeps the visible body and scroll.
    setLoading(message === null); setError(null);
    getMessage(mailboxId, messageId, token, controller.signal)
      .then(data => { if (!controller.signal.aborted) setMessage(data); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [mailboxId, messageId, token, revision, retry]);

  useEffect(() => {
    const controller = new AbortController();
    setRendered(null); setRenderError(null);
    if (showHtml && contentVersion) {
      getRenderedMessage(mailboxId, messageId, token, imageMode, controller.signal)
        .then(body => { if (!controller.signal.aborted) setRendered({ body, imageMode, contentVersion }); })
        .catch((failure: unknown) => { if (!controller.signal.aborted) setRenderError(errorMessage(failure)); });
    }
    return () => controller.abort();
  }, [mailboxId, messageId, token, contentVersion, showHtml, imageMode, renderRetry]);

  useEffect(() => () => rawController.current?.abort(), []);

  async function downloadRaw() {
    rawController.current?.abort();
    const controller = new AbortController(); rawController.current = controller;
    setDownloading(true); setDownloadError(null);
    try {
      const blob = await getRawMessage(mailboxId, messageId, token, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `${messageId.replace(/[^a-zA-Z0-9-]/g, '_')}.eml`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!controller.signal.aborted) setDownloadError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setDownloading(false); }
  }

  return <section className="reading-panel" aria-label="Message reader" aria-busy={loading}>
    <div className="reader-toolbar">
      <button className="button subtle back-button" onClick={onBack}><span aria-hidden="true">←</span> Inbox</button>
      {message?.reader.hasHtml && <div className="reader-mode-toggle" role="group" aria-label="Message format">
        <button aria-pressed={mode === 'html'} onClick={() => setMode('html')}>HTML</button>
        <button aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Plain text</button>
      </div>}
      {message && !message.reader.hasHtml && <span className="reader-mode">Plain text</span>}
      <button className="button subtle download-button" onClick={() => void downloadRaw()} disabled={downloading || loading || !message}>{downloading ? 'Downloading…' : 'Download original'}</button>
    </div>
    {error && message && <div className="reader-error error-panel" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>Refresh message</button></div>}
    {downloadError && <div className="reader-error error-panel" role="alert">{downloadError}</div>}
    {loading ? <div className="state-panel" role="status"><h2>Loading message</h2></div> : error && !message ? <div className="reader-failure"><div className="error-panel" role="alert">{error}</div><button className="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : message && <article className="message-content">
      <header className="message-header">
        <div className="message-heading-meta"><span className="message-status">{message.status.replaceAll('_', ' ')}</span><span>{new Intl.NumberFormat('en').format(message.sizeBytes)} bytes</span></div>
        <h1 dir="auto">{message.subject || '(No subject)'}</h1>
        <div className="sender-summary"><strong dir="auto">{message.from || '(Sender unavailable)'}</strong><time dateTime={message.receivedAt}>{dateLabel(message.receivedAt)}</time></div>
        {message.to && <p className="recipient-summary" dir="auto">To {message.to}</p>}
        <MessageDetails message={message} />
      </header>
      {showHtml ? <div className="html-reading-area">
        {renderError ? <div className="reader-failure"><div className="error-panel" role="alert">{renderError}</div><button className="button" onClick={() => setRenderRetry(value => value + 1)}>Try again</button><button className="button subtle" onClick={() => setMode('text')}>Read plain text</button></div> : !visibleRender ? <div className="body-empty" role="status">Preparing message…</div> : <>
          {visibleRender.remoteImageCount > 0 && <div className={`external-images-banner ${imageMode === 'allowed' ? 'images-allowed' : ''}`}>
            <div><strong>{imageMode === 'blocked' ? 'External images are blocked.' : 'External images are allowed.'}</strong><p>Images load directly from external servers and may reveal your IP address, device information, and reading time. Your browser may also send cookies permitted by its settings.</p></div>
            <button className="button" onClick={() => setImageChoice(imageMode === 'blocked' ? 'allowed' : 'blocked')}>{imageMode === 'blocked' ? 'Load images' : 'Block images'}</button>
          </div>}
          {visibleRender.warnings.length > 0 && <div className="render-notice" role="status">{visibleRender.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
          <iframe className="message-html-frame" title="Email message content" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={visibleRender.html} />
        </>}
      </div> : message.text ? <div className="message-body" dir="auto">{message.text}</div> : <div className="body-empty"><p>No plain-text body is available.</p><p>{message.reader.hasHtml ? 'Choose HTML to read this message.' : 'The message may still be waiting for parsing or have no readable body.'}</p></div>}
    </article>}
  </section>;
}
