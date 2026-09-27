import { afterEach, describe, expect, it } from 'vitest';
import { MAX_INBOUND_BYTES } from '@dreampost/protocol';
import { getReaderParserActivity, parseMimeIsolated, readerSummary } from '../src/reader-data.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N2sAAAAASUVORK5CYII=';
const raw = (body: string, headers = 'Content-Type: text/plain; charset=utf-8') => Buffer.from(
  'From: "Sender" <sender@example.test>\r\nTo: inbox@example.test\r\nReply-To: Help <reply@example.test>\r\n' +
  'Cc: Copy <copy@example.test>\r\nDate: Sat, 26 Sep 2026 10:11:12 +0200\r\nSubject: Reader test\r\n' +
  'Message-ID: <reader-test@example.test>\r\nMIME-Version: 1.0\r\n' + headers + '\r\n\r\n' + body,
);
const part = (cid: string, type = 'image/png', content = png) =>
  `--related\r\nContent-Type: ${type}\r\nContent-ID: <${cid}>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`;
const related = (parts: string[]) => raw('--related\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello</p><img src="cid:Logo@example.test">\r\n' + parts.join('') + '--related--\r\n', 'Content-Type: multipart/related; boundary="related"');

afterEach(() => { expect(getReaderParserActivity()).toEqual({ active: 0, queued: 0 }); });

describe('isolated MIME reader extraction', () => {
  it('decodes structured display headers and multilingual plain text without detaching original bytes', async () => {
    const original = raw('Hello \u4e16\u754c!');
    const before = Buffer.from(original);
    const result = await parseMimeIsolated(original);
    expect(original).toEqual(before);
    expect(result.text).toBe('Hello \u4e16\u754c!\n');
    expect(result.reader.headers).toMatchObject({ from: 'Sender <sender@example.test>', replyTo: 'Help <reply@example.test>',
      to: 'inbox@example.test', cc: 'Copy <copy@example.test>', sentAt: '2026-09-26T08:11:12.000Z', messageId: '<reader-test@example.test>' });
    expect(result.reader.htmlSource).toBeNull();
  });

  it('retains untrusted HTML internally while the public summary contains no body or claimed security result', async () => {
    const html = '<script>notExecuted()</script><p>Hello</p><img src="https://example.test/tracker">';
    const result = await parseMimeIsolated(raw(html, 'Content-Type: text/html; charset=utf-8'));
    expect(result.reader.htmlSource).toBe(html + '\n');
    expect(result.text).toBe('Hello');
    const summary = readerSummary(result.reader, { envelopeFrom: 'bounce@example.test', envelopeTo: 'alias@example.test' });
    expect(summary).toEqual({ hasHtml: true, replyTo: 'Help <reply@example.test>', cc: 'Copy <copy@example.test>',
      sentAt: '2026-09-26T08:11:12.000Z', envelopeFrom: 'bounce@example.test', envelopeTo: 'alias@example.test' });
    expect(JSON.stringify(summary)).not.toContain('notExecuted');
    expect(Object.keys(summary)).not.toContain('authenticated');
  });

  it('extracts bounded CID candidates with exact case-sensitive identifiers and excludes duplicate mappings', async () => {
    const result = await parseMimeIsolated(related([
      part('Logo@example.test'), part('logo@example.test'), part('duplicate@example.test'), part('duplicate@example.test'),
      part('vector@example.test', 'image/svg+xml', Buffer.from('<svg/>').toString('base64')),
    ]));
    expect(result.reader.inlineCandidates.map((item) => item.contentId)).toEqual(['Logo@example.test', 'logo@example.test']);
    expect(result.reader.inlineCandidates[0]).toEqual({ contentId: 'Logo@example.test', mimeType: 'image/png', base64: png, sizeBytes: Buffer.from(png, 'base64').length });
    expect(result.reader.warnings).toContain('duplicate_content_id');
    expect(result.reader.warnings).toContain('unsupported_inline_type');
  });

  it('caps inline count and per-image bytes before returning data to the parent', async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
    const result = await parseMimeIsolated(related([part('large@example.test', 'image/png', oversized), ...Array.from({ length: 22 }, (_, index) => part(`image-${index}@example.test`))]));
    expect(result.reader.inlineCandidates).toHaveLength(20);
    expect(result.reader.warnings).toContain('inline_image_size_limit');
    expect(result.reader.warnings).toContain('inline_image_total_limit');
  });

  it('keeps attached messages and PDF data out of the reading body', async () => {
    const eml = 'From: nested@example.test\r\nSubject: Nested\r\n\r\nNested attachment contents';
    const body = '--mixed\r\nContent-Type: text/plain\r\n\r\nOuter body\r\n' +
      '--mixed\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="nested.eml"\r\n\r\n' + eml + '\r\n' +
      '--mixed\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="file.pdf"\r\n\r\n%PDF-1.7 Secret document text\r\n--mixed--';
    const result = await parseMimeIsolated(raw(body, 'Content-Type: multipart/mixed; boundary="mixed"'));
    expect(result.text.trim()).toBe('Outer body');
    expect(result.text).not.toContain('Nested attachment');
    expect(JSON.stringify(result.reader)).not.toContain('Secret document');
  });

  it('omits oversized HTML with an explicit warning and does not infer a malformed sent date', async () => {
    const input = raw('x'.repeat(1024 * 1024 + 1), 'Content-Type: text/html').toString().replace('Sat, 26 Sep 2026 10:11:12 +0200', 'not-a-date');
    const result = await parseMimeIsolated(Buffer.from(input));
    expect(result.reader.htmlSource).toBeNull();
    expect(result.reader.warnings).toContain('html_too_large');
    expect(result.reader.headers.sentAt).toBeNull();
    expect(result.reader.headers.dateHeader).toBe('not-a-date');
  });

  it('rejects oversized raw input and terminates timed-out parsing while releasing capacity', async () => {
    await expect(parseMimeIsolated(new Uint8Array())).rejects.toMatchObject({ code: 'mime_input_size_limit' });
    await expect(parseMimeIsolated(new Uint8Array(MAX_INBOUND_BYTES + 1))).rejects.toMatchObject({ code: 'mime_input_size_limit' });
    await expect(parseMimeIsolated(raw('Timeout fixture'), { timeoutMs: 1 })).rejects.toMatchObject({ code: 'mime_parse_timeout' });
    expect((await parseMimeIsolated(raw('Recovered capacity'))).text).toBe('Recovered capacity\n');
  });

  it('bounds concurrent parser workers and queued work instead of spawning per request', async () => {
    const attempts = Array.from({ length: 12 }, () => parseMimeIsolated(raw('Bounded work')));
    expect(getReaderParserActivity()).toEqual({ active: 2, queued: 8 });
    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(10);
    expect(outcomes.filter((item) => item.status === 'rejected').map((item) => item.reason.code)).toEqual(['mime_parser_busy', 'mime_parser_busy']);
  });
});
