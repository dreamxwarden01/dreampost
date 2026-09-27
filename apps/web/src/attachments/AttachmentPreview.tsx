import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';
import { createPreviewBridge, type PreviewEvent } from './bridge';
import { prepareAttachmentAccess, readAttachmentRange, MAX_PREVIEW_RANGE, type AttachmentConfig, type AttachmentItem, type MailAccess } from './api';

const MESSAGES: Record<string, string> = {
  unsupported: 'This file cannot be previewed. You can still download the original.',
  password: 'This PDF needs a password. Download the original to open it.',
  'too-complex': 'This file exceeds the preview limits. Download the original to open it.',
  timeout: 'The preview took too long. Try again or download the original.',
  'render-failed': 'This file could not be rendered. You can still download the original.',
  'worker-failed': 'The isolated preview could not start. Try again or download the original.',
  'invalid-data': 'The preview could not read the file safely. Close it and try again.',
};

export function AttachmentPreview({ attachment, config, access, onClose, onDownload, downloading, previousAttachment, nextAttachment, downloadUrl, downloadError }: {
  attachment: AttachmentItem; config: AttachmentConfig; access: MailAccess; onClose: () => void;
  onDownload: (attachment: AttachmentItem) => void; downloading: boolean;
  previousAttachment?: () => void; nextAttachment?: () => void;
  downloadUrl?: string; downloadError?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null), iframe = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof createPreviewBridge> | null>(null);
  const [generation, setGeneration] = useState(0);
  const [instanceId, setInstanceId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<Extract<PreviewEvent, { type: 'ready' }> | null>(null);
  const [error, setError] = useState(''); const [preparing, setPreparing] = useState(true);
  const [frameReady, setFrameReady] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController(); let connected = false;
    let session: Awaited<ReturnType<typeof prepareAttachmentAccess>> | undefined;
    let ready = false;
    setError(''); setState(null); setPreparing(true); setFrameReady(false);
    const deadline = window.setTimeout(() => { setError(MESSAGES.timeout!); controller.abort(); bridge.current?.close(); setFrameReady(false); }, 30_000);
    function connect() {
      if (!ready || !session || connected || controller.signal.aborted || !iframe.current?.contentWindow) return;
      connected = true; const channel = new MessageChannel();
      bridge.current = createPreviewBridge(channel.port1, {
        instanceId, sizeBytes: attachment.sizeBytes,
        readRange: (begin, end, signal) => readAttachmentRange(config, session!, attachment, begin, end, AbortSignal.any([controller.signal, signal])),
        onEvent: event => {
          if (controller.signal.aborted) return;
          clearTimeout(deadline); setPreparing(false);
          if (event.type === 'error') { setError(MESSAGES[event.code] ?? MESSAGES['render-failed']!); setFrameReady(false); }
          else setState(event);
        },
      });
      iframe.current.contentWindow.postMessage({ type: 'dreampost-preview-init', version: 1, instanceId,
        file: { kind: attachment.previewKind, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, maxRangeBytes: MAX_PREVIEW_RANGE } }, config.previewOrigin, [channel.port2]);
    }
    const receive = (event: MessageEvent) => {
      if (event.origin !== config.previewOrigin || event.source !== iframe.current?.contentWindow || controller.signal.aborted) return;
      if (!event.data || event.data.type !== 'dreampost-preview-ready' || event.data.instanceId !== instanceId || connected) return;
      ready = true; connect();
    };
    window.addEventListener('message', receive);
    void prepareAttachmentAccess(config, access, attachment, 'preview', controller.signal).then(result => {
      if (!controller.signal.aborted) { session = result; setFrameReady(true); connect(); }
    }).catch(failure => { if (!controller.signal.aborted) { clearTimeout(deadline); setError(errorMessage(failure)); setPreparing(false); } });
    return () => { clearTimeout(deadline); controller.abort(); window.removeEventListener('message', receive); bridge.current?.close(); bridge.current = null; };
  }, [attachment.id, attachment.sha256, config.downloadOrigin, config.previewOrigin, access.mailboxId, access.messageId, access.token, access.csrfToken, generation, instanceId]);
  function retry() { bridge.current?.close(); setInstanceId(crypto.randomUUID()); setGeneration(value => value + 1); }
  const src = `${config.previewOrigin}/#${new URLSearchParams({ instanceId, parentOrigin: window.location.origin })}`;
  return <dialog ref={dialog} className="attachment-preview-dialog" aria-label="Attachment preview" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="attachment-preview-heading"><div><p>Attachment preview</p><strong title={attachment.filename}>{attachment.filename || 'Unnamed attachment'}</strong></div><div className="attachment-preview-actions">{(previousAttachment || nextAttachment) && <div className="attachment-navigation"><button className="icon-button" aria-label="Previous attachment" disabled={!previousAttachment} onClick={previousAttachment}>←</button><button className="icon-button" aria-label="Next attachment" disabled={!nextAttachment} onClick={nextAttachment}>→</button></div>}<button className="button" disabled={downloading} onClick={() => onDownload(attachment)}>{downloading ? 'Preparing…' : 'Download'}</button><button className="icon-button" aria-label="Close attachment preview" onClick={onClose}>×</button></div></header>
    <div className="attachment-preview-tools" aria-label="Preview controls">
      {attachment.previewKind === 'pdf' && <><button className="button subtle" aria-label="Previous page" disabled={!state || state.page <= 1} onClick={() => bridge.current?.command('previous')}>←</button><span>{state ? `Page ${state.page} of ${state.pages}` : 'Preparing pages…'}</span><button className="button subtle" aria-label="Next page" disabled={!state || state.page >= state.pages} onClick={() => bridge.current?.command('next')}>→</button></>}
      <div className="preview-zoom"><button className="button subtle" aria-label="Zoom out" disabled={!state} onClick={() => bridge.current?.command('zoom-out')}>−</button><span>{state ? `${Math.round(state.zoom * 100)}%` : '—'}</span><button className="button subtle" aria-label="Zoom in" disabled={!state} onClick={() => bridge.current?.command('zoom-in')}>+</button><button className="button subtle" disabled={!state} onClick={() => bridge.current?.command('fit')}>Fit width</button></div>
    </div>
    {downloadUrl && <p className="preview-download-notice" role="status">Your download is ready. <a href={downloadUrl} download={attachment.filename || 'attachment'} target="_blank" rel="noopener noreferrer">Save file</a> if it did not start automatically.</p>}
    {downloadError && <p className="preview-download-notice error-panel" role="alert">{downloadError}</p>}
    {error ? <div className="attachment-preview-error" role="alert"><p>{error}</p><button className="button" onClick={retry}>Try again</button></div> : <>
      {preparing && <div className="attachment-preview-loading" role="status">Preparing a private preview…</div>}
      {frameReady && <iframe key={instanceId} ref={iframe} title="Attachment preview content" className="attachment-preview-frame" src={src} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
    </>}
  </dialog>;
}
