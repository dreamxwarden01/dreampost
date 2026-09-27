import './styles.css';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFWorker, RenderTask } from 'pdfjs-dist';

interface FileDescriptor { kind: 'pdf' | 'image'; mimeType: string; sizeBytes: number; maxRangeBytes: number }
interface PendingRange { begin: number; end: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const MAX_BYTES = 64 * 1024 * 1024, MAX_PIXELS = 16_000_000, MAX_DIMENSION = 8192, MAX_PAGES = 500, MAX_RANGE = 256 * 1024;
const canvas = document.querySelector<HTMLCanvasElement>('#page')!;
const notice = document.querySelector<HTMLParagraphElement>('#notice')!;
const fragment = new URLSearchParams(location.hash.slice(1));
const instanceId = fragment.get('instanceId') ?? '', parentOrigin = fragment.get('parentOrigin') ?? '';
let port: MessagePort | null = null, file: FileDescriptor | null = null;
let nativeWorker: Worker | null = null, pdfWorker: PDFWorker | null = null, loading: PDFDocumentLoadingTask | null = null, pdf: PDFDocumentProxy | null = null;
let image: ImageBitmap | null = null, renderTask: RenderTask | null = null;
let closed = false, initialized = false, pageNumber = 1, zoom = 1, fitting = true, renderVersion = 0, nextRequestId = 0;
const pending = new Map<number, PendingRange>();
const cache = new Map<string, Uint8Array>(); let cacheBytes = 0;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const post = (message: Record<string, unknown>) => { if (!closed) port?.postMessage({ ...message, instanceId }); };

function destroy() {
  if (closed) return; closed = true; renderVersion++;
  renderTask?.cancel(); nativeWorker?.terminate(); void loading?.destroy().catch(() => {}); void pdfWorker?.destroy();
  image?.close(); cache.clear(); cacheBytes = 0;
  for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('Preview closed')); } pending.clear();
  port?.close(); port = null; canvas.width = canvas.height = 1;
}
function fail(code: string) { if (closed) return; post({ type: 'error', code }); notice.textContent = 'This file could not be previewed.'; notice.hidden = false; canvas.hidden = true; destroy(); }
window.addEventListener('pagehide', destroy, { once: true });

async function chunk(begin: number, end: number): Promise<Uint8Array> {
  if (closed || !port || !file || end - begin > MAX_RANGE || begin < 0 || end > file.sizeBytes || end <= begin) throw new Error('Invalid range');
  const key = `${begin}:${end}`, existing = cache.get(key); if (existing) return existing;
  // PDF.js may request several spans. Keep the actual cross-origin bridge bounded independently.
  while (pending.size >= 2) {
    await new Promise(resolve => setTimeout(resolve, 10)); if (closed) throw new Error('Preview closed');
  }
  const requestId = ++nextRequestId;
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Range timeout')); }, 25_000);
    pending.set(requestId, { begin, end, resolve, reject, timer });
    post({ type: 'range', requestId, begin, end });
  });
  while (cacheBytes + bytes.byteLength > 4 * 1024 * 1024 && cache.size) {
    const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.byteLength; cache.delete(oldest);
  }
  cache.set(key, bytes); cacheBytes += bytes.byteLength; return bytes;
}
async function span(begin: number, end: number): Promise<Uint8Array> {
  if (!file || !integer(begin) || !integer(end) || begin < 0 || end <= begin || end > file.sizeBytes || end - begin > MAX_BYTES) throw new Error('Invalid span');
  const bytes = new Uint8Array(end - begin);
  for (let cursor = begin; cursor < end; cursor += MAX_RANGE) bytes.set(await chunk(cursor, Math.min(end, cursor + MAX_RANGE)), cursor - begin);
  return bytes;
}
function dimensions(width: number, height: number) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0) || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('Canvas limit');
  const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (width * height)));
  const pixelsWidth = Math.floor(width * ratio), pixelsHeight = Math.floor(height * ratio);
  if (pixelsWidth > MAX_DIMENSION || pixelsHeight > MAX_DIMENSION) throw new Error('Canvas limit');
  canvas.width = pixelsWidth; canvas.height = pixelsHeight;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  return ratio;
}
function ready(pages: number) { notice.hidden = true; canvas.hidden = false; post({ type: 'ready', page: pageNumber, pages, zoom }); }
async function render() {
  if (closed || !file) return;
  const version = ++renderVersion; renderTask?.cancel();
  const timer = setTimeout(() => { if (version === renderVersion) fail('timeout'); }, 20_000);
  try {
    const available = Math.max(100, document.documentElement.clientWidth - 36);
    if (pdf) {
      const page = await pdf.getPage(pageNumber); if (closed || version !== renderVersion) return;
      const original = page.getViewport({ scale: 1 });
      if (fitting) zoom = Math.max(0.1, Math.min(4, available / original.width));
      const viewport = page.getViewport({ scale: zoom });
      const ratio = dimensions(viewport.width, viewport.height);
      const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('No canvas');
      // Canvas appearances only: no form widgets, annotation DOM, scripting manager, actions, or link handlers.
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (!closed && version === renderVersion) ready(pdf.numPages);
    } else if (image) {
      if (fitting) zoom = Math.max(0.1, Math.min(4, Math.min(1, available / image.width)));
      const width = image.width * zoom, height = image.height * zoom, ratio = dimensions(width, height);
      const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('No canvas');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.drawImage(image, 0, 0, width, height);
      ready(1);
    }
  } catch (error) {
    if (!closed && version === renderVersion && !(error instanceof Error && error.name === 'RenderingCancelledException')) fail(error instanceof Error && error.message === 'Canvas limit' ? 'too-complex' : 'render-failed');
  } finally { clearTimeout(timer); }
}
async function openFile() {
  if (!file) return;
  try {
    if (file.kind === 'image') {
      const bytes = await span(0, file.sizeBytes);
      image = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: file.mimeType }));
      if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS) { fail('too-complex'); return; }
      await render(); return;
    }
    const pdfjs = await import('pdfjs-dist');
    if (closed) return;
    nativeWorker = new Worker(workerUrl, { type: 'module', name: 'dreampost-pdf-preview' });
    nativeWorker.addEventListener('error', () => fail('worker-failed'), { once: true });
    // Supplying the actual Worker port bypasses PDF.js's automatic worker/fake-worker selection.
    pdfWorker = pdfjs.PDFWorker.create({ port: nativeWorker });
    class Transport extends pdfjs.PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number) {
        void span(begin, end).then(bytes => { if (!closed) this.onDataRange(begin, bytes); }).catch(() => fail('invalid-data'));
      }
      override abort() { /* The parent owns cancellation; destroy() also terminates the explicit parser worker. */ }
    }
    const range = new Transport(file.sizeBytes, new Uint8Array(), false);
    loading = pdfjs.getDocument({ range, worker: pdfWorker, rangeChunkSize: MAX_RANGE,
      disableAutoFetch: true, disableStream: true, enableXfa: false, stopAtErrors: true, pdfBug: false,
      maxImageSize: MAX_PIXELS, canvasMaxAreaInBytes: MAX_PIXELS * 4, useSystemFonts: false, useWasm: false,
      cMapUrl: `${location.origin}/pdfjs/cmaps/`, cMapPacked: true, standardFontDataUrl: `${location.origin}/pdfjs/standard_fonts/`,
      wasmUrl: `${location.origin}/pdfjs/wasm/`, iccUrl: `${location.origin}/pdfjs/iccs/`,
    });
    loading.onPassword = () => fail('password');
    pdf = await loading.promise;
    if (closed) return;
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) { fail('too-complex'); return; }
    await render();
  } catch { if (!closed) fail('render-failed'); }
}

