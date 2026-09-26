import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { normalizeRecipientAddress } from '@dreampost/protocol';

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':dreampost:migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (exists.rowCount) continue;
      await client.query(await readFile(fileURLToPath(new URL(name, directory)), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function appendChange(client: PoolClient, mailboxId: string, deliveryId: string, kind: string): Promise<void> {
  const { rows } = await client.query<{ change_sequence: string }>(
    'UPDATE mailboxes SET change_sequence = change_sequence + 1 WHERE id = $1 RETURNING change_sequence',
    [mailboxId],
  );
  if (!rows[0]) throw new Error('mailbox_missing');
  await client.query(
    'INSERT INTO mailbox_changes (mailbox_id, sequence, delivery_id, kind) VALUES ($1, $2, $3, $4)',
    [mailboxId, rows[0].change_sequence, deliveryId, kind],
  );
}

export async function seedMailbox(pool: Pool, mailbox: { id: string; address: string; name: string }): Promise<void> {
  const address = normalizeRecipientAddress(mailbox.address);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO mailboxes (id, address, name) VALUES ($1, $2, $3)',
      [mailbox.id, address, mailbox.name]);
    await client.query('INSERT INTO recipient_routes (address, mailbox_id) VALUES ($1, $2)',
      [address, mailbox.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
