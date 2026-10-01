import { describe, expect, it } from 'vitest';
import { decodeMessage, type MailCopy, type MailMessage, type MailState } from './api';
import { applyCopyStates, archiveDestination, containsCopy, filingCopies, mergeMessagePages, mutationCopies, sameMessage } from './copies';
const sent: MailCopy = { id: 'sent', version: 'opaque-sent', folder: 'archive', read: true, starred: false, direction: 'outbound', labelIds: ['sent-label'] };
const received: MailCopy = { id: 'received', version: 'opaque-received', folder: 'inbox', read: false, starred: false, direction: 'inbound', labelIds: ['received-label'] };
function message(copies = [sent, received], id = sent.id): MailMessage {
  const representative = copies.find(copy => copy.id === id)!;
  return { ...representative, id, copyGroupId: 'group', copies, threadId: 'thread', read: copies.every(copy => copy.read), starred: copies.some(copy => copy.starred), labelIds: [...new Set(copies.flatMap(copy => copy.labelIds))], subject: 'Synthetic self-copy', from: 'owner@example.test', to: 'owner@example.test', receivedAt: '2026-10-01T00:00:00Z', preview: 'Synthetic content', status: 'parsed', sizeBytes: 100 };
}
function state(copy: MailCopy, changes: Partial<MailState> = {}): MailState { return { ...copy, threadId: 'thread', ...changes }; }
describe('verified-copy presentation and actions', () => {
  it('decodes only visible copy state and never forwards private outbox fields', () => {
    const raw = { ...message(), bcc: ['private@example.test'], copies: [{ ...sent, bcc: ['private@example.test'] }, received] };
    expect(JSON.stringify(decodeMessage(raw))).not.toContain('private@example.test');
    expect(decodeMessage(raw).copies).toEqual([sent, received]);
  });
  it('keeps an older API response as a singleton without guessing a copy relation', () => {
    const { copyGroupId: _group, copies: _copies, ...legacy } = message();
    const result = decodeMessage(legacy); expect(result.copyGroupId).toBe(legacy.id); expect(result.copies).toHaveLength(1);
    expect(() => decodeMessage({ ...legacy, copyGroupId: 'partial' })).toThrow();
  });
  it('rejects missing representatives, repeated IDs and numeric per-copy concurrency tokens', () => {
    expect(() => decodeMessage({ ...message(), copies: [received] })).toThrow();
    expect(() => decodeMessage({ ...message(), copies: [sent, sent] })).toThrow();
    expect(() => decodeMessage({ ...message(), copies: [{ ...sent, version: 2 }, received] })).toThrow();
  });
  it('targets all visible copies for flags but only inbound copies for filing and labels', () => {
    expect(mutationCopies([message()], { set: { read: true } }).map(copy => copy.id)).toEqual(['received']);
    expect(mutationCopies([message()], { set: { read: false } }).map(copy => copy.id)).toEqual(['sent', 'received']);
    expect(mutationCopies([message([sent])], { set: { read: true } })).toEqual([]);
    expect(mutationCopies([message()], { set: { folder: 'trash' } }).map(copy => copy.id)).toEqual(['received']);
    expect(mutationCopies([message()], { addLabelIds: ['new'] }).map(copy => copy.id)).toEqual(['received']);
    expect(filingCopies(message([sent]))).toEqual([sent]);
    expect(mutationCopies([message([received], received.id)], { set: { starred: true } })).toEqual([received]);
    expect(archiveDestination(message())).toBe('archive');
    expect(archiveDestination(message([sent, { ...received, folder: 'archive' }]))).toBe('inbox');
  });
  it('never silently truncates a bulk operation after expanding stored copies', () => {
    const copies = Array.from({ length: 101 }, (_, index) => ({ ...received, id: `received-${index}` }));
    expect(() => mutationCopies([message(copies, copies[0]!.id)], { set: { read: true } })).toThrow('100 stored copies');
    expect(mutationCopies([message(), message()], { set: { read: true } })).toHaveLength(1);
    expect(() => mutationCopies([message(), message([{ ...sent, version: 'changed' }])], { set: { starred: true } })).toThrow('changed');
  });
  it('conditionally patches each copy while refusing to overwrite fresher opaque versions', () => {
    const initial = message(), changed = new Map([['sent', state(sent, { version: 'new-sent', starred: true })], ['received', state(received, { version: 'new-received', read: true })]]);
    const updated = applyCopyStates(initial, changed, new Map([['sent', sent.version], ['received', 'stale-received']]));
    expect(updated.starred).toBe(true); expect(updated.read).toBe(false); expect(updated.copies[1]).toEqual(received);
    expect(updated.version).toBe('new-sent');
    const complete = applyCopyStates(updated, changed, new Map([['received', received.version]]));
    expect(complete.read).toBe(true); expect(complete.copies[1]!.version).toBe('new-received');
    expect(applyCopyStates(complete, changed, new Map())).toBe(complete);
  });
  it('does not apply a stale representative thread receipt while updating another copy', () => {
    const changes = new Map([['sent', state(sent, { threadId: 'stale-thread' })], ['received', state(received, { read: true, labelIds: ['updated'] })]]);
    const result = applyCopyStates(message(), changes, new Map([['received', received.version]]));
    expect(result.threadId).toBe('thread'); expect(result.labelIds).toEqual(['sent-label', 'updated']);
  });
  it('collapses all overlapping earlier rows at the first position after late correlation', () => {
    const beforeSent = { ...message([sent]), copyGroupId: sent.id };
    const beforeReceived = { ...message([received], received.id), copyGroupId: received.id };
    const unrelated = { ...message([{ ...sent, id: 'other' }], 'other'), copyGroupId: 'other' };
    const grouped = message();
    expect(mergeMessagePages([beforeSent, unrelated, beforeReceived], [grouped])).toEqual([grouped, unrelated]);
    expect(mergeMessagePages([unrelated, beforeReceived, beforeSent], [grouped, grouped])).toEqual([unrelated, grouped]);
  });
  it('retains logical selection across late correlation and representative changes', () => {
    const before = { ...message([received], received.id), copyGroupId: received.id }, after = message();
    expect(sameMessage(before, after)).toBe(true); expect(containsCopy(after, received.id)).toBe(true);
    expect(mergeMessagePages([before], [after])).toEqual([after]);
    expect(sameMessage(before, { ...message([{ ...sent, id: 'foreign' }], 'foreign'), copyGroupId: 'foreign' })).toBe(false);
  });
});
