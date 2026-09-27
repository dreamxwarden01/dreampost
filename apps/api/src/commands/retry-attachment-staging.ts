import { parseArgs } from 'node:util';
import pg from 'pg';
import { retryFailedAttachmentStaging } from '../attachments/service.js';

const { values } = parseArgs({ options: {
  'delivery-id': { type: 'string' }, 'manifest-sha256': { type: 'string' },
  'expected-attempts': { type: 'string' }, 'failed-at': { type: 'string' }, operator: { type: 'string' },
} });
if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
for (const name of ['delivery-id', 'manifest-sha256', 'expected-attempts', 'failed-at', 'operator'] as const) {
  if (!values[name]) throw new Error(`--${name} is required`);
}
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 5000 });
try {
  const receipt = await retryFailedAttachmentStaging(pool, { deliveryId: values['delivery-id']!, expectedManifestSha256: values['manifest-sha256']!,
    expectedAttempts: Number(values['expected-attempts']), expectedFailureAt: values['failed-at']!, operatorLabel: values.operator! });
  if (!receipt) { console.error('Attachment staging retry refused: the exact eligible failed state no longer matches.'); process.exitCode = 2; }
  else console.log(JSON.stringify({ action: 'attachment_staging_retry', ...receipt }));
} catch {
  console.error('Attachment staging retry failed. No raw mail or immutable attachment identity was changed.'); process.exitCode = 1;
} finally { await pool.end(); }
