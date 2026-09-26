import pg from 'pg';
import { loadConfig } from '../config.js';
import { AuthService } from '../auth/index.js';
const config = loadConfig();
if (!config.auth) throw new Error('Set AUTH_MODE=sso and configure the SSO connection first');
const action = process.argv[2];
if (!['registration', 'sync'].includes(action ?? '')) throw new Error('Use registration or sync');
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  const auth = new AuthService(pool, config.auth);
  if (action === 'registration') console.log(JSON.stringify(auth.registrationMaterial(), null, 2));
  else { await auth.publishRoleCatalog(); console.log('DreamPost role catalog acknowledged by the configured SSO.'); }
} finally { await pool.end(); }