function receivePort(event: MessageEvent) {
  const data = record(event.data); if (!data || data.instanceId !== instanceId) { fail('invalid-data'); return; }
  if (data.type === 'range-result' && integer(data.requestId)) {
    const request = pending.get(data.requestId);
    if (!request || data.begin !== request.begin || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength !== request.end - request.begin) { fail('invalid-data'); return; }
    pending.delete(data.requestId); clearTimeout(request.timer); request.resolve(new Uint8Array(data.bytes)); return;
  }
  if (data.type === 'command' && typeof data.command === 'string') {
    if (data.command === 'previous' && pdf) pageNumber = Math.max(1, pageNumber - 1);
    else if (data.command === 'next' && pdf) pageNumber = Math.min(pdf.numPages, pageNumber + 1);
    else if (data.command === 'zoom-in') { fitting = false; zoom = Math.min(4, zoom * 1.2); }
    else if (data.command === 'zoom-out') { fitting = false; zoom = Math.max(0.1, zoom / 1.2); }
    else if (data.command === 'fit') fitting = true;
    else { fail('invalid-data'); return; }
    void render(); return;
  }
  fail('invalid-data');
}

async function initialize() {
  if (!/^[0-9a-f-]{36}$/i.test(instanceId) || window.parent === window) throw new Error('No preview parent');
  const origin = new URL(parentOrigin);
  if (origin.origin !== parentOrigin || origin.hostname === location.hostname) throw new Error('Preview origin is not isolated');
  const response = await fetch('/preview-config.json', { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('Preview configuration unavailable');
  const config: unknown = await response.json(); const configuration = record(config);
  if (!Array.isArray(configuration?.parentOrigins) || !configuration.parentOrigins.includes(parentOrigin)) throw new Error('Parent not allowed');
  window.addEventListener('message', event => {
    if (initialized || event.origin !== parentOrigin || event.source !== parent || event.ports.length !== 1) return;
    const data = record(event.data), descriptor = record(data?.file);
    if (data?.type !== 'dreampost-preview-init' || data.version !== 1 || data.instanceId !== instanceId || !descriptor
      || !['pdf', 'image'].includes(String(descriptor.kind)) || !integer(descriptor.sizeBytes) || descriptor.sizeBytes < 1 || descriptor.sizeBytes > MAX_BYTES
      || descriptor.maxRangeBytes !== MAX_RANGE || typeof descriptor.mimeType !== 'string'
      || (descriptor.kind === 'pdf' ? descriptor.mimeType !== 'application/pdf' : !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(descriptor.mimeType))) return;
    initialized = true; file = descriptor as unknown as FileDescriptor; port = event.ports[0]!; port.onmessage = receivePort; port.start();
    notice.textContent = 'Rendering attachment…'; void openFile();
  });
  parent.postMessage({ type: 'dreampost-preview-ready', instanceId }, parentOrigin);
}
void initialize().catch(() => { notice.textContent = 'This preview is not available from this page.'; });
