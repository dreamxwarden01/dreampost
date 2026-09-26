import pg from 'pg';
import { migrate } from '../database.js';

if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 5000 });
try { await migrate(pool); console.log('Database migrations completed.'); }
catch { console.error('Database migration failed.'); process.exitCode = 1; }
finally { await pool.end(); }
