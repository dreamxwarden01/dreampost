import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { FileBlobStore } from '../blob-store.js';
import { FileAttachmentStagingStore } from '../attachments/storage.js';
import { runOneAttachmentExtractionJob, cleanupReadyAttachmentStaging } from '../attachments/service.js';
import { runOneAttachmentUpload } from '../downloads/upload.js';

const config = loadConfig();
if (!config.downloads) throw new Error('Download configuration is required for attachment jobs');
const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 });
const raw = new FileBlobStore(config.mailStorePath);
const staging = new FileAttachmentStagingStore(config.downloads.stagingPath);
const once = process.argv.includes('--once');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
try {
  let iterations = 0;
  while (!stopping) {
    const extracted = await runOneAttachmentExtractionJob(pool, raw, staging, config.downloads);
    const uploaded = await runOneAttachmentUpload(pool, staging, config.downloads);
    const cleaned = await cleanupReadyAttachmentStaging(pool, staging, { limit: 10 });
    iterations++;
    if (once && ((!extracted && !uploaded && !cleaned) || iterations >= 100)) break;
    if (!extracted && !uploaded && !cleaned) await setTimeout(1000);
  }
  console.log('Attachment job runner stopped.');
} catch {
  console.error('Attachment jobs failed. Durable jobs and raw mail remain available.');
  process.exitCode = 1;
} finally { await pool.end(); }
