import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  INGEST_PATH, MAX_INBOUND_BYTES, verifyDeliveryHeaders, verifyDeliveryBody, type VerifiedDelivery,
} from '@dreampost/protocol';
import type { ApiConfig } from './config.js';
import { UUID } from './config.js';
import { FileBlobStore, type RawBlobStore } from './blob-store.js';
import { ingest } from './ingestion.js';
import { ApiError } from './errors.js';

interface MessageRow {
  id: string;
  subject: string;
  from_header: string;
  to_header: string;
  received_at: Date;
  preview: string;
  plain_text: string;
  parse_status: string;
  raw_size: number;
  sha256: string;
}

export function buildApp(config: ApiConfig, pool: Pool, options: { blobs?: RawBlobStore; logger?: boolean } = {}) {
  const blobs = options.blobs ?? new FileBlobStore(config.mailStorePath);
  const app = Fastify({
    bodyLimit: MAX_INBOUND_BYTES,
    logger: options.logger ? { level: 'info', redact: ['req.headers.authorization'] } : false,
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 180_000,
  });
  const verifiedRequests = new WeakMap<FastifyRequest, VerifiedDelivery>();
  app.addContentTypeParser('message/rfc822', { parseAs: 'buffer', bodyLimit: MAX_INBOUND_BYTES }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    const candidate = error as { statusCode?: number; code?: string };
    if (candidate.statusCode === 413) return reply.code(413).send({ error: 'message_too_large' });
    if (candidate.statusCode === 415) return reply.code(415).send({ error: 'unsupported_content_type' });
    if (candidate.statusCode && candidate.statusCode >= 400 && candidate.statusCode < 500) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    // Avoid logging exception messages that might contain MIME, addresses, or credentials.
    request.log.error({ event: 'request_failed', requestId: request.id }, 'Request failed');
    return reply.code(503).send({ error: 'temporarily_unavailable' });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
      return { status: 'ready' };
    } catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.post(INGEST_PATH, {
    onRequest: async (request) => {
      try { verifiedRequests.set(request, await verifyDeliveryHeaders(request.headers, config.ingestKeys)); }
      catch { throw new ApiError(401, 'invalid_delivery_authorization'); }
    },
  }, async (request) => {
    const verified = verifiedRequests.get(request);
    if (!verified) throw new ApiError(401, 'invalid_delivery_authorization');
    if (!Buffer.isBuffer(request.body)) throw new ApiError(415, 'unsupported_content_type');
    try { await verifyDeliveryBody(request.body, verified); }
    catch { throw new ApiError(400, 'delivery_body_mismatch'); }
    return ingest(pool, blobs, verified, request.body);
  });

  void app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const supplied = request.headers.authorization;
      const expected = Buffer.from(`Bearer ${config.devViewToken}`);
      const candidate = Buffer.from(typeof supplied === 'string' ? supplied : '');
      if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) {
        reply.header('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'development_token_required');
      }
    });

    async function authorizeMailbox(id: string): Promise<void> {
      if (!UUID.test(id) || id !== config.devMailboxId) throw new ApiError(404, 'not_found');
      const { rowCount } = await pool.query('SELECT 1 FROM mailboxes WHERE id = $1 AND enabled', [id]);
      if (!rowCount) throw new ApiError(404, 'not_found');
    }

    async function getMessage(mailboxId: string, messageId: string): Promise<MessageRow> {
      await authorizeMailbox(mailboxId);
      if (!UUID.test(messageId)) throw new ApiError(404, 'not_found');
      const { rows } = await pool.query<MessageRow>(
        'SELECT * FROM deliveries WHERE mailbox_id = $1 AND id = $2 AND deleted_at IS NULL', [mailboxId, messageId],
      );
      if (!rows[0]) throw new ApiError(404, 'not_found');
      return rows[0];
    }

    api.get('/mailboxes', async () => {
      const { rows } = await pool.query<{ id: string; address: string; name: string }>(
        'SELECT id, address, name FROM mailboxes WHERE id = $1 AND enabled', [config.devMailboxId],
      );
      return { mailboxes: rows };
    });
    api.get<{ Params: { id: string } }>('/mailboxes/:id/messages', async (request) => {
      await authorizeMailbox(request.params.id);
      const { rows } = await pool.query<MessageRow>(
        `SELECT id, subject, from_header, to_header, received_at, preview, parse_status, raw_size
         FROM deliveries WHERE mailbox_id = $1 AND deleted_at IS NULL
         ORDER BY received_at DESC, id DESC LIMIT 100`, [request.params.id],
      );
      return { messages: rows.map((row) => ({
        id: row.id, subject: row.subject, from: row.from_header, to: row.to_header,
        receivedAt: row.received_at.toISOString(), preview: row.preview, status: row.parse_status, sizeBytes: row.raw_size,
      })) };
    });
    api.get<{ Params: { id: string; messageId: string } }>('/mailboxes/:id/messages/:messageId', async (request) => {
      const row = await getMessage(request.params.id, request.params.messageId);
      return { message: {
        id: row.id, subject: row.subject, from: row.from_header, to: row.to_header,
        receivedAt: row.received_at.toISOString(), text: row.plain_text, status: row.parse_status, sizeBytes: row.raw_size,
      } };
    });
    api.get<{ Params: { id: string; messageId: string } }>('/mailboxes/:id/messages/:messageId/raw', async (request, reply) => {
      const row = await getMessage(request.params.id, request.params.messageId);
      const bytes = await blobs.get(row.sha256);
      reply.header('Content-Disposition', `attachment; filename="${row.id}.eml"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.type('message/rfc822').send(bytes);
    });
  }, { prefix: '/api' });
  return app;
}
