import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ApiConfig } from './config.js';
import { UUID } from './config.js';
import type { AuthService } from './auth/service.js';
import type { AddressService } from './addresses/service.js';
import type { RawBlobStore } from './blob-store.js';
import type { OutboundDependencies, ReplySource, SentCopyInput, PreparedSent } from './outbound/types.js';
import { ApiError } from './errors.js';
import { getReaderData, parseMimeIsolated, storeReaderData } from './reader-data.js';
import { attachmentManifestSha256, extractAttachmentsIsolated } from './attachments/extractor.js';
import { enqueueAttachmentExtraction, getAttachment, listAttachments } from './attachments/service.js';
import { appendChange } from './database.js';
import { indexMessageThread, initializeMessageState, normalizeMessageId } from './mail/threading.js';

interface SourceRow {
  id: string; mailbox_id: string; direction: 'inbound' | 'outbound'; sha256: string; raw_size: number;
  metadata: { envelopeTo?: unknown }; received_at: Date; plain_text: string;
}

/** Connect composing to the existing mailbox/raw-store authority without public file paths. */
export function createOutboundDependencies(
  config: ApiConfig, pool: Pool, auth: AuthService, addresses: AddressService, blobs: RawBlobStore,
): OutboundDependencies {
  async function sourceRow(actorId: string, mailboxId: string, messageId: string, client?: PoolClient): Promise<SourceRow> {
    if (![mailboxId, messageId].every(value => UUID.test(value))) throw new ApiError(404, 'source_not_found');
    const actor = await auth.resolvePrincipal(actorId, client, { lock: false });
    if (!actor.permissions.has('mailbox.use')) throw new ApiError(403, 'source_access_denied');
    const row = (await (client ?? pool).query<SourceRow>(`SELECT d.id,d.mailbox_id,d.direction,d.sha256,d.raw_size,d.metadata,d.received_at,d.plain_text FROM deliveries d
      JOIN mailboxes m ON m.id=d.mailbox_id JOIN mailbox_memberships mm ON mm.mailbox_id=m.id
      WHERE d.id=$1 AND d.mailbox_id=$2 AND d.deleted_at IS NULL AND m.enabled
      AND mm.principal_id=$3 AND mm.revoked_at IS NULL AND 'read'=ANY(mm.permissions)`, [messageId, mailboxId, actorId])).rows[0];
    if (!row) throw new ApiError(404, 'source_not_found');
    return row;
  }
  const contentVersion = (row: SourceRow, version: number) => `${row.sha256}:${version}:html-render-policy-1`;
  const identifiers = (values: string[] | undefined): string[] => [...new Set((values ?? []).slice(0, 100)
    .map(normalizeMessageId).filter((value): value is string => value !== null).map(value => `<${value}>`))];
  async function loadSource(client: PoolClient, actorId: string, mailboxId: string, messageId: string): Promise<ReplySource> {
    const row = await sourceRow(actorId, mailboxId, messageId, client);
    const reader = await getReaderData(client, messageId);
    // Derived metadata may change across parser upgrades; immutable raw bytes bind the draft.
    // Parsing belongs to the bounded background job, never a composing write transaction.
    if (!reader || reader.parserVersion < 2 || !reader.headers.addresses
      || !Array.isArray(reader.headers.references) || !Array.isArray(reader.headers.inReplyTo)) {
      throw new ApiError(409, 'source_preparing');
    }
    const headers = reader.headers;
    const visible = headers.addresses!;
    const attachments = await listAttachments(client, messageId);
    return {
      messageId, mailboxId, direction: row.direction, sourceSha256: row.sha256, contentVersion: contentVersion(row, reader.parserVersion),
      from: visible.from, replyTo: visible.replyTo, to: visible.to, cc: visible.cc,
      subject: headers.subject, sentAt: headers.sentAt, text: row.plain_text,
      messageIdHeader: normalizeMessageId(headers.messageId) ? `<${normalizeMessageId(headers.messageId)}>` : null,
      inReplyTo: identifiers(headers.inReplyTo), references: identifiers(headers.references),
      envelopeTo: row.direction === 'inbound' && typeof row.metadata.envelopeTo === 'string' ? row.metadata.envelopeTo : null,
      attachments: attachments.items.map(item => ({ id: item.id, filename: item.filename, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256 })),
      attachmentsReady: (headers.attachmentCount ?? 0) === 0 || attachments.items.length === headers.attachmentCount,
    };
  }
  async function prepareSent(snapshot: SentCopyInput): Promise<PreparedSent> {
    const raw = await blobs.get(snapshot.rawSha256);
    if (raw.length !== snapshot.rawSize || createHash('sha256').update(raw).digest('hex') !== snapshot.rawSha256) {
      throw new Error('sent_copy_source_mismatch');
    }
    return { rawSha256: snapshot.rawSha256, rawSize: snapshot.rawSize, parsed: await parseMimeIsolated(raw) };
  }
  async function persistSent(client: PoolClient, snapshot: SentCopyInput, prepared: PreparedSent): Promise<string> {
    if (prepared.rawSha256 !== snapshot.rawSha256 || prepared.rawSize !== snapshot.rawSize) throw new Error('sent_copy_preparation_mismatch');
    // A canonical submission ID also gives its one Sent copy a stable idempotent identity.
    const id = snapshot.submissionId;
    await client.query('SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE', [snapshot.mailboxId]);
    const existing = (await client.query<{ mailbox_id: string; sha256: string; raw_size: number; direction: string; metadata: { kind?: string; submissionId?: string } }>(
      'SELECT mailbox_id,sha256,raw_size,direction,metadata FROM deliveries WHERE id=$1', [id])).rows[0];
    if (existing) {
      if (existing.mailbox_id !== snapshot.mailboxId || existing.sha256 !== snapshot.rawSha256 || existing.raw_size !== snapshot.rawSize
        || existing.direction !== 'outbound' || existing.metadata.kind !== 'outbound' || existing.metadata.submissionId !== id) throw new Error('sent_copy_identity_conflict');
      return id;
    }
    const parsed = prepared.parsed;
    const metadata = { kind: 'outbound', submissionId: id, envelopeFrom: snapshot.from.address, providerMessageId: snapshot.providerMessageId };
    await client.query(`INSERT INTO deliveries(id,mailbox_id,metadata,sha256,raw_size,received_at,direction,parse_status,subject,from_header,to_header,plain_text,preview)
      VALUES($1,$2,$3,$4,$5,$6,'outbound','parsed',$7,$8,$9,$10,$11)`,
      [id,snapshot.mailboxId,metadata,snapshot.rawSha256,snapshot.rawSize,snapshot.date,parsed.subject,parsed.from,parsed.to,parsed.text,parsed.preview]);
    await storeReaderData(client, id, parsed.reader);
    await initializeMessageState(client, { mailboxId: snapshot.mailboxId, messageId: id, direction: 'outbound' });
    await indexMessageThread(client, { mailboxId: snapshot.mailboxId, messageId: id, messageIdHeader: parsed.reader.headers.messageId,
      references: parsed.reader.headers.references, inReplyTo: parsed.reader.headers.inReplyTo, parserVersion: parsed.reader.parserVersion });
    if (config.downloads) await enqueueAttachmentExtraction(client, id);
    await appendChange(client, snapshot.mailboxId, id, 'message.sent');
    return id;
  }
  return {
    resolvePrincipal: (id, client, options) => auth.resolvePrincipal(id, client, { lock: !options?.readOnly }),
    listSendingIdentities: id => addresses.listSendingIdentities(id), loadSource,
    async selfAddresses(client, mailboxId, sourceMessageId?: string) {
      const result = await client.query<{ address: string }>(`SELECT DISTINCT a.address FROM address_allocations a
        WHERE a.mailbox_id=$1 AND (a.ended_at IS NULL OR EXISTS(SELECT 1 FROM deliveries d
          WHERE d.id=$2 AND d.mailbox_id=$1 AND d.received_at>=a.created_at AND d.received_at<a.ended_at))`, [mailboxId, sourceMessageId ?? null]);
      return result.rows.map(row => row.address);
    },
    async copyAttachment(actorId, mailboxId, messageId, attachmentId) {
      if (!UUID.test(attachmentId)) throw new ApiError(404, 'source_attachment_not_found');
      const row = await sourceRow(actorId, mailboxId, messageId);
      const item = await getAttachment(pool, messageId, attachmentId);
      if (!item || item.mailboxId !== mailboxId) throw new ApiError(404, 'source_attachment_not_found');
      const association = (await pool.query<{ ordinal: number; manifest_sha256: string | null }>(`SELECT a.ordinal,i.manifest_sha256
        FROM message_attachments a JOIN attachment_inventories i ON i.delivery_id=a.delivery_id
        WHERE a.delivery_id=$1 AND a.attachment_id=$2`, [messageId, attachmentId])).rows[0];
      if (!association?.manifest_sha256) throw new ApiError(409, 'source_attachments_preparing');
      const extraction = await extractAttachmentsIsolated(await blobs.get(row.sha256));
      const part = extraction.parts.find(value => value.ordinal === association.ordinal);
      if (attachmentManifestSha256(extraction.parts) !== association.manifest_sha256 || !part
        || part.sha256 !== item.sha256 || part.sizeBytes !== item.sizeBytes || part.filename !== item.filename || part.mimeType !== item.mimeType) throw new ApiError(409, 'source_attachment_changed');
      const current = await sourceRow(actorId, mailboxId, messageId);
      if (current.sha256 !== row.sha256 || current.raw_size !== row.raw_size) throw new ApiError(409, 'source_attachment_changed');
      const reader = await getReaderData(pool, messageId);
      return { bytes: part.bytes, filename: item.filename, mimeType: item.mimeType, sha256: part.sha256,
        sourceSha256: row.sha256, sourceContentVersion: contentVersion(row, reader?.parserVersion ?? 0) };
    },
    withSenderAdmission: (input, work) => addresses.withSenderAdmission(input, work), prepareSent, persistSent, blobs,
  };
}
