import type { PoolClient } from 'pg';
import { UUID } from '../config.js';
import { appendChange } from '../database.js';
import { linkOutboundMessageId, normalizeProviderRfcMessageId, type OutboundMessageIdLink } from '../mail/threading.js';

export interface VerifiedOutboundMessageIdRepair {
  mailboxId: string; submissionId: string;
  expectedRawSha256: string; expectedRawSize: number; expectedProviderMessageId: string;
  rfcMessageId: string; operatorLabel: string;
}
/**
 * Local operator maintenance only; callers must independently verify provider
 * evidence and own the transaction. This is never a tracking-ID heuristic or a
 * public API. Pin any expected thread membership in the same mailbox-locked
 * transaction before calling. The raw source, parsed headers and snapshot stay
 * immutable. Repeating the exact evidence is safe; conflicting evidence fails.
 */
export async function recordVerifiedOutboundRfcMessageId(
  client: PoolClient, input: VerifiedOutboundMessageIdRepair,
): Promise<OutboundMessageIdLink & { recorded: boolean }> {
  const wire = normalizeProviderRfcMessageId(input.rfcMessageId);
  if (!UUID.test(input.mailboxId) || !UUID.test(input.submissionId) || !wire
    || !/^[0-9a-f]{64}$/.test(input.expectedRawSha256)
    || !Number.isSafeInteger(input.expectedRawSize) || input.expectedRawSize < 0
    || typeof input.expectedProviderMessageId !== 'string' || !input.expectedProviderMessageId
    || Buffer.byteLength(input.expectedProviderMessageId) > 998 || /[\x00-\x1f\x7f]/.test(input.expectedProviderMessageId)
    || typeof input.operatorLabel !== 'string' || !/^[ -~]{1,128}$/.test(input.operatorLabel) || !input.operatorLabel.trim()) {
    throw new Error('invalid_outbound_message_id_repair');
  }
  await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE', [input.mailboxId]);
  const row = (await client.query<{ rfc_message_id: string | null }>(`SELECT s.rfc_message_id
    FROM outbound_submissions s JOIN deliveries d ON d.id=s.id AND d.mailbox_id=s.mailbox_id
    WHERE s.id=$1 AND s.mailbox_id=$2 AND s.state IN ('accepted','partial')
      AND s.provider_message_id=$3 AND s.raw_sha256=$4 AND s.raw_size=$5
      AND d.sha256=s.raw_sha256 AND d.raw_size=s.raw_size AND d.direction='outbound' AND d.deleted_at IS NULL
      AND d.metadata->>'kind'='outbound' AND d.metadata->>'submissionId'=s.id::text
      AND (s.sent_message_id IS NULL OR s.sent_message_id=d.id)
    FOR UPDATE OF s`, [input.submissionId,input.mailboxId,input.expectedProviderMessageId,input.expectedRawSha256,input.expectedRawSize])).rows[0];
  if (!row) throw new Error('outbound_message_id_repair_binding_mismatch');
  if (row.rfc_message_id !== null && row.rfc_message_id !== wire) throw new Error('outbound_rfc_message_id_conflict');
  const recorded = row.rfc_message_id === null;
  if (recorded) {
    await client.query('UPDATE outbound_submissions SET rfc_message_id=$2,version=version+1,updated_at=now() WHERE id=$1', [input.submissionId,wire]);
    await appendChange(client,input.mailboxId,input.submissionId,'message.provider_identity_recorded',
      {data:{operatorLabel:input.operatorLabel,rfcMessageId:wire}});
  }
  return { ...await linkOutboundMessageId(client,{mailboxId:input.mailboxId,messageId:input.submissionId}), recorded };
}
