import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailApiError } from '../mailbox/api';
import { DraftSession } from './DraftSession';
import { editable, type Draft, type EditableDraft } from './api';
const draft = (): Draft => ({ id: 'draft-one', mailboxId: 'mailbox-one', authorPrincipalId: 'principal-one', version: 1, state: 'editing', mode: 'new', sourceMessageId: null, fromAllocationId: null, to: [], cc: [], bcc: [], subject: '', bodyText: '', quote: null, attachments: [], updatedAt: '2026-09-27T00:00:00Z', warnings: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function result(base: Draft, fields: EditableDraft): Draft { return { ...base, ...fields, version: base.version + 1 }; }
describe('DraftSession save ordering', () => {
  it('does not replace newer edits with an older acknowledgement and saves the next revision', async () => {
    const first = deferred<Draft>(); const calls: Array<{ base: Draft; fields: EditableDraft }> = [];
    const saver = vi.fn(async (base: Draft, fields: EditableDraft) => { calls.push({ base, fields }); return calls.length === 1 ? first.promise : result(base, fields); });
    const session = new DraftSession(draft(), saver, () => 'key'); session.edit('bodyText', 'First edit'); const saving = session.save();
    session.edit('bodyText', 'Newer edit'); first.resolve(result(calls[0]!.base, calls[0]!.fields)); await saving;
    expect(calls.map(c => c.fields.bodyText)).toEqual(['First edit', 'Newer edit']); expect(calls.map(c => c.base.version)).toEqual([1, 2]);
    expect(session.snapshot().fields.bodyText).toBe('Newer edit'); expect(session.snapshot().draft.version).toBe(3); expect(session.snapshot().savedSequence).toBe(session.snapshot().sequence);
  });
  it('retries the same immutable mutation after a lost response before sending newer edits', async () => {
    const calls: Array<{ fields: EditableDraft; key: string; version: number }> = []; let n = 0;
    const session = new DraftSession(draft(), async (base, fields, key) => { calls.push({ fields, key, version: base.version }); if (calls.length === 1) throw new MailApiError('Lost response'); return result(base, fields); }, () => `key-${++n}`);
    session.edit('subject', 'Snapshot one'); await expect(session.save()).rejects.toThrow('Lost response'); session.edit('subject', 'Snapshot two'); await session.save();
    expect(calls.map(c => [c.key, c.fields.subject, c.version])).toEqual([['key-1', 'Snapshot one', 1], ['key-1', 'Snapshot one', 1], ['key-2', 'Snapshot two', 2]]);
  });
  it('uses corrected edits after a definitive validation rejection instead of replaying invalid fields forever', async () => {
    const calls: string[] = []; let n = 0;
    const session = new DraftSession(draft(), async (base, fields) => { calls.push(fields.subject); if (fields.subject.length > 10) throw new MailApiError('Invalid subject', 400, 'invalid_draft_field'); return result(base, fields); }, () => `key-${++n}`);
    session.edit('subject', 'Invalid overlong subject'); await expect(session.save()).rejects.toThrow('Invalid subject'); session.edit('subject', 'Corrected'); await session.save();
    expect(calls).toEqual(['Invalid overlong subject', 'Corrected']); expect(session.snapshot().draft.subject).toBe('Corrected');
  });
  it('settles an in-flight invalid save without requiring rejected local fields to persist before discard', async () => {
    const session = new DraftSession(draft(), async () => { throw new MailApiError('Rejected', 413); }); session.edit('bodyText', 'Too large'); await expect(session.save()).rejects.toThrow();
    expect((await session.settle()).version).toBe(1); expect(session.snapshot().fields.bodyText).toBe('Too large');
  });
  it('serializes concurrent flushes', async () => { const pending = deferred<Draft>(); const saver = vi.fn(() => pending.promise); const session = new DraftSession(draft(), saver); session.edit('subject', 'Hello'); const one = session.save(), two = session.save(); expect(one).toBe(two); expect(saver).toHaveBeenCalledTimes(1); pending.resolve({ ...draft(), version: 2, subject: 'Hello' }); await one; });
  it('preserves incomplete recipients during save without claiming send validation', async () => { let saved: EditableDraft | undefined; const session = new DraftSession(draft(), async (base, fields) => { saved = fields; return result(base, fields); }); session.edit('to', [{ name: '', address: 'unfinished@' }]); await session.save(); expect(saved!.to).toEqual([{ name: '', address: 'unfinished@' }]); });
  it('stops writes on a version conflict and keeps all local edits', async () => { const saver = vi.fn(async () => { throw new MailApiError('Conflict', 409, 'draft_version_conflict'); }); const session = new DraftSession(draft(), saver); session.edit('bodyText', 'Keep this'); await expect(session.save()).rejects.toThrow('Conflict'); session.edit('bodyText', 'Keep this newer text'); await expect(session.save()).rejects.toThrow('Resolve'); expect(saver).toHaveBeenCalledTimes(1); expect(session.snapshot().fields.bodyText).toBe('Keep this newer text'); expect(session.snapshot().conflict).toBe(true); });
  it('adopts a new attachment revision without overwriting local fields', () => { const session = new DraftSession(draft(), async d => d); session.edit('bodyText', 'Typing during a separate operation'); session.acceptAction({ ...draft(), version: 2, attachments: [{ id: 'attachment', filename: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 2, sha256: 'a'.repeat(64) }] }); expect(session.snapshot().fields.bodyText).toContain('Typing'); expect(session.snapshot().draft.attachments).toHaveLength(1); });
  it('never accepts a save result from another resource', async () => { const session = new DraftSession(draft(), async d => ({ ...d, id: 'different', version: 2 })); session.edit('bodyText', 'Local text'); await expect(session.save()).rejects.toThrow('Invalid draft save acknowledgement'); expect(session.snapshot().draft.id).toBe('draft-one'); });
  it('does not acknowledge an aborted save or clear unsaved content', async () => { const pending = deferred<Draft>(); const session = new DraftSession(draft(), () => pending.promise); session.edit('bodyText', 'Unconfirmed'); const promise = session.save(); session.dispose(); pending.resolve({ ...draft(), version: 2, bodyText: 'Unconfirmed' }); await expect(promise).rejects.toMatchObject({ name: 'AbortError' }); expect(session.snapshot().savedSequence).toBe(0); });
  it('can replace a conflicted view only through an explicit latest-version action', async () => { const session = new DraftSession(draft(), async () => { throw new MailApiError('Conflict', 409); }); session.edit('bodyText', 'Mine'); await expect(session.save()).rejects.toThrow(); const latest = { ...draft(), version: 7, bodyText: 'Their saved text' }; session.replaceWithLatest(latest); expect(session.snapshot().fields).toEqual(editable(latest)); expect(session.snapshot().conflict).toBe(false); });
});


describe('DraftSession automatic recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  const options = { enabled: true, accessActive: true, authContext: 'session-one' };
  it.each([undefined, 429, 503])('automatically retries a transient %s failure with the same immutable key', async status => {
    const calls: Array<{ key: string; text: string }> = [];
    const session = new DraftSession(draft(), async (base, fields, key) => { calls.push({ key, text: fields.bodyText }); if (calls.length === 1) throw new MailApiError('Temporary', status); return result(base, fields); });
    session.configureAutosave(options); session.edit('bodyText', 'Only one edit'); await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999); expect(calls).toHaveLength(1); await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(session.snapshot().savedSequence).toBe(session.snapshot().sequence); expect(session.snapshot().retryAt).toBeNull(); session.dispose();
  });
  it('caps one retry timer at 60 seconds without replaying missed timers after a pause', async () => {
    const saver = vi.fn(async () => { throw new MailApiError('Unavailable', 503); }); const session = new DraftSession(draft(), saver);
    session.configureAutosave(options); session.edit('bodyText', 'Dirty');
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) { await vi.advanceTimersByTimeAsync(delay); expect(saver).toHaveBeenCalledTimes(index + 1); expect(vi.getTimerCount()).toBe(1); }
    session.configureAutosave({ ...options, enabled: false }); await vi.advanceTimersByTimeAsync(600000); expect(saver).toHaveBeenCalledTimes(8);
    session.configureAutosave(options); await vi.advanceTimersByTimeAsync(0); expect(saver).toHaveBeenCalledTimes(9); expect(vi.getTimerCount()).toBe(1); session.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('honors Retry-After beyond the capped backoff, including manual attempts before that minimum', async () => {
    const saver = vi.fn(async (base: Draft, fields: EditableDraft) => { if (saver.mock.calls.length === 1) throw new MailApiError('Busy', 429, 'outbound_busy', 90000); return result(base, fields); });
    const session = new DraftSession(draft(), saver); session.configureAutosave(options); session.edit('bodyText', 'Pending'); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60000); expect(saver).toHaveBeenCalledTimes(1); await expect(session.save()).rejects.toMatchObject({ code: 'retry_later' });
    await vi.advanceTimersByTimeAsync(30000); expect(saver).toHaveBeenCalledTimes(2); session.dispose();
  });
  it('keeps newer edits while retrying the old snapshot, then saves a fresh mutation', async () => {
    let key = 0; const calls: Array<{ key: string; text: string }> = [];
    const session = new DraftSession(draft(), async (base, fields, mutation) => { calls.push({ key: mutation, text: fields.bodyText }); if (calls.length === 1) throw new MailApiError('Offline'); return result(base, fields); }, () => `key-${++key}`);
    session.configureAutosave(options); session.edit('bodyText', 'Before outage'); await vi.advanceTimersByTimeAsync(1000); session.edit('bodyText', 'Edited during outage');
    await vi.advanceTimersByTimeAsync(2000); expect(session.snapshot().fields.bodyText).toBe('Edited during outage'); await vi.advanceTimersByTimeAsync(1); expect(calls).toEqual([{ key: 'key-1', text: 'Before outage' }, { key: 'key-1', text: 'Before outage' }, { key: 'key-2', text: 'Edited during outage' }]);
    expect(session.snapshot().fields.bodyText).toBe('Edited during outage'); expect(session.snapshot().savedSequence).toBe(session.snapshot().sequence); session.dispose();
  });
  it.each([400, 413, 422])('gates validation %s until an edit corrects the fields, then resumes without a click', async status => {
    const calls: string[] = []; const session = new DraftSession(draft(), async (base, fields) => { calls.push(fields.subject); if (fields.subject === 'Bad') throw new MailApiError('Invalid subject', status); return result(base, fields); });
    session.configureAutosave(options); session.edit('subject', 'Bad'); await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(600000); expect(calls).toEqual(['Bad']);
    session.edit('subject', 'Corrected'); await vi.advanceTimersByTimeAsync(1000); expect(calls).toEqual(['Bad', 'Corrected']); expect(session.snapshot().error).toBeNull(); session.dispose();
  });
  it.each([401, 403])('does not retry authorization %s on edits or busy toggles, but resumes after fresh authentication', async status => {
    const keys: string[] = []; const session = new DraftSession(draft(), async (base, fields, key) => { keys.push(key); if (keys.length === 1) throw new MailApiError('Access unavailable', status); return result(base, fields); });
    session.configureAutosave(options); session.edit('bodyText', 'Before expiry'); await vi.advanceTimersByTimeAsync(1000); session.edit('bodyText', 'Preserved while expired');
    session.configureAutosave({ ...options, enabled: false }); session.configureAutosave(options); await vi.advanceTimersByTimeAsync(600000); expect(keys).toHaveLength(1);
    session.configureAutosave({ ...options, authContext: 'fresh-session' }); await vi.advanceTimersByTimeAsync(1); expect(keys[1]).toBe(keys[0]); expect(session.snapshot().savedSequence).toBe(session.snapshot().sequence); expect(session.snapshot().fields.bodyText).toBe('Preserved while expired'); session.dispose();
  });
  it('resumes a restored mailbox with unchanged CSRF after a confirmed inactive-to-active transition', async () => {
    const saver = vi.fn(async (base: Draft, fields: EditableDraft) => { if (saver.mock.calls.length === 1) throw new MailApiError('Mailbox revoked', 403); return result(base, fields); });
    const session = new DraftSession(draft(), saver); session.configureAutosave(options); session.edit('bodyText', 'Recover me'); await vi.advanceTimersByTimeAsync(1000);
    session.configureAutosave({ ...options, enabled: false, accessActive: false }); session.configureAutosave(options); await vi.advanceTimersByTimeAsync(0); expect(saver).toHaveBeenCalledTimes(2); session.dispose();
  });
  it('never clears a 409 conflict because of edits, time, or refreshed authentication', async () => {
    const saver = vi.fn(async () => { throw new MailApiError('Conflict', 409); }); const session = new DraftSession(draft(), saver); session.configureAutosave(options); session.edit('bodyText', 'Local'); await vi.advanceTimersByTimeAsync(1000);
    session.edit('bodyText', 'Still local'); session.configureAutosave({ ...options, authContext: 'new-session' }); await vi.advanceTimersByTimeAsync(600000); expect(saver).toHaveBeenCalledTimes(1); expect(session.snapshot().conflict).toBe(true); expect(session.snapshot().fields.bodyText).toBe('Still local'); session.dispose();
  });
  it('saves continuous typing within the maximum dirty interval', async () => {
    const saver = vi.fn(async (base: Draft, fields: EditableDraft) => result(base, fields)); const session = new DraftSession(draft(), saver); session.configureAutosave(options);
    for (let i = 0; i < 20; i++) { session.edit('bodyText', `Continuing ${i}`); await vi.advanceTimersByTimeAsync(500); }
    expect(saver).toHaveBeenCalledTimes(1); expect(session.snapshot().draft.bodyText).toBe('Continuing 19'); session.dispose();
  });
  it('an explicit send flush upgrades an in-flight autosave to include edits made during that save', async () => {
    const pending = deferred<Draft>(); const calls: Array<{ base: Draft; fields: EditableDraft }> = [];
    const session = new DraftSession(draft(), async (base, fields) => { calls.push({ base, fields }); return calls.length === 1 ? pending.promise : result(base, fields); }); session.configureAutosave(options); session.edit('bodyText', 'First'); await vi.advanceTimersByTimeAsync(1000);
    session.edit('bodyText', 'Final send text'); const flush = session.save(); pending.resolve(result(calls[0]!.base, calls[0]!.fields)); await flush;
    expect(calls).toHaveLength(2); expect(session.snapshot().savedSequence).toBe(session.snapshot().sequence); expect(session.snapshot().draft.bodyText).toBe('Final send text'); session.dispose();
  });
});
