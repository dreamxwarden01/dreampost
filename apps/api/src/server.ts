import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 });
const app = buildApp(config, pool, { logger: true });
app.addHook('onClose', async () => { await pool.end(); });
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
try { await app.listen({ host: config.host, port: config.port }); }
catch {
  console.error('API startup failed. Check configuration and dependency availability.');
  await close();
  process.exitCode = 1;
}
