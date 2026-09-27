import type { MailAddress } from './mail.js';
export type ComposeMode = 'new' | 'reply' | 'reply_all' | 'reply_person' | 'forward';
export interface DraftAttachment { id: string; filename: string; mimeType: string; sizeBytes: number; sha256: string }
export interface DraftQuote {
  sourceMessageId: string; sourceContentVersion: string; sourceSha256?: string; include: boolean;
  attribution: { from: MailAddress[]; to: MailAddress[]; cc: MailAddress[]; subject: string; sentAt: string | null };
  text: string;
}
export interface Draft {
  id: string; mailboxId: string; authorPrincipalId: string; version: number; state: 'editing' | 'queued' | 'discarded'; mode: ComposeMode;
  sourceMessageId: string | null; fromAllocationId: string | null; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[];
  subject: string; bodyText: string; quote: DraftQuote | null; attachments: DraftAttachment[]; updatedAt: string; warnings: string[];
}
export type OutboundState = 'queued' | 'dispatching' | 'accepted' | 'partial' | 'failed' | 'blocked' | 'unknown' | 'cancelled';
export interface OutboxSubmission {
  id: string; mailboxId: string; draftId: string; version: number; state: OutboundState; from: MailAddress;
  to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; subject: string; errorCode: string | null;
  recipients: Array<{ address: string; status: 'pending' | 'accepted' | 'failed' | 'unknown'; code: string | null }>;
  sentCopyState: 'none' | 'pending' | 'done'; sentMessageId: string | null; createdAt: string; updatedAt: string;
}

/** Bounded list data. Full body/quote and attachments are loaded only by draft detail. */
export type DraftSummary = Pick<Draft,'id'|'mailboxId'|'version'|'state'|'mode'|'subject'|'updatedAt'> & {
  /** First three To recipients, not an editable recipient list. */
  to: MailAddress[]; recipientCount: number; attachmentCount: number;
};
