import { MailApiError, type MailCopy, type MailMessage, type MailState, type MessageMutation } from './api';

/** Copy identities are evidence locators, never an authorization shortcut. */
export function sameMessage(left: MailMessage, right: MailMessage): boolean {
  return left.copyGroupId === right.copyGroupId || left.copies.some(copy => right.copies.some(other => other.id === copy.id));
}
export function containsCopy(message: MailMessage, id: string): boolean {
  return message.copyGroupId === id || message.copies.some(copy => copy.id === id);
}
export function filingCopies(message: MailMessage): MailCopy[] {
  const received = message.copies.filter(copy => copy.direction === 'inbound');
  return received.length ? received : message.copies.filter(copy => copy.id === message.id);
}
export function archiveDestination(message: MailMessage): 'inbox' | 'archive' {
  return filingCopies(message).every(copy => copy.folder === 'archive') ? 'inbox' : 'archive';
}
export function mutationCopies(messages: MailMessage[], change: Pick<MessageMutation, 'set' | 'addLabelIds' | 'removeLabelIds'>): MailCopy[] {
  const personal = change.set?.read !== undefined || change.set?.starred !== undefined;
  const filing = change.set?.folder !== undefined || !!change.addLabelIds?.length || !!change.removeLabelIds?.length;
  if (personal && filing) throw new MailApiError('Apply personal flags and filing changes separately.');
  const onlyUnread = change.set?.read === true && change.set.starred === undefined && !filing;
  const selected = new Map<string, MailCopy>();
  for (const message of messages) for (const copy of filing ? filingCopies(message) : message.copies) {
    if (onlyUnread && copy.read) continue;
    const previous = selected.get(copy.id);
    if (previous && previous.version !== copy.version) throw new MailApiError('A selected copy changed. Refresh before applying this action.');
    selected.set(copy.id, copy);
  }
  if (selected.size > 100) throw new MailApiError('Select fewer messages. This action would change more than 100 stored copies.');
  return [...selected.values()];
}
/** An accepted receipt only patches the exact per-copy snapshot that issued it. */
export function applyCopyStates(message: MailMessage, changes: ReadonlyMap<string, MailState>, expected: ReadonlyMap<string, string>): MailMessage {
  let changed = false;
  const copies = message.copies.map(copy => {
    const next = changes.get(copy.id);
    if (!next || copy.version !== expected.get(copy.id)) return copy;
    changed = true;
    return { id: copy.id, direction: copy.direction, version: next.version, folder: next.folder, read: next.read, starred: next.starred, labelIds: next.labelIds };
  });
  if (!changed) return message;
  const representative = copies.find(copy => copy.id === message.id)!;
  return { ...message, version: representative.version, folder: representative.folder, copies,
    threadId: message.version === expected.get(message.id) ? changes.get(message.id)?.threadId ?? message.threadId : message.threadId,
    read: copies.every(copy => copy.read), starred: copies.some(copy => copy.starred),
    labelIds: [...new Set(copies.flatMap(copy => copy.labelIds))].sort() };
}
export function mergeMessagePages(previous: MailMessage[], incoming: MailMessage[]): MailMessage[] {
  const result = [...previous];
  for (const message of incoming) {
    const index = result.findIndex(old => sameMessage(old, message));
    if (index < 0) result.push(message);
    else {
      // One late proof may join multiple entries loaded on earlier pages.
      result[index] = message;
      for (let other = result.length - 1; other > index; other--) if (sameMessage(result[other]!, message)) result.splice(other, 1);
    }
  }
  return result;
}
