import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../config.js';
import { AuthService } from '../auth/index.js';
import { AddressService, dispatchOnePolicy } from '../addresses/index.js';
const config = loadConfig();
if (!config.auth || !config.addresses || !config.policySync) throw new Error('SSO, mail domains, and policy gateway configuration are required');
const once = process.argv.includes('--once');
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const auth = new AuthService(pool, config.auth);
const service = new AddressService(pool, config.addresses, (id, client) => auth.resolvePrincipal(id, client));
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  do {
    try {
      const worked = await dispatchOnePolicy(service, { ...config.policySync, allowInsecureLoopback: process.env['ALLOW_INSECURE_LOCAL_GATEWAY'] === 'true' });
      if (!worked && !once) await setTimeout(1000);
    } catch {
      console.error('Recipient policy synchronization failed; inspect operation state.');
      if (once) throw new Error('Policy synchronization failed');
      await setTimeout(1000);
    }
  } while (!stopping && !once);
} finally { await pool.end(); }
