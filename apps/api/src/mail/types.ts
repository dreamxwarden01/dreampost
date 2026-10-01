import type { PoolClient } from 'pg';
import type { MailViewFolder } from '@dreampost/protocol';
export interface MailViewer { principalId: string | null; permissions: ReadonlySet<string>; developmentMailboxId?: string }
export type AuthorizeMailTransaction = (client: PoolClient) => Promise<MailViewer>;
export interface MailListOptions {
  view?: 'messages' | 'threads'; limit?: number; cursor?: string; folder?: MailViewFolder;
  /** Internal default is grouped; HTTP callers must explicitly opt in. */
  groupCopies?: boolean;
  unread?: boolean; starred?: boolean; labelId?: string; q?: string; threadId?: string;
}
export interface MailStreamReference { sessionId: string; principalId: string }
