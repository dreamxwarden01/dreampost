/** Mailbox-scoped API data. Header addresses and thread membership never grant access. */
export interface MailAddress { name: string; address: string }
export type MailDirection = 'inbound' | 'outbound';
export type MailFolder = 'inbox' | 'archive' | 'trash' | 'spam';
export type MailViewFolder = MailFolder | 'sent' | 'all';
export interface MailCapabilities { canSetPersonalFlags: boolean; canManageMessages: boolean; canManageLabels: boolean }
export interface MailMessageState {
  id: string; threadId: string | null; read: boolean; starred: boolean; folder: MailFolder; labelIds: string[];
  /** Opaque filing:personal version. Only components affected by a mutation are compared. */
  version: string;
}
export interface MailMessageCopy {
  id: string; version: string; folder: MailFolder; read: boolean; starred: boolean;
  direction: MailDirection; labelIds: string[];
}
export interface MailMessageSummary extends MailMessageState {
  /** Stable, mailbox-local display equivalence; resource access still uses id. */
  copyGroupId: string;
  /** Only folder-visible, already-authorized copies; never private outbox data. */
  copies: MailMessageCopy[];
  subject: string; from: string; to: string; receivedAt: string; preview: string;
  status: 'pending' | 'parsed' | 'failed'; sizeBytes: number; direction: MailDirection;
}
export interface MailThreadSummary {
  id: string; subject: string; preview: string; receivedAt: string; from: string; to: string;
  messageCount: number; matchedCount: number; unreadCount: number; starred: boolean; lastMessageId: string;
}
export interface MailListResult {
  view: 'messages' | 'threads'; messages?: MailMessageSummary[]; threads?: MailThreadSummary[];
  nextCursor: string | null; changeSequence: string; capabilities: MailCapabilities;
}
export interface MailMutationInput {
  operationId: string; items: Array<{ id: string; version: string }>;
  set?: { read?: boolean; starred?: boolean; folder?: MailFolder };
  addLabelIds?: string[]; removeLabelIds?: string[];
}
export interface MailMutationResult {
  operationId: string; messages: MailMessageState[]; changeSequence: string; undoUntil: string | null;
}
export interface MailLabel { id: string; name: string; color: string | null; version: string }
export interface MailLabelMutationResult { operationId: string; label?: MailLabel; deletedId?: string; changeSequence: string }
export interface MailChangesResult {
  changes: Array<{ sequence: string; kind: string; messageId: string | null }>;
  nextSequence: string; hasMore: boolean; resetRequired: boolean;
}
