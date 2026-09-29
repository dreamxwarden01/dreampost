import { describe, expect, it, vi } from 'vitest';
import { MailApiError } from '../mailbox/api';
import type { Draft } from './api';
import { AttachmentBatchPaused, droppedFiles, isFileTransfer, MAX_DRAFT_ATTACHMENT_PARTS, SerialAttachmentBatch, validateAttachmentSelection } from './attachment-drop';
const draft = (): Draft => ({ id: 'draft', mailboxId: 'box', authorPrincipalId: 'actor', version: 1, state: 'editing', mode: 'new', sourceMessageId: null, fromAllocationId: null, to: [], cc: [], bcc: [], subject: '', bodyText: '', quote: null, attachments: [], updatedAt: '2026-09-29T00:00:00Z', warnings: [] });
const file = (name: string, size = 1) => new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });
const transfer = (files: File[], items: unknown[] = files.map(value => ({ kind: 'file', getAsFile: () => value, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) })), types = ['Files']) => ({ files, items, types }) as unknown as DataTransfer;
const saved = (base: Draft, file: File): Draft => ({ ...base, version: base.version + 1, attachments: [...base.attachments, { id: `part-${base.version}`, filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: 'a'.repeat(64) }] });

describe('body file-drop selection', () => {
  it('detects file metadata before protected drag contents become readable and ignores text/URL drags', () => {
    expect(isFileTransfer(transfer([], [], ['Files']))).toBe(true);
    expect(isFileTransfer(transfer([], [{ kind: 'file' }], []))).toBe(true);
    expect(isFileTransfer(transfer([], [{ kind: 'string' }], ['text/plain', 'text/uri-list']))).toBe(false);
    expect(isFileTransfer(null)).toBe(false);
  });
  it('keeps all files in order, including a zero-byte file, without reading string URLs', async () => {
    const one = file('one.txt'), empty = file('empty.txt', 0), readString = vi.fn();
    const data = transfer([one, empty], [{ kind: 'file', getAsFile: () => one }, { kind: 'string', getAsString: readString }, { kind: 'file', getAsFile: () => empty }]);
    expect(await droppedFiles(data)).toEqual([one, empty]); expect(readString).not.toHaveBeenCalled();
  });
  it('rejects a mixed directory/file drop without traversing or returning a partial selection', async () => {
    const traverse = vi.fn(); const one = file('one.txt');
    await expect(droppedFiles(transfer([one], [{ kind: 'file', getAsFile: () => one }, { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, createReader: traverse }) }]))).rejects.toThrow('Folders cannot be attached');
    expect(traverse).not.toHaveBeenCalled();
  });
  it('rejects directory handles and captures every item before the asynchronous boundary', async () => {
    const one = file('one.txt'), second = file('second.txt'); let readable = true;
    const data = transfer([one, second], [{ kind: 'file', getAsFile: () => one, getAsFileSystemHandle: async () => { readable = false; return { kind: 'directory' }; } }, { kind: 'file', getAsFile: () => second }]);
    await expect(droppedFiles(data)).rejects.toThrow('Folders cannot be attached'); expect(readable).toBe(false);
  });
  it('rejects unreadable items, mismatched inventories and relative directory paths', async () => {
    await expect(droppedFiles(transfer([], [{ kind: 'file', getAsFile: () => null }]))).rejects.toThrow('could not be read');
    await expect(droppedFiles(transfer([file('one'), file('two')], [{ kind: 'file', getAsFile: () => file('one') }]))).rejects.toThrow('could not be read');
    const relative = file('inside.txt'); Object.defineProperty(relative, 'webkitRelativePath', { value: 'folder/inside.txt' });
    await expect(droppedFiles(transfer([relative]))).rejects.toThrow('Folders cannot be attached');
  });
  it('validates the whole new selection together with existing bytes and parts', () => {
    const existing = saved(draft(), file('existing', 4));
    expect(() => validateAttachmentSelection([file('one', 3), file('two', 4)], existing, 10)).toThrow('remaining draft attachment budget');
    expect(() => validateAttachmentSelection([file('one', 3), file('two', 3)], existing, 10)).not.toThrow();
    expect(() => validateAttachmentSelection([file('large', 11)], draft(), 10)).toThrow('configured attachment limit');
    const full = { ...draft(), attachments: Array.from({ length: MAX_DRAFT_ATTACHMENT_PARTS - 1 }, () => existing.attachments[0]!) };
    expect(() => validateAttachmentSelection([file('one'), file('two')], full, 1000)).toThrow('up to 32');
    expect(() => validateAttachmentSelection([file('one')], draft(), undefined)).toThrow('limits are unavailable');
  });
});

