import { Worker } from 'node:worker_threads';
import type { Pool, PoolClient } from 'pg';
import { MAX_INBOUND_BYTES } from '@dreampost/protocol';

export const READER_PARSER_VERSION = 2;
export interface ParsedMailAddress { name: string; address: string }
export interface ReaderHeaders {
  from: string; replyTo: string; to: string; cc: string; subject: string;
  dateHeader: string; sentAt: string | null; messageId: string;
  inReplyTo?: string[]; references?: string[]; attachmentCount?: number;
  addresses?: { from: ParsedMailAddress[]; replyTo: ParsedMailAddress[]; to: ParsedMailAddress[]; cc: ParsedMailAddress[] };
}
/** Untrusted MIME candidates, never a validation result or an attachment download API. */
export interface InlineCandidate { contentId: string; mimeType: string; base64: string; sizeBytes: number }
export interface ReaderData {
  parserVersion: number; headers: ReaderHeaders; htmlSource: string | null;
  inlineCandidates: InlineCandidate[]; warnings: string[];
}
export interface ParsedReaderMessage { subject: string; from: string; to: string; text: string; preview: string; reader: ReaderData }
export class ReaderParseError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ReaderParseError'; }
}

const MAX_ACTIVE = 2;
const MAX_QUEUED = 8;
const MAX_MANAGED_BYTES = 64 * 1024 * 1024;
let active = 0;
let managedBytes = 0;
const waiting: Array<() => void> = [];
export function getReaderParserActivity(): { active: number; queued: number } { return { active, queued: waiting.length }; }

function acquire(bytes: number): Promise<() => void> {
  if (managedBytes + bytes > MAX_MANAGED_BYTES || (active >= MAX_ACTIVE && waiting.length >= MAX_QUEUED)) {
    return Promise.reject(new ReaderParseError('mime_parser_busy'));
  }
  managedBytes += bytes;
  return new Promise((resolve) => {
    const start = () => {
      active++;
      resolve(() => { active--; managedBytes -= bytes; waiting.shift()?.(); });
    };
    if (active < MAX_ACTIVE) start(); else waiting.push(start);
  });
}

export async function parseMimeIsolated(raw: Uint8Array, options: { timeoutMs?: number } = {}): Promise<ParsedReaderMessage> {
  if (raw.byteLength < 1 || raw.byteLength > MAX_INBOUND_BYTES) throw new ReaderParseError('mime_input_size_limit');
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new ReaderParseError('invalid_parser_timeout');
  const release = await acquire(raw.byteLength);
  try {
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    return await new Promise<ParsedReaderMessage>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./reader-mime-worker.mjs', import.meta.url), {
          env: {}, execArgv: [], workerData: { raw: copy.buffer, parserVersion: READER_PARSER_VERSION }, transferList: [copy.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
      } catch { reject(new ReaderParseError('mime_worker_unavailable')); return; }
      let finished = false;
      const finish = (error?: ReaderParseError, value?: ParsedReaderMessage) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Hold the concurrency slot until the actual worker has exited.
        void worker.terminate().then(() => error ? reject(error) : resolve(value!), () => reject(new ReaderParseError('mime_worker_failed')));
      };
      const timer = setTimeout(() => finish(new ReaderParseError('mime_parse_timeout')), timeoutMs);
      worker.once('message', (message: { ok?: boolean; value?: ParsedReaderMessage }) => {
        if (message?.ok === true && message.value?.reader?.parserVersion === READER_PARSER_VERSION) finish(undefined, message.value);
        else finish(new ReaderParseError('mime_parse_failed'));
      });
      worker.once('error', (error: Error & { code?: string }) => finish(new ReaderParseError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'mime_resource_limit' : 'mime_worker_failed')));
      worker.once('exit', () => { if (!finished) finish(new ReaderParseError('mime_worker_exited')); });
    });
  } finally { release(); }
}

export async function storeReaderData(client: PoolClient, deliveryId: string, data: ReaderData): Promise<void> {
  await client.query(`INSERT INTO message_reader_data(delivery_id,parser_version,headers,html_source,inline_candidates,warnings)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(delivery_id) DO UPDATE SET parser_version = EXCLUDED.parser_version,
    parsed_at = now(),headers = EXCLUDED.headers,html_source = EXCLUDED.html_source,
    inline_candidates = EXCLUDED.inline_candidates,warnings = EXCLUDED.warnings`,
  [deliveryId, data.parserVersion, data.headers, data.htmlSource, JSON.stringify(data.inlineCandidates), JSON.stringify(data.warnings)]);
}

/** Internal only: the HTTP detail response must use readerSummary, never spread this raw-HTML-bearing object. */
export async function getReaderData(pool: Pick<Pool, 'query'>, deliveryId: string): Promise<ReaderData | null> {
  const { rows } = await pool.query<{ parser_version: number; headers: ReaderHeaders; html_source: string | null; inline_candidates: InlineCandidate[]; warnings: string[] }>(
    'SELECT parser_version,headers,html_source,inline_candidates,warnings FROM message_reader_data WHERE delivery_id = $1', [deliveryId]);
  const row = rows[0];
  return row ? { parserVersion: row.parser_version, headers: row.headers, htmlSource: row.html_source, inlineCandidates: row.inline_candidates, warnings: row.warnings } : null;
}

export function readerSummary(data: ReaderData | null, metadata: { envelopeFrom?: unknown; envelopeTo?: unknown }) {
  return { hasHtml: !!data?.htmlSource, replyTo: data?.headers.replyTo ?? '', cc: data?.headers.cc ?? '', sentAt: data?.headers.sentAt ?? null,
    envelopeFrom: typeof metadata.envelopeFrom === 'string' ? metadata.envelopeFrom : '', envelopeTo: typeof metadata.envelopeTo === 'string' ? metadata.envelopeTo : '' };
}

/** Requeue obsolete completed/failed jobs only before their first attempt at this parser version. */
export async function scheduleReaderReparse(pool: Pool, options: { limit?: number } = {}): Promise<number> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Reparse limit must be between 1 and 1000.');
  const result = await pool.query(`WITH candidates AS (
      SELECT j.id FROM durable_jobs j JOIN deliveries d ON d.id = j.delivery_id
      LEFT JOIN message_reader_data r ON r.delivery_id = d.id
      WHERE j.kind = 'parse' AND j.status IN ('done','failed') AND d.deleted_at IS NULL
        AND j.parser_version_attempted < $1
        AND (r.delivery_id IS NULL OR r.parser_version < $1)
      ORDER BY d.stored_at,j.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED
    ) UPDATE durable_jobs j SET status = 'pending',attempts = 0,available_at = now(),last_error_code = NULL,completed_at = NULL
      FROM candidates c WHERE j.id = c.id RETURNING j.id`, [READER_PARSER_VERSION, limit]);
  return result.rowCount ?? 0;
}
