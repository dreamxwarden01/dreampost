import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';
import { AttachmentPreview } from './AttachmentPreview';
import { getAttachments, prepareAttachmentAccess, type AttachmentAccess, type AttachmentConfig, type AttachmentItem, type AttachmentList, type MailAccess } from './api';

const RASTERS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const STATES: Record<AttachmentList['state'], string> = {
  ready: '', pending: 'Attachments are being prepared. Refresh the message to check again.',
  failed: 'Attachments could not be prepared. The original message is still available.',
  over_limit: 'This message exceeds the attachment processing limits. The original message is still available.',
  drift: 'Attachment verification needs attention. The original message is still available.',
};
function sizeLabel(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }

export function AttachmentSection({ config, access, revision }: { config: AttachmentConfig; access: MailAccess; revision: number }) {
  const [list, setList] = useState<AttachmentList | null>(null), [error, setError] = useState('');
  const [selected, setSelected] = useState<AttachmentItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null), [downloadError, setDownloadError] = useState('');
  const [readyDownload, setReadyDownload] = useState<{ attachment: AttachmentItem; session: AttachmentAccess } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const activeDownload = useRef<AttachmentItem | null>(null);
  const currentInventory = useRef<AttachmentList | null>(null);
  const inventoryFailed = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void getAttachments(access, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      currentInventory.current = result; inventoryFailed.current = false;
      setList(result); setError('');
      const available = (value: AttachmentItem) => result.items.some(item => item.id === value.id && item.sha256 === value.sha256 && item.state === 'ready');
      setSelected(previous => previous && available(previous) ? previous : null);
      setReadyDownload(previous => previous && available(previous.attachment) ? previous : null);
      if (activeDownload.current && !available(activeDownload.current)) { downloadController.current?.abort(); activeDownload.current = null; setBusyId(null); }
    }).catch(failure => { if (!controller.signal.aborted) { inventoryFailed.current = true; setError(errorMessage(failure)); setSelected(null); setReadyDownload(null); downloadController.current?.abort(); activeDownload.current = null; setBusyId(null); } });
    return () => controller.abort();
  }, [access.mailboxId, access.messageId, access.token, revision]);
  useEffect(() => () => downloadController.current?.abort(), []);
  async function download(attachment: AttachmentItem) {
    if (inventoryFailed.current || !currentInventory.current?.items.some(item => item.id === attachment.id && item.sha256 === attachment.sha256 && item.state === 'ready')) return;
    activeDownload.current = attachment;
    downloadController.current?.abort();
    const controller = new AbortController(); downloadController.current = controller;
    setBusyId(attachment.id); setDownloadError(''); setReadyDownload(null);
    try {
      const session = await prepareAttachmentAccess(config, access, attachment, 'download', controller.signal);
      if (controller.signal.aborted) return;
      setReadyDownload({ attachment, session });
      // Native downloads keep file bytes out of the page. The visible link remains if automatic activation is blocked.
      const link = document.createElement('a'); link.href = session.url; link.download = attachment.filename || 'attachment';
      link.target = '_blank'; link.rel = 'noopener noreferrer'; document.body.append(link); link.click(); link.remove();
    } catch (failure) { if (!controller.signal.aborted) setDownloadError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) { setBusyId(null); activeDownload.current = null; } }
  }
  function canPreview(item: AttachmentItem) {
    return !error && item.state === 'ready' && item.sizeBytes > 0 && item.sizeBytes <= config.maxPreviewBytes
      && ((item.previewKind === 'pdf' && item.mimeType === 'application/pdf') || (item.previewKind === 'image' && RASTERS.has(item.mimeType)));
  }
  const previewable = list?.items.filter(canPreview) ?? [];
  const selectedIndex = previewable.findIndex(item => item.id === selected?.id);
  if (!list && !error) return <section className="attachments-section" aria-label="Attachments"><p className="attachment-status" role="status">Loading attachments…</p></section>;
  if (list?.state === 'ready' && !list.items.length && !error) return null;
  return <section className="attachments-section" aria-label="Attachments">
    <div className="attachments-heading"><h2>Attachments</h2>{list?.items.length ? <span>{list.items.length}</span> : null}</div>
    {error && <p className="error-panel" role="alert">{error}</p>}
    {list && STATES[list.state] && <p className="attachment-status" role="status">{STATES[list.state]}</p>}
    {list && <ul className="attachment-list">{list.items.map(item => <li key={item.id} className="attachment-card">
      <span className={`attachment-symbol ${item.previewKind === 'pdf' ? 'pdf-symbol' : ''}`} aria-hidden="true">{item.previewKind === 'pdf' ? 'PDF' : item.previewKind === 'image' ? 'IMG' : 'FILE'}</span>
      <div className="attachment-description"><strong title={item.filename}>{item.filename || 'Unnamed attachment'}</strong><span>{sizeLabel(item.sizeBytes)}{item.state !== 'ready' ? ` · ${item.state === 'queued' ? 'Preparing' : 'Unavailable'}` : ''}</span></div>
      <div className="attachment-actions">{canPreview(item) && <button className="button subtle" onClick={() => { setDownloadError(''); setSelected(item); }}>Preview</button>}<button className="button" aria-label={`Download attachment ${item.filename || 'Unnamed attachment'}`} disabled={!!error || item.state !== 'ready' || busyId !== null} onClick={() => void download(item)}>{busyId === item.id ? 'Preparing…' : 'Download'}</button></div>
    </li>)}</ul>}
    {downloadError && <p className="error-panel" role="alert">{downloadError}</p>}
    {readyDownload && <p className="attachment-download-ready" role="status">Your download is ready. <a href={readyDownload.session.url} download={readyDownload.attachment.filename || 'attachment'} target="_blank" rel="noopener noreferrer">Download {readyDownload.attachment.filename || 'attachment'}</a> if it did not start automatically.</p>}
    {selected && <AttachmentPreview key={`${selected.id}:${selected.sha256}`} attachment={selected} config={config} access={access} onClose={() => setSelected(null)} onDownload={item => void download(item)} downloading={busyId !== null} downloadUrl={readyDownload?.attachment.id === selected.id ? readyDownload.session.url : undefined} downloadError={downloadError} previousAttachment={selectedIndex > 0 ? () => { setDownloadError(''); setSelected(previewable[selectedIndex - 1]!); } : undefined} nextAttachment={selectedIndex >= 0 && selectedIndex < previewable.length - 1 ? () => { setDownloadError(''); setSelected(previewable[selectedIndex + 1]!); } : undefined} />}
  </section>;
}
