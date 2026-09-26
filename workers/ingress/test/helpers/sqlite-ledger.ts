import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { D1Ledger } from '../../src/storage.js';

type Value = string | number | null;

export function sqliteLedger() {
  const sql = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  function prepare(query: string, values: Value[] = []) {
    return {
      bind(...parameters: Value[]) { return prepare(query, parameters); },
      async first() { return sql.prepare(query).get(...values) ?? null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; },
      execute() {
        const results = sql.prepare(query).all(...values);
        const changes = Number(sql.prepare('SELECT changes() AS count').get()?.count ?? 0);
        return { results, meta: { changes }, success: true };
      },
    };
  }
  // The SQL is the production adapter's SQL. Only D1's result/session shapes are emulated.
  const shim = {
    prepare,
    withSession() { return shim; },
    async batch(statements: ReturnType<typeof prepare>[]) {
      sql.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  return { ledger: new D1Ledger(shim as unknown as D1Database), sql, close: () => sql.close() };
}
