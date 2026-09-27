import { describe, expect, it, vi } from 'vitest';
import { createPreviewBridge } from './bridge';

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = []; closed = false;
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  close() { this.closed = true; }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const request = { type: 'range', instanceId: 'preview-instance', requestId: 1, begin: 0, end: 4 };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('untrusted renderer range bridge', () => {
  it('returns only the exact requested bytes without transport credentials or URLs', async () => {
    const port = new Port(), readRange = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);
    const bridge = createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange, onEvent: vi.fn() });
    port.send(request); await tick();
    expect(readRange).toHaveBeenCalledWith(0, 4, expect.any(AbortSignal));
    expect(port.messages).toEqual([{ type: 'range-result', instanceId: request.instanceId, requestId: 1, begin: 0, bytes: new Uint8Array([1, 2, 3, 4]).buffer }]); bridge.close();
  });
  it.each([
    { ...request, instanceId: 'previous-preview' }, { ...request, begin: -1 }, { ...request, end: 11 },
    { ...request, end: 300_000 }, { ...request, begin: 0.5 }, { ...request, url: '/api/secrets' }, { type: 'fetch', instanceId: request.instanceId, url: 'https://evil.example' },
  ])('closes an invalid or over-scoped request %j before network access', data => {
    const port = new Port(), readRange = vi.fn(), event = vi.fn();
    createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange, onEvent: event }); port.send(data);
    expect(readRange).not.toHaveBeenCalled(); expect(port.closed).toBe(true); expect(event).toHaveBeenCalledWith({ type: 'error', code: 'invalid-data' });
  });
  it('rejects reuse of a request ID', async () => {
    const port = new Port(), event = vi.fn();
    createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange: async () => new ArrayBuffer(4), onEvent: event });
    port.send(request); await tick(); port.send(request); expect(port.closed).toBe(true);
  });
  it('cancels admitted work and stops queued requests when the overlay closes', async () => {
    const port = new Port(); const signals: AbortSignal[] = [];
    const readRange = vi.fn((_begin: number, _end: number, signal: AbortSignal) => new Promise<ArrayBuffer>((_resolve, reject) => {
      signals.push(signal); signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const bridge = createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange, onEvent: vi.fn() });
    for (let id = 1; id <= 6; id++) port.send({ ...request, requestId: id });
    expect(readRange).toHaveBeenCalledTimes(2); bridge.close(); await tick();
    expect(signals.every(signal => signal.aborted)).toBe(true); expect(readRange).toHaveBeenCalledTimes(2); expect(port.messages).toEqual([]);
  });
  it('fails closed when a renderer floods the bounded pending queue', async () => {
    const port = new Port(); const readRange = vi.fn((_begin: number, _end: number, signal: AbortSignal) => new Promise<ArrayBuffer>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange, onEvent: vi.fn() });
    for (let id = 1; id <= 7; id++) port.send({ ...request, requestId: id });
    await tick(); expect(port.closed).toBe(true); expect(readRange).toHaveBeenCalledTimes(2);
  });
  it('does not forward a transport body larger than the approved range', async () => {
    const port = new Port(); createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange: async () => new ArrayBuffer(5), onEvent: vi.fn() });
    port.send(request); await tick(); expect(port.closed).toBe(true); expect(port.messages).toEqual([]);
  });
  it('bounds parsed page metadata rather than trusting renderer claims', () => {
    const port = new Port(); createPreviewBridge(port, { instanceId: request.instanceId, sizeBytes: 10, readRange: vi.fn(), onEvent: vi.fn() });
    port.send({ type: 'ready', instanceId: request.instanceId, page: 1, pages: 999_999, zoom: 1 }); expect(port.closed).toBe(true);
  });
});
