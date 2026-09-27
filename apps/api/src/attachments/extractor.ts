import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { MAX_INBOUND_BYTES } from '@dreampost/protocol';
import type { AttachmentExtraction, AttachmentManifestTuple, ExtractedAttachment } from './types.js';

export const ATTACHMENT_EXTRACTOR_VERSION = 1;
export const ATTACHMENT_EXTRACTOR_OPTIONS = Object.freeze({ parser: 'postal-mime', parserVersion: '3.0.1', maxParts: 100, maxDecodedBytes: 25 * 1024 * 1024,
  metadataMaxBytes: 16384, calendarBytes: 'decoded-leaf-v1', mime: { attachmentEncoding: 'arraybuffer', maxNestingDepth: 30, maxHeadersSize: 256 * 1024,
    forceRfc822Attachments: true, rfc822Attachments: true, maxRfc822NestingDepth: 5 } });
export const ATTACHMENT_OPTIONS_SHA256 = createHash('sha256').update(JSON.stringify(ATTACHMENT_EXTRACTOR_OPTIONS)).digest('hex');
export class AttachmentExtractionError extends Error { constructor(readonly code: string) { super(code); this.name = 'AttachmentExtractionError'; } }
let active = 0, managedBytes = 0;
const queue: Array<() => void> = [];
export function getAttachmentExtractorActivity() { return { active, queued: queue.length }; }
function acquire(size: number): Promise<() => void> {
  if (managedBytes + size > 64 * 1024 * 1024 || (active >= 2 && queue.length >= 8)) return Promise.reject(new AttachmentExtractionError('attachment_extractor_busy'));
  managedBytes += size;
  return new Promise(resolve => {
    const start = () => { active++; resolve(() => { active--; managedBytes -= size; queue.shift()?.(); }); };
    if (active < 2) start(); else queue.push(start);
  });
}
export function attachmentManifest(parts: ExtractedAttachment[]): AttachmentManifestTuple[] {
  return parts.map(({ ordinal, sha256, sizeBytes, mimeType, disposition, filename, contentId }) => ({ ordinal, sha256, sizeBytes, mimeType, disposition, filename, contentId }));
}
export function attachmentManifestSha256(parts: ExtractedAttachment[]): string { return createHash('sha256').update(JSON.stringify(attachmentManifest(parts))).digest('hex'); }

export async function extractAttachmentsIsolated(raw: Uint8Array, options: { timeoutMs?: number } = {}): Promise<AttachmentExtraction> {
  if (raw.byteLength < 1 || raw.byteLength > MAX_INBOUND_BYTES) throw new AttachmentExtractionError('attachment_input_size_limit');
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new AttachmentExtractionError('invalid_attachment_timeout');
  const release = await acquire(raw.byteLength);
  try {
    const copy = Uint8Array.from(raw);
    const parts = await new Promise<ExtractedAttachment[]>((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(new URL('./extraction-worker.mjs', import.meta.url), { env: {}, execArgv: [],
        workerData: { raw: copy.buffer, options: ATTACHMENT_EXTRACTOR_OPTIONS }, transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }); }
      catch { reject(new AttachmentExtractionError('attachment_worker_unavailable')); return; }
      let finished = false;
      const finish = (error?: AttachmentExtractionError, value?: ExtractedAttachment[]) => {
        if (finished) return; finished = true; clearTimeout(timer);
        void worker.terminate().then(() => error ? reject(error) : resolve(value!), () => reject(new AttachmentExtractionError('attachment_worker_failed')));
      };
      const timer = setTimeout(() => finish(new AttachmentExtractionError('attachment_extraction_timeout')), timeoutMs);
      worker.once('message', (message: { ok?: boolean; code?: string; parts?: ExtractedAttachment[] }) => {
        if (message?.ok === true && Array.isArray(message.parts)) finish(undefined, message.parts);
        else finish(new AttachmentExtractionError(message?.code ?? 'attachment_mime_parse_failed'));
      });
      worker.once('error', (error: Error & { code?: string }) => finish(new AttachmentExtractionError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'attachment_resource_limit' : 'attachment_worker_failed')));
      worker.once('exit', () => { if (!finished) finish(new AttachmentExtractionError('attachment_worker_exited')); });
    });
    return { extractorVersion: ATTACHMENT_EXTRACTOR_VERSION, optionsSha256: ATTACHMENT_OPTIONS_SHA256, parts };
  } finally { release(); }
}
