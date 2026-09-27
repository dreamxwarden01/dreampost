import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_INBOUND_BYTES } from '@dreampost/protocol';
import { attachmentUuidV7 } from '../src/attachments/uuid.js';
import { attachmentManifest, extractAttachmentsIsolated, getAttachmentExtractorActivity } from '../src/attachments/extractor.js';
import { FileAttachmentStagingStore } from '../src/attachments/storage.js';

vi.mock('node:crypto', async importOriginal => { const actual = await importOriginal<typeof import('node:crypto')>(); return { ...actual, randomBytes: vi.fn(actual.randomBytes) }; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N2sAAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function mime(parts: Array<{ name?: string; type?: string; bytes: Buffer; cid?: string }>) {
  return Buffer.from('From: sender@example.test\r\nTo: reader@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n'
    + '--fixture\r\nContent-Type: text/plain\r\n\r\nOuter body\r\n'
    + parts.map(part => `--fixture\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\nContent-Disposition: attachment; filename="${part.name ?? 'file.bin'}"\r\n${part.cid ? `Content-ID: <${part.cid}>\r\n` : ''}Content-Transfer-Encoding: base64\r\n\r\n${part.bytes.toString('base64')}\r\n`).join('') + '--fixture--\r\n');
}
afterEach(() => { expect(getAttachmentExtractorActivity()).toEqual({ active: 0, queued: 0 }); vi.mocked(randomBytes).mockClear(); });

describe('CSPRNG attachment identity and isolated MIME extraction', () => {
  it('encodes UUIDv7 time/version/variant while preserving all 74 CSPRNG bits and fails closed on entropy errors', () => {
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(16, 0xff) as never);
    expect(attachmentUuidV7(0x010203040506)).toBe('01020304-0506-7fff-bfff-ffffffffffff');
    expect(randomBytes).toHaveBeenLastCalledWith(16);
    vi.mocked(randomBytes).mockImplementationOnce(() => { throw new Error('entropy_unavailable'); });
    expect(() => attachmentUuidV7()).toThrow('entropy_unavailable');
    expect(() => attachmentUuidV7(-1)).toThrow('invalid_uuid_timestamp');
  });
  it('preserves raw bytes and includes zero-byte and duplicate identical parts as distinct ordered source tuples', async () => {
    const bytes = Buffer.from('Exact binary\u0000payload');
    const raw = mime([{ bytes }, { bytes }, { bytes: Buffer.alloc(0) }]), before = Buffer.from(raw);
    const result = await extractAttachmentsIsolated(raw);
    expect(raw).toEqual(before);
    expect(result.parts.map(part => [part.ordinal, part.sizeBytes, part.sha256])).toEqual([[0, bytes.length, hash(bytes)], [1, bytes.length, hash(bytes)], [2, 0, hash(Buffer.alloc(0))]]);
    expect(Buffer.from(result.parts[0]!.bytes)).toEqual(bytes);
    expect(attachmentManifest(result.parts)[0]).toMatchObject({ filename: 'file.bin', disposition: 'attachment', mimeType: 'application/octet-stream', contentId: null });
  });
  it('selects preview eligibility from bounded raster/PDF bytes rather than claimed MIME and never extracts PDF text', async () => {
    const pdf = Buffer.from('%PDF-1.7\nFixture document bytes');
    const result = await extractAttachmentsIsolated(mime([
      { bytes: png, type: 'text/html', name: 'image.html', cid: 'Image@fixture' },
      { bytes: pdf, type: 'text/html', name: 'document.html' },
      { bytes: Buffer.from('<svg onload="bad()"/>'), type: 'image/png', name: 'bad.png' },
    ]));
    expect(result.parts.map(part => [part.previewKind, part.mediaType])).toEqual([['raster', 'image/png'], ['pdf', 'application/pdf'], ['none', 'application/octet-stream']]);
    expect(result.parts[0]!.contentId).toBe('<Image@fixture>');
    expect(Buffer.from(result.parts[1]!.bytes)).toEqual(pdf);
    expect(Object.keys(result.parts[1]!)).not.toContain('text');
  });
  it('preserves calendar transfer-decoded bytes instead of rewriting charset, CRLF or trailing newlines', async () => {
    const latin1 = Buffer.from('BEGIN:VCALENDAR\r\nSUMMARY:caf\xe9\r\nEND:VCALENDAR\r\n\r\n', 'latin1');
    const second = Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
    const nested = mime([{ bytes: latin1, type: 'text/calendar; charset=iso-8859-1', name: 'inside.ics' }]);
    const result = await extractAttachmentsIsolated(mime([
      { bytes: latin1, type: 'text/calendar; charset=iso-8859-1', name: 'event.ics' },
      { bytes: nested, type: 'message/rfc822', name: 'nested-calendar.eml' },
      { bytes: second, type: 'application/ics', name: 'second.ics' },
      { bytes: latin1, type: 'text/calendar; charset=iso-8859-1', name: 'duplicate.ics' },
    ]));
    expect(result.parts).toHaveLength(4);
    expect(result.parts.map(part => Buffer.from(part.bytes))).toEqual([latin1, nested, second, latin1]);
    expect(result.parts.map(part => part.sha256)).toEqual([hash(latin1), hash(nested), hash(second), hash(latin1)]);
  });
  it('keeps nested EML as one opaque attachment instead of merging its child documents', async () => {
    const nested = mime([{ bytes: Buffer.from('%PDF-1.7\nNested') }]);
    const result = await extractAttachmentsIsolated(mime([{ bytes: nested, type: 'message/rfc822', name: 'nested.eml' }]));
    expect(result.parts).toHaveLength(1);
    expect(Buffer.from(result.parts[0]!.bytes)).toEqual(nested);
    expect(result.parts[0]!.previewKind).toBe('none');
  });
  it('rejects the entire over-count inventory rather than returning a partial successful list', async () => {
    await expect(extractAttachmentsIsolated(mime(Array.from({ length: 101 }, () => ({ bytes: Buffer.from('x') }))))).rejects.toMatchObject({ code: 'attachment_count_limit' });
    expect((await extractAttachmentsIsolated(mime(Array.from({ length: 100 }, () => ({ bytes: Buffer.alloc(0) }))))).parts).toHaveLength(100);
  });
  it('rejects oversized sources, terminates deadlines, and releases bounded queue slots', async () => {
    await expect(extractAttachmentsIsolated(new Uint8Array(MAX_INBOUND_BYTES + 1))).rejects.toMatchObject({ code: 'attachment_input_size_limit' });
    await expect(extractAttachmentsIsolated(mime([]), { timeoutMs: 1 })).rejects.toMatchObject({ code: 'attachment_extraction_timeout' });
    const attempts = Array.from({ length: 12 }, () => extractAttachmentsIsolated(mime([])));
    expect(getAttachmentExtractorActivity()).toEqual({ active: 2, queued: 8 });
    const results = await Promise.allSettled(attempts);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['attachment_extractor_busy', 'attachment_extractor_busy']);
  });
  it('denies oversized raster dimensions without denying download of the original bytes', async () => {
    const giant = Buffer.from(png); giant.writeUInt32BE(100000, 16);
    const result = await extractAttachmentsIsolated(mime([{ bytes: giant, type: 'image/png' }]));
    expect(result.parts[0]).toMatchObject({ previewKind: 'none', mediaType: 'application/octet-stream', sizeBytes: giant.length });
  });
});

