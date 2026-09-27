import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { DownloadControlRequest, DownloadRedeemReply, DownloadAuthorizeReply } from '@dreampost/protocol';
import type { ApiConfig } from '../config.js';
import { UUID } from '../config.js';
import { ApiError } from '../errors.js';
import type { AuthService } from '../auth/service.js';
import { hashSecret, secretEqual } from '../auth/cookies.js';
import { getAttachment } from '../attachments/service.js';
import type { DownloadConfig } from './config.js';

const digest = /^[0-9a-f]{64}$/;
const token = /^[A-Za-z0-9_-]{43}$/;
const BOOTSTRAP_SECONDS = 120;
type Purpose = 'download' | 'preview';
interface Source { kind: 'sso' | 'development'; sessionId: string | null; principalId: string | null; devHash: string | null; expiresAt: number }
interface Session {
  id: string; source_kind: Source['kind']; source_session_id: string | null; principal_id: string | null;
  development_token_hash: string | null; flow_id: string; challenge_hash: string; ticket_hash: string;
  ticket_expires_at: Date; secret_hash: string | null; download_origin: string; expires_at: Date;
  redeemed_at: Date | null; activated_at: Date | null;
}
interface Transfer { id: string; session_id: string; attachment_id: string; delivery_id: string; purpose: Purpose }

export class DownloadService {
  readonly config: DownloadConfig;
  constructor(private readonly pool: Pool, private readonly appConfig: ApiConfig, private readonly auth?: AuthService) {
    if (!appConfig.downloads) throw new Error('Download configuration is required');
    this.config = appConfig.downloads;
  }

  private async sourceFor(request: FastifyRequest): Promise<Source> {
    if (this.auth) {
      const actor = await this.auth.authorizeRequest(request, { mutating: true });
      if (!actor.permissions.has('mailbox.use')) throw new ApiError(403, 'forbidden');
      const source = await this.auth.downloadSource(request);
      if (source.principalId !== actor.principalId || !UUID.test(source.sessionId)) throw new ApiError(401, 'authentication_required');
      return { kind: 'sso', sessionId: source.sessionId, principalId: source.principalId, devHash: null, expiresAt: source.expiresAt };
    }
    if (request.headers.origin !== new URL(this.appConfig.publicBaseUrl).origin) throw new ApiError(403, 'origin_rejected');
    if (!secretEqual(String(request.headers.authorization ?? ''), `Bearer ${this.appConfig.devViewToken}`)) throw new ApiError(401, 'authentication_required');
    return { kind: 'development', sessionId: null, principalId: null, devHash: hashSecret(this.appConfig.devViewToken), expiresAt: Date.now() + this.config.sessionTtlSeconds * 1000 };
  }

  private async validateSource(session: Session, client?: PoolClient): Promise<number> {
    if (session.download_origin !== this.config.origin || session.expires_at.getTime() <= Date.now()) throw new ApiError(401, 'download_session_expired');
    if (session.source_kind === 'sso') {
      if (!this.auth || !session.source_session_id || !session.principal_id) throw new ApiError(401, 'download_session_expired');
      const source = await this.auth.authorizeSessionReference(session.source_session_id, session.principal_id, client);
      if (!source.actor.permissions.has('mailbox.use')) throw new ApiError(403, 'forbidden');
      return source.expiresAt;
    }
    if (this.auth || !session.development_token_hash || !secretEqual(session.development_token_hash, hashSecret(this.appConfig.devViewToken))) throw new ApiError(401, 'download_session_expired');
    return session.expires_at.getTime();
  }

  private async resource(deliveryId: string, attachmentId: string, principalId: string | null, purpose: Purpose, client?: PoolClient) {
    const db = client ?? this.pool;
    const attachment = await getAttachment(db, deliveryId, attachmentId);
    if (!attachment) throw new ApiError(404, 'attachment_unavailable');
    if (principalId) {
      const allowed = await db.query(`SELECT 1 FROM mailbox_memberships WHERE mailbox_id=$1 AND principal_id=$2
        AND revoked_at IS NULL AND 'read'=ANY(permissions)`, [attachment.mailboxId, principalId]);
      if (!allowed.rowCount) throw new ApiError(404, 'attachment_unavailable');
    } else if (attachment.mailboxId !== this.appConfig.devMailboxId) throw new ApiError(404, 'attachment_unavailable');
    if (attachment.state !== 'ready') throw new ApiError(409, 'attachment_preparing');
    if (purpose === 'preview' && (attachment.previewKind === 'none' || attachment.sizeBytes > this.config.maxPreviewBytes || attachment.sizeBytes === 0)) throw new ApiError(422, 'preview_unavailable');
    return attachment;
  }

