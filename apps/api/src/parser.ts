import PostalMime from 'postal-mime';
import type { Pool } from 'pg';
import type { RawBlobStore } from './blob-store.js';
import { appendChange } from './database.js';

interface JobRow { id: string; delivery_id: string; attempts: number; }
interface MessageRow { mailbox_id: string; sha256: string; }

/** Holds one PostgreSQL job lock during parsing; a process crash returns the job to pending. */
export async function runOneParseJob(pool: Pool, blobs: RawBlobStore): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<JobRow>(
      `SELECT id, delivery_id, attempts FROM durable_jobs
       WHERE kind = 'parse' AND status = 'pending' AND available_at <= now()
       ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const job = rows[0];
    if (!job) { await client.query('COMMIT'); return false; }
    const result = await client.query<MessageRow>('SELECT mailbox_id, sha256 FROM deliveries WHERE id = $1', [job.delivery_id]);
    const message = result.rows[0];
    if (!message) throw new Error('delivery_missing');
    let parsed: Awaited<ReturnType<typeof PostalMime.parse>> | undefined;
    let failure: string | undefined;
    try { parsed = await PostalMime.parse(await blobs.get(message.sha256)); }
    catch { failure = 'raw_read_or_parse_failed'; }
    if (failure || !parsed) {
      const exhausted = job.attempts + 1 >= 5;
      await client.query(
        `UPDATE durable_jobs SET attempts = attempts + 1, last_error_code = $2, status = $3,
         available_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [job.id, failure ?? 'parse_failed', exhausted ? 'failed' : 'pending', Math.min(3600, 30 * 2 ** job.attempts)],
      );
      if (exhausted) {
        await appendChange(client, message.mailbox_id, job.delivery_id, 'message.parse_failed');
        await client.query("UPDATE deliveries SET parse_status = 'failed' WHERE id = $1", [job.delivery_id]);
      }
    } else {
      const formatAddress = (address: { name?: string; address?: string }): string =>
        address.name && address.address ? `${address.name} <${address.address}>` : address.address ?? address.name ?? '';
      const clean = (value: string): string => value.replace(/\u0000/g, '\uFFFD');
      const text = clean(parsed.text ?? (parsed.html ? 'This message has no plain-text part. Download the raw message to inspect its HTML content.' : ''));
      await appendChange(client, message.mailbox_id, job.delivery_id, 'message.parsed');
      await client.query(
        `UPDATE deliveries SET parse_status = 'parsed', subject = $2, from_header = $3,
         to_header = $4, plain_text = $5, preview = $6 WHERE id = $1`,
        [job.delivery_id, clean(parsed.subject ?? ''), clean(parsed.from ? formatAddress(parsed.from) : ''),
          clean((parsed.to ?? []).map(formatAddress).join(', ')), text, text.replace(/\s+/g, ' ').trim().slice(0, 200)],
      );
      await client.query(
        "UPDATE durable_jobs SET status = 'done', attempts = attempts + 1, last_error_code = NULL, completed_at = now() WHERE id = $1",
        [job.id],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
