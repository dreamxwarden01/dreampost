import type { MailContentFingerprint } from '../mail/content-fingerprint.js';
import type { ParsedReaderMessage } from '../reader-data.js';
import type { PoolClient } from 'pg';
import type { Actor } from '../auth/service.js';
import type { SenderEligibility } from '../addresses/types.js';
import type { RawBlobStore } from '../blob-store.js';
import type { MailAddress } from '@dreampost/protocol';
import type { DraftAttachment, DraftQuote, ComposeMode, OutboxSubmission } from '@dreampost/protocol';
import type { MailTransport } from '@dreampost/protocol';

export interface ReplySource {
  messageId: string; mailboxId: string; direction: 'inbound' | 'outbound'; contentVersion: string; sourceSha256: string;
  from: MailAddress[]; replyTo: MailAddress[]; to: MailAddress[]; cc: MailAddress[];
  subject: string; sentAt: string | null; text: string; messageIdHeader: string | null;
  inReplyTo: string[]; references: string[]; envelopeTo: string | null; attachments: DraftAttachment[]; attachmentsReady?: boolean;
}
export interface CopiedSourceAttachment {
  bytes: Uint8Array; filename: string; mimeType: string; sha256: string; sourceContentVersion: string; sourceSha256: string;
}
export interface SendSnapshot {
  submissionId: string; transportKey: string; draftId: string; draftVersion: number; mailboxId: string; authorPrincipalId: string;
  fromAllocationId: string; from: MailAddress; grantId: string; sendingGeneration: number; policyRevision: number; policyDigest: string;
  to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; envelopeRecipients: string[];
  subject: string; bodyText: string; quote: DraftQuote | null; mode: ComposeMode;
  sourceMessageId: string | null; inReplyTo: string[]; references: string[];
  messageIdHeader: string; date: string; attachments: DraftAttachment[];
}
export interface SentCopyInput extends SendSnapshot { rawSha256: string; rawSize: number; providerMessageId: string | null; rfcMessageId?: string | null }
export interface PreparedSent { rawSha256:string; rawSize:number; parsed:ParsedReaderMessage; contentFingerprint:MailContentFingerprint|null }
export interface OutboundDependencies {
  resolvePrincipal(principalId: string, client: PoolClient, options?: {readOnly?:boolean}): Promise<Actor>;
  listSendingIdentities(principalId: string): Promise<SenderEligibility[]>;
  loadSource(client: PoolClient, actorId: string, mailboxId: string, messageId: string): Promise<ReplySource>;
  selfAddresses(client: PoolClient, mailboxId: string, sourceMessageId?: string): Promise<string[]>;
  copyAttachment(actorId: string, mailboxId: string, messageId: string, attachmentId: string): Promise<CopiedSourceAttachment>;
  withSenderAdmission<T>(request: { principalId: string; mailboxId: string; allocationId: string }, work: (client: PoolClient, sender: SenderEligibility) => Promise<T>): Promise<T>;
  prepareSent(snapshot:SentCopyInput):Promise<PreparedSent>;
  persistSent(client: PoolClient, snapshot: SentCopyInput, prepared:PreparedSent): Promise<string>;
  blobs: RawBlobStore;
  transport?: MailTransport;
  now?: () => number;
}
export interface Admission { snapshot: SendSnapshot; attemptId: string; startDeadline: number; rawSha256: string; rawSize: number }
export type { OutboxSubmission };
