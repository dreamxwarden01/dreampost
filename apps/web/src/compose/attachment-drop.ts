import { MailApiError } from '../mailbox/api';
import type { Draft } from './api';

/** Mirrors the existing server part policy; byte limits come from runtime configuration. */
export const MAX_DRAFT_ATTACHMENT_PARTS = 32;
export function isFileTransfer(data: DataTransfer | null): boolean {
  return !!data && (Array.from(data.types ?? []).includes('Files') || Array.from(data.items ?? []).some(item => item.kind === 'file'));
}
interface EntryItem extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<{ kind: 'file' | 'directory' } | null>;
}
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const items = Array.from(data.items ?? []).filter(item => item.kind === 'file');
  const files = Array.from(data.files ?? []);
  if (!items.length) {
    if (!files.length) throw new MailApiError('No readable files were dropped. Use Attach file to choose files.', 400);
    rejectRelativePaths(files); return files;
  }
  if (items.length > MAX_DRAFT_ATTACHMENT_PARTS) throw new MailApiError(`Choose no more than ${MAX_DRAFT_ATTACHMENT_PARTS} files in one drop. No files were added.`, 413);
  // Capture every browser-provided file/entry before yielding: the drag store closes after drop dispatch.
  const captured = items.map(item => {
    const file = item.getAsFile();
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) throw new MailApiError('Folders cannot be attached. Choose individual files; no files from this drop were added.', 400);
    const handle = !entry && typeof (item as EntryItem).getAsFileSystemHandle === 'function'
      ? (item as EntryItem).getAsFileSystemHandle!().catch(() => null) : null;
    return { file, handle };
  });
  const handles = await Promise.all(captured.map(item => item.handle));
  if (handles.some(handle => handle?.kind === 'directory')) throw new MailApiError('Folders cannot be attached. Choose individual files; no files from this drop were added.', 400);
  if (captured.some(item => !item.file) || files.length && files.length !== captured.length) throw new MailApiError('Some dropped items could not be read. No files from this drop were added; use Attach file to select them again.', 400);
  const result = captured.map(item => item.file!); rejectRelativePaths(result); return result;
}
function rejectRelativePaths(files: readonly File[]) {
  if (files.some(file => file.webkitRelativePath)) throw new MailApiError('Folders cannot be attached. Choose individual files; no files from this selection were added.', 400);
}
export function validateAttachmentSelection(files: readonly File[], draft: Pick<Draft, 'attachments'>, maxBytes: number | undefined): void {
  if (!files.length) throw new MailApiError('Choose at least one file.', 400);
  rejectRelativePaths(files);
  if (!Number.isSafeInteger(maxBytes) || !maxBytes || maxBytes < 1) throw new MailApiError('Attachment limits are unavailable. Refresh before adding files.', 400);
  if (draft.attachments.length + files.length > MAX_DRAFT_ATTACHMENT_PARTS) throw new MailApiError(`A draft can contain up to ${MAX_DRAFT_ATTACHMENT_PARTS} attachments. No files from this selection were added.`, 413);
  let total = draft.attachments.reduce((sum, file) => sum + file.sizeBytes, 0);
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) throw new MailApiError(`“${file.name}” exceeds the configured attachment limit. No files from this selection were added.`, 413);
    total += file.size;
    if (!Number.isSafeInteger(total) || total > maxBytes) throw new MailApiError('These files exceed the remaining draft attachment budget. No files from this selection were added; remove a file or choose fewer files.', 413);
  }
}
export interface AttachmentBatchProgress { completed: number; total: number; currentName: string | null; remainingNames: string[] }
export class AttachmentBatchPaused extends MailApiError {
  constructor() { super('Attachment uploads are paused because compose access is unavailable. Restore your session or mailbox access, then retry the remaining files.'); }
}
/** A retry resumes the exact current file/version/key; acknowledged files are never uploaded again. */
export class SerialAttachmentBatch {
  private index = 0;
  private current: { base: Draft; key: string } | null = null;
  private running = false;
  private uncertain = false;
  private latest: Draft;
  readonly files: readonly File[];
  constructor(files: readonly File[], initial: Draft, private readonly key: () => string) { this.files = [...files]; this.latest = initial; }
  get hasUnconfirmedAttempt(): boolean { return this.uncertain; }
  get progress(): AttachmentBatchProgress { return { completed: this.index, total: this.files.length, currentName: this.files[this.index]?.name ?? null, remainingNames: this.files.slice(this.index).map(file => file.name) }; }
  async run(options: { allowed: () => boolean; upload: (draft: Draft, file: File, key: string) => Promise<Draft>; confirmed: (draft: Draft, progress: AttachmentBatchProgress) => void }): Promise<void> {
    if (this.running) throw new MailApiError('An attachment upload is already running.', 409);
    this.running = true;
    try {
      while (this.index < this.files.length) {
        if (!options.allowed()) throw new AttachmentBatchPaused();
        this.current ??= { base: this.latest, key: this.key() };
        const request = this.current;
        let saved: Draft;
        try { saved = await options.upload(request.base, this.files[this.index]!, request.key); }
        catch (failure) {
          if (!(failure instanceof MailApiError) || ![400, 401, 403, 404, 409, 413, 422].includes(failure.status ?? 0)) this.uncertain = true;
          throw failure;
        }
        if (saved.id !== request.base.id || saved.mailboxId !== request.base.mailboxId || saved.version <= request.base.version) { this.uncertain = true; throw new MailApiError('The attachment upload result could not be verified. Retry the same operation.'); }
        this.latest = saved; this.index++; this.current = null; this.uncertain = false;
        options.confirmed(saved, this.progress);
      }
    } finally { this.running = false; }
  }
}