describe('immutable local attachment staging', () => {
  it('respects configured filesystem headroom before writing a new staged payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-disk-pressure-'));
    try {
      const store = new FileAttachmentStagingStore(root, { minimumFreeBytes: Number.MAX_SAFE_INTEGER });
      const bytes = Buffer.from('Do not consume reserved free space');
      await expect(store.put(attachmentUuidV7(), hash(bytes), bytes)).rejects.toMatchObject({ code: 'attachment_staging_disk_pressure' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('publishes durable bytes idempotently, recovers a bounded stale partial, and never uses MIME filenames as paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-stage-'));
    try {
      const store = new FileAttachmentStagingStore(root), id = attachmentUuidV7(), bytes = Buffer.from('Stored fixture'), sha256 = hash(bytes);
      await store.put(id, sha256, bytes);
      await store.put(id, sha256, bytes);
      expect(await store.get(id, sha256)).toEqual(bytes);
      const path = join(root, id.slice(0, 2), id, `${sha256}.bin`);
      await writeFile(`${path}.partial`, 'interrupted bytes');
      await rm(path);
      await store.put(id, sha256, bytes);
      expect(await readFile(path)).toEqual(bytes);
      expect(await readdir(join(root, id.slice(0, 2), id))).toEqual([`${sha256}.bin`]);
      await expect(store.put(id, sha256, Buffer.from('wrong bytes'))).rejects.toThrow('attachment_digest_mismatch');
      await expect(store.get('../../escape', sha256)).rejects.toThrow('invalid_attachment_storage_identity');
      await store.remove(id, sha256); await store.remove(id, sha256);
      await expect(store.get(id, sha256)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
