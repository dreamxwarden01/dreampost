import { MAX_PREVIEW_RANGE } from './api';

export type PreviewEvent = { type: 'ready'; page: number; pages: number; zoom: number } | { type: 'error'; code: string };
interface RangeRequest { type: 'range'; instanceId: string; requestId: number; begin: number; end: number }
interface PortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  start(): void;
  close(): void;
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const ERROR_CODES = new Set(['unsupported', 'password', 'too-complex', 'timeout', 'render-failed', 'worker-failed', 'invalid-data']);

/** The renderer is an untrusted client, even though its static bundle belongs to this application. */
export function createPreviewBridge(port: PortLike, options: {
  instanceId: string;
  sizeBytes: number;
  readRange: (begin: number, end: number, signal: AbortSignal) => Promise<ArrayBuffer>;
  onEvent: (event: PreviewEvent) => void;
  timeoutMs?: number;
}) {
  const controller = new AbortController(); const seen = new Set<number>(); const queue: RangeRequest[] = [];
  const byteBudget = Math.min(128 * 1024 * 1024, options.sizeBytes * 3 + 2 * 1024 * 1024);
  let active = 0, bytesRequested = 0, closed = false;
  function close() { if (closed) return; closed = true; controller.abort(); queue.length = 0; port.onmessage = null; port.close(); }
  function fail(code = 'invalid-data') { if (closed) return; options.onEvent({ type: 'error', code }); close(); }
  function post(message: unknown, transfer?: Transferable[]) { if (!closed) port.postMessage(message, transfer); }
  async function run(request: RangeRequest) {
    active++;
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), options.timeoutMs ?? 20_000);
    const signal = AbortSignal.any([controller.signal, attempt.signal]);
    try {
      const bytes = await options.readRange(request.begin, request.end, signal);
      if (signal.aborted) throw new Error('Request cancelled');
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== request.end - request.begin) { fail(); return; }
      post({ type: 'range-result', instanceId: options.instanceId, requestId: request.requestId, begin: request.begin, bytes }, [bytes]);
    } catch { if (!closed) fail(attempt.signal.aborted ? 'timeout' : 'invalid-data'); }
    finally { clearTimeout(timer); active--; pump(); }
  }
  function pump() { while (!closed && active < 2 && queue.length) void run(queue.shift()!); }
  port.onmessage = event => {
    if (closed) return;
    const data = record(event.data);
    if (!data || data.instanceId !== options.instanceId) { fail(); return; }
    if (data.type === 'range') {
      if (Object.keys(data).some(key => !['type', 'instanceId', 'requestId', 'begin', 'end'].includes(key))
        || !safeInteger(data.requestId) || data.requestId < 1 || seen.has(data.requestId) || seen.size >= 4096
        || !safeInteger(data.begin) || !safeInteger(data.end) || data.begin < 0 || data.end <= data.begin
        || data.end > options.sizeBytes || data.end - data.begin > MAX_PREVIEW_RANGE || queue.length + active >= 6
        || bytesRequested + data.end - data.begin > byteBudget) { fail(); return; }
      seen.add(data.requestId); bytesRequested += data.end - data.begin;
      queue.push(data as unknown as RangeRequest); pump(); return;
    }
    if (data.type === 'ready' && safeInteger(data.page) && safeInteger(data.pages) && data.pages >= 1 && data.pages <= 500
      && data.page >= 1 && data.page <= data.pages && typeof data.zoom === 'number' && Number.isFinite(data.zoom) && data.zoom >= 0.1 && data.zoom <= 4) {
      options.onEvent({ type: 'ready', page: data.page, pages: data.pages, zoom: data.zoom }); return;
    }
    if (data.type === 'error' && typeof data.code === 'string' && ERROR_CODES.has(data.code)) { fail(data.code); return; }
    fail();
  };
  port.start();
  return {
    close,
    command(command: 'previous' | 'next' | 'zoom-in' | 'zoom-out' | 'fit') { post({ type: 'command', instanceId: options.instanceId, command }); },
  };
}