describe('serial attachment batches', () => {
  it('uses the acknowledged version for each subsequent file and distinct mutation identities', async () => {
    let keys = 0; const batch = new SerialAttachmentBatch([file('one'), file('two'), file('three')], draft(), () => `key-${++keys}`);
    const calls: Array<[string, number, string]> = [], confirmed = vi.fn();
    await batch.run({ allowed: () => true, upload: async (base, part, key) => { calls.push([part.name, base.version, key]); return saved(base, part); }, confirmed });
    expect(calls).toEqual([['one', 1, 'key-1'], ['two', 2, 'key-2'], ['three', 3, 'key-3']]); expect(batch.progress).toMatchObject({ completed: 3, remainingNames: [] }); expect(confirmed).toHaveBeenCalledTimes(3);
  });
  it('retries a middle file after a lost committed ACK with the original key, never replaying the confirmed prefix', async () => {
    let key = 0, lost = false; const receipts = new Map<string, Draft>(), calls: Array<[string, number, string]> = []; let stored = draft();
    const batch = new SerialAttachmentBatch([file('one'), file('two'), file('three')], stored, () => `key-${++key}`);
    const options = { allowed: () => true, upload: async (base: Draft, part: File, identity: string) => {
      calls.push([part.name, base.version, identity]); if (receipts.has(identity)) return receipts.get(identity)!;
      stored = saved(base, part); receipts.set(identity, stored);
      if (part.name === 'two' && !lost) { lost = true; throw new MailApiError('Response lost'); } return stored;
    }, confirmed: vi.fn() };
    await expect(batch.run(options)).rejects.toThrow('Response lost'); expect(batch.progress).toMatchObject({ completed: 1, remainingNames: ['two', 'three'] }); expect(batch.hasUnconfirmedAttempt).toBe(true);
    await batch.run(options); expect(calls).toEqual([['one', 1, 'key-1'], ['two', 2, 'key-2'], ['two', 2, 'key-2'], ['three', 3, 'key-3']]); expect(stored.attachments).toHaveLength(3); expect(batch.hasUnconfirmedAttempt).toBe(false);
  });
  it('preserves an earlier ambiguous identity through later authorization refusal', async () => {
    let count = 0; const keys: string[] = []; const batch = new SerialAttachmentBatch([file('one')], draft(), () => 'original-key');
    const options = { allowed: () => true, upload: async (base: Draft, part: File, key: string) => { keys.push(key); if (++count === 1) throw new MailApiError('Lost'); if (count === 2) throw new MailApiError('Expired', 403); return saved(base, part); }, confirmed: vi.fn() };
    await expect(batch.run(options)).rejects.toThrow('Lost'); await expect(batch.run(options)).rejects.toThrow('Expired'); expect(batch.hasUnconfirmedAttempt).toBe(true); await batch.run(options); expect(keys).toEqual(['original-key', 'original-key', 'original-key']);
  });
  it('does not start a new file after known authority loss and resumes only the unconfirmed suffix', async () => {
    let allowed = true; const calls: string[] = []; const batch = new SerialAttachmentBatch([file('one'), file('two')], draft(), () => crypto.randomUUID());
    const options = { allowed: () => allowed, upload: async (base: Draft, part: File) => { calls.push(part.name); return saved(base, part); }, confirmed: () => { allowed = false; } };
    await expect(batch.run(options)).rejects.toBeInstanceOf(AttachmentBatchPaused); expect(calls).toEqual(['one']);
    allowed = true; await batch.run(options); expect(calls).toEqual(['one', 'two']);
  });
  it('blocks overlapping batch runners and never advances an unverified response', async () => {
    let release!: (value: Draft) => void; const pending = new Promise<Draft>(done => { release = done; }); const batch = new SerialAttachmentBatch([file('one')], draft(), () => 'same');
    const options = { allowed: () => true, upload: async () => pending, confirmed: vi.fn() }; const first = batch.run(options);
    await expect(batch.run(options)).rejects.toThrow('already running'); release({ ...draft(), id: 'wrong', version: 2 }); await expect(first).rejects.toThrow('could not be verified'); expect(batch.progress.completed).toBe(0); expect(batch.hasUnconfirmedAttempt).toBe(true);
  });
  it('retains confirmed-prefix progress on a later definitive validation failure', async () => {
    const batch = new SerialAttachmentBatch([file('one'), file('bad')], draft(), () => crypto.randomUUID());
    await expect(batch.run({ allowed: () => true, upload: async (base, part) => { if (part.name === 'bad') throw new MailApiError('Rejected', 413); return saved(base, part); }, confirmed: vi.fn() })).rejects.toThrow('Rejected');
    expect(batch.progress).toMatchObject({ completed: 1, remainingNames: ['bad'] }); expect(batch.hasUnconfirmedAttempt).toBe(false);
  });
});
