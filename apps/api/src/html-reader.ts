import { Worker } from 'node:worker_threads';
import { ApiError } from './errors.js';

export interface InlineImageCandidate { contentId: string; mimeType: string; base64: string; sizeBytes: number }
export interface HtmlRenderInput { html: string; remoteImages: 'blocked' | 'allowed'; inlineCandidates?: InlineImageCandidate[]; blockedOrigins?: string[] }
export interface HtmlRenderResult { html: string; remoteImageCount: number; warnings: string[] }
interface RenderOptions { timeoutMs?: number; principalKey?: string; signal?: AbortSignal }
let active = 0, managedBytes = 0;
const principals = new Set<string>();
const waiting: Array<() => void> = [];
export function getHtmlRendererActivity() { return { active, queued: waiting.length }; }

function acquire(input: HtmlRenderInput, options: RenderOptions): Promise<() => void> {
  if (options.signal?.aborted) return Promise.reject(new ApiError(499, 'reader_cancelled'));
  if (options.principalKey && principals.has(options.principalKey)) return Promise.reject(new ApiError(429, 'reader_request_in_progress'));
  const bytes = Buffer.byteLength(input.html) + (input.inlineCandidates ?? []).reduce((sum, value) => sum + value.base64.length, 0);
  if (managedBytes + bytes > 32 * 1024 * 1024 || (active >= 2 && waiting.length >= 4)) return Promise.reject(new ApiError(503, 'reader_busy'));
  managedBytes += bytes;
  if (options.principalKey) principals.add(options.principalKey);
  return new Promise((resolve, reject) => {
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forget = () => { managedBytes -= bytes; if (options.principalKey) principals.delete(options.principalKey); };
    const cancel = () => {
      if (!queued) return;
      queued = false; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
      const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index, 1);
      forget(); reject(new ApiError(options.signal?.aborted ? 499 : 503, options.signal?.aborted ? 'reader_cancelled' : 'reader_busy'));
    };
    const start = () => {
      queued = false; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); active++;
      resolve(() => { active--; forget(); waiting.shift()?.(); });
    };
    if (active < 2) start();
    else { queued = true; waiting.push(start); timer = setTimeout(cancel, 2000); options.signal?.addEventListener('abort', cancel, { once: true }); }
  });
}

/** Resource isolation, not an OS sandbox. No credentials or application environment are inherited. */
export async function renderHtmlIsolated(input: HtmlRenderInput, options: RenderOptions = {}): Promise<HtmlRenderResult> {
  const timeoutMs = options.timeoutMs ?? 4000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('invalid_render_timeout');
  if (Buffer.byteLength(input.html) > 1024 * 1024) throw new ApiError(422, 'html_source_too_large');
  const release = await acquire(input, options);
  try {
    if (options.signal?.aborted) throw new ApiError(499, 'reader_cancelled');
    return await new Promise<HtmlRenderResult>((resolve, reject) => {
      const worker = new Worker(new URL('./html-render-worker.mjs', import.meta.url), {
        workerData: input, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      let settled = false;
      const complete = (error: Error | null, value?: HtmlRenderResult) => {
        if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        void worker.terminate().then(() => error ? reject(error) : resolve(value!), () => reject(new ApiError(422, 'html_render_failed')));
      };
      const abort = () => complete(new ApiError(499, 'reader_cancelled'));
      const timer = setTimeout(() => complete(new ApiError(422, 'html_render_timeout')), timeoutMs);
      worker.once('message', (message: { ok?: boolean; code?: string; result?: HtmlRenderResult }) => {
        if (message.ok && message.result && typeof message.result.html === 'string' && message.result.html.length < 12 * 1024 * 1024
          && Number.isInteger(message.result.remoteImageCount) && Array.isArray(message.result.warnings)) complete(null, message.result);
        else complete(new ApiError(422, message.code === 'html_source_too_large' || message.code === 'html_structure_too_complex' ? message.code : 'html_render_failed'));
      });
      worker.once('error', () => complete(new ApiError(422, 'html_render_failed')));
      worker.once('exit', () => { if (!settled) complete(new ApiError(422, 'html_render_failed')); });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  } finally { release(); }
}