  async create(request: FastifyRequest, deliveryId: string, attachmentId: string, input: unknown): Promise<{ ticket: string }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_download_request');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(k => !['flowId','challengeHash','purpose'].includes(k)) || typeof body.flowId !== 'string' || !UUID.test(body.flowId)
      || typeof body.challengeHash !== 'string' || !digest.test(body.challengeHash) || !['download','preview'].includes(String(body.purpose))) throw new ApiError(400, 'invalid_download_request');
    if (!UUID.test(deliveryId) || !UUID.test(attachmentId)) throw new ApiError(404, 'attachment_unavailable');
    const purpose = body.purpose as Purpose;
    const source = await this.sourceFor(request);
    await this.resource(deliveryId, attachmentId, source.principalId, purpose);
    const ticket = randomBytes(32).toString('base64url');
    const sessionId = randomUUID(), transferId = randomUUID();
    const now = Date.now();
    const expiresAt = Math.min(now + this.config.sessionTtlSeconds * 1000, source.expiresAt);
    const ticketExpiresAt = Math.min(expiresAt, now + BOOTSTRAP_SECONDS * 1000);
    if (ticketExpiresAt <= now) throw new ApiError(401, 'authentication_required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('attachment-download-source'),hashtext($1))", [source.sessionId ?? source.devHash!]);
      await client.query(`DELETE FROM attachment_download_sessions WHERE expires_at<=now()
        OR (activated_at IS NULL AND ticket_expires_at<=now())`);
      const counts = await client.query<{ total: string; pending: string }>(`SELECT count(*) AS total,
        count(*) FILTER(WHERE activated_at IS NULL) AS pending FROM attachment_download_sessions
        WHERE ($1::uuid IS NOT NULL AND source_session_id=$1) OR ($2::text IS NOT NULL AND development_token_hash=$2)`, [source.sessionId, source.devHash]);
      if (Number(counts.rows[0]!.total) >= this.config.maxSessions || Number(counts.rows[0]!.pending) >= this.config.maxPendingSessions) throw new ApiError(429, 'download_session_limit');
      await client.query(`INSERT INTO attachment_download_sessions
        (id,source_kind,source_session_id,principal_id,development_token_hash,flow_id,challenge_hash,ticket_hash,ticket_expires_at,download_origin,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [sessionId,source.kind,source.sessionId,source.principalId,source.devHash,body.flowId,body.challengeHash,hashSecret(ticket),new Date(ticketExpiresAt),this.config.origin,new Date(expiresAt)]);
      await client.query(`INSERT INTO attachment_download_transfers(session_id,id,attachment_id,delivery_id,purpose) VALUES($1,$2,$3,$4,$5)`,
      [sessionId,transferId,attachmentId,deliveryId,purpose]);
      await client.query('COMMIT');
      return { ticket };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /** Add separately authorized files to this page's existing active cookie session. */
  async addTransfer(request: FastifyRequest, deliveryId: string, attachmentId: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_download_request');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(k => !['sessionId', 'purpose'].includes(k)) || typeof body.sessionId !== 'string'
      || !UUID.test(body.sessionId) || !['download', 'preview'].includes(String(body.purpose))) throw new ApiError(400, 'invalid_download_request');
    const purpose = body.purpose as Purpose;
    const source = await this.sourceFor(request);
    await this.resource(deliveryId, attachmentId, source.principalId, purpose);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Session>('SELECT * FROM attachment_download_sessions WHERE id=$1 FOR UPDATE', [body.sessionId]);
      const session = result.rows[0];
      if (!session || !session.redeemed_at || !session.activated_at || session.expires_at.getTime() <= Date.now()) throw new ApiError(409, 'download_session_unavailable');
      if (session.source_kind !== source.kind || session.source_session_id !== source.sessionId || session.principal_id !== source.principalId
        || session.development_token_hash !== source.devHash || session.download_origin !== this.config.origin) throw new ApiError(403, 'download_source_mismatch');
      const count = await client.query<{ count: string }>('SELECT count(*) FROM attachment_download_transfers WHERE session_id=$1', [session.id]);
      if (Number(count.rows[0]!.count) >= 100) throw new ApiError(429, 'download_transfer_limit');
      const transferId = randomUUID();
      await client.query('INSERT INTO attachment_download_transfers(session_id,id,attachment_id,delivery_id,purpose) VALUES($1,$2,$3,$4,$5)',
        [session.id, transferId, attachmentId, deliveryId, purpose]);
      await client.query('COMMIT');
      return { sessionId: session.id, transferId, purpose, expiresAt: Math.min(session.expires_at.getTime(), source.expiresAt),
        url: `${this.config.origin}/sessions/${session.id}/transfers/${transferId}` };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /** Classify only cookies presented by this browser; never revoke another live session. */
  async prune(input: Extract<DownloadControlRequest, { op: 'prune' }>) {
    const result = await this.pool.query<Session>('SELECT * FROM attachment_download_sessions WHERE id=ANY($1::uuid[])',
      [input.sessions.map(item => item.sessionId)]);
    const rows = new Map(result.rows.map(row => [row.id, row]));
    const expiredSessionIds: string[] = [];
    for (const proof of input.sessions) {
      const session = rows.get(proof.sessionId);
      if (!session || !session.secret_hash || !secretEqual(session.secret_hash, proof.secretHash)
        || session.expires_at.getTime() <= Date.now() || (!session.activated_at && session.ticket_expires_at.getTime() <= Date.now())) {
        expiredSessionIds.push(proof.sessionId);
        continue;
      }
      try { await this.validateSource(session); }
      catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.statusCode)) expiredSessionIds.push(proof.sessionId);
        else throw error; // Temporary database/identity failures must not erase otherwise valid browser cookies.
      }
    }
    return { version: 1 as const, op: 'prune' as const, expiredSessionIds };
  }

  async consumeNonce(keyId: string, nonce: string): Promise<void> {
    await this.pool.query('DELETE FROM attachment_control_nonces WHERE expires_at<=now()');
    const result = await this.pool.query(`INSERT INTO attachment_control_nonces(key_id,nonce,expires_at)
      VALUES($1,$2,now()+interval '3 minutes') ON CONFLICT DO NOTHING RETURNING nonce`, [keyId,nonce]);
    if (!result.rowCount) throw new ApiError(409, 'control_request_replayed');
  }

  async redeem(input: Extract<DownloadControlRequest, { op: 'redeem' }>): Promise<DownloadRedeemReply> {
    if (!token.test(input.ticket) || !digest.test(input.secretHash)) throw new ApiError(401, 'bootstrap_rejected');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Session>(`SELECT * FROM attachment_download_sessions
        WHERE flow_id=$1 AND ticket_hash=$2 FOR UPDATE`, [input.flowId,hashSecret(input.ticket)]);
      const session = rows[0];
      if (!session || session.redeemed_at || session.ticket_expires_at.getTime() <= Date.now() || !secretEqual(session.challenge_hash,input.challengeHash)) throw new ApiError(401, 'bootstrap_rejected');
      const transfer = await this.oneTransfer(client,session.id);
      const sourceExpiry = await this.validateSource(session, client);
      await this.resource(transfer.delivery_id,transfer.attachment_id,session.principal_id,transfer.purpose, client);
      const expiresAt = Math.min(session.ticket_expires_at.getTime(),sourceExpiry,session.expires_at.getTime());
      if (expiresAt <= Date.now()) throw new ApiError(401, 'bootstrap_rejected');
      await client.query('UPDATE attachment_download_sessions SET secret_hash=$2,redeemed_at=now() WHERE id=$1', [session.id,input.secretHash]);
      await client.query('COMMIT');
      return { version:1,op:'redeem',sessionId:session.id,transferId:transfer.id,purpose:transfer.purpose,expiresAt };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async oneTransfer(client: PoolClient, sessionId: string): Promise<Transfer> {
    const result = await client.query<Transfer>('SELECT * FROM attachment_download_transfers WHERE session_id=$1', [sessionId]);
    if (result.rows.length !== 1) throw new ApiError(401, 'bootstrap_rejected');
    return result.rows[0]!;
  }

  async authorize(input: Extract<DownloadControlRequest, { op: 'authorize' }>): Promise<DownloadAuthorizeReply> {
    const result = await this.pool.query<Session>('SELECT * FROM attachment_download_sessions WHERE id=$1 AND secret_hash=$2', [input.sessionId,input.secretHash]);
    const session = result.rows[0];
    if (!session || !session.redeemed_at || (!session.activated_at && session.ticket_expires_at.getTime() <= Date.now())) throw new ApiError(401, 'download_session_expired');
    const transfers = await this.pool.query<Transfer>('SELECT * FROM attachment_download_transfers WHERE session_id=$1 AND id=$2', [session.id,input.transferId]);
    const transfer = transfers.rows[0];
    if (!transfer) throw new ApiError(404, 'attachment_unavailable');
    const appOrigin = new URL(this.appConfig.publicBaseUrl).origin;
    if ((transfer.purpose === 'preview' && input.requestOrigin !== appOrigin)
      || (input.requestOrigin !== null && input.requestOrigin !== appOrigin)) throw new ApiError(403, 'origin_rejected');
    await this.validateSource(session);
    const attachment = await this.resource(transfer.delivery_id,transfer.attachment_id,session.principal_id,transfer.purpose);
    const sourceExpiry = await this.validateSource(session);
    const sessionExpiresAt = Math.min(session.expires_at.getTime(),sourceExpiry);
    const expiresAt = Math.min(Date.now()+30_000,sessionExpiresAt);
    if (expiresAt <= Date.now()) throw new ApiError(401, 'download_session_expired');
    const current = await this.pool.query('UPDATE attachment_download_sessions SET activated_at=COALESCE(activated_at,now()) WHERE id=$1 AND expires_at>now() RETURNING id',[session.id]);
    if (!current.rowCount) throw new ApiError(401, 'download_session_expired');
    return { version:1,op:'authorize',sessionId:session.id,transferId:transfer.id,purpose:transfer.purpose,
      objectKey:attachment.objectKey,sha256:attachment.sha256,sizeBytes:attachment.sizeBytes,filename:attachment.filename,
      mimeType:attachment.mimeType,expiresAt,sessionExpiresAt };
  }
}
