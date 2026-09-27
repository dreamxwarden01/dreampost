import { describe, expect, it } from 'vitest';
import { renderHtmlIsolated, getHtmlRendererActivity } from '../src/html-reader.js';

const message = { html: '<p>Isolated reader</p>', remoteImages: 'blocked' as const };

describe('bounded HTML rendering workers', () => {
  it('rejects oversized source before dispatching an isolated task', async () => {
    await expect(renderHtmlIsolated({ ...message, html: 'x'.repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ statusCode: 422, code: 'html_source_too_large' });
    expect((await renderHtmlIsolated(message)).html).toContain('Isolated reader');
  });

  it('terminates timed-out rendering and releases capacity for subsequent messages', async () => {
    await expect(renderHtmlIsolated(message, { timeoutMs: 1 })).rejects.toMatchObject({ statusCode: 422, code: 'html_render_timeout' });
    expect((await renderHtmlIsolated(message)).html).toContain('Isolated reader');
  });

  it('bounds its waiting queue while preserving a two-worker process limit', async () => {
    const pending = Array.from({ length: 7 }, () => renderHtmlIsolated(message));
    expect(getHtmlRendererActivity()).toEqual({ active: 2, queued: 4 });
    const results = await Promise.allSettled(pending);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(6);
    const failure = results.find(result => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ statusCode: 503, code: 'reader_busy' });
    expect(getHtmlRendererActivity()).toEqual({ active: 0, queued: 0 });
  });

  it('one principal cannot occupy both active slots or duplicate its queued work', async () => {
    const results = await Promise.allSettled([
      renderHtmlIsolated(message, { principalKey: 'viewer-a' }),
      renderHtmlIsolated(message, { principalKey: 'viewer-a' }),
      renderHtmlIsolated(message, { principalKey: 'viewer-b' }),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[2]?.status).toBe('fulfilled');
    expect(results[1]?.status === 'rejected' && results[1].reason).toMatchObject({ statusCode: 429 });
  });

  it('cancelled client reads release their principal and worker reservation', async () => {
    const controller = new AbortController();
    const pending = renderHtmlIsolated(message, { principalKey: 'cancelled-viewer', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'reader_cancelled' });
    expect((await renderHtmlIsolated(message, { principalKey: 'cancelled-viewer' })).html).toContain('Isolated reader');
    expect(getHtmlRendererActivity()).toEqual({ active: 0, queued: 0 });
  });

  it('returns a bounded failure for deeply nested markup without poisoning later work', async () => {
    await expect(renderHtmlIsolated({ ...message, html: '<div>'.repeat(102) + 'body' + '</div>'.repeat(102) })).rejects.toMatchObject({ code: 'html_structure_too_complex' });
    expect((await renderHtmlIsolated(message)).html).toContain('Isolated reader');
  });
});
