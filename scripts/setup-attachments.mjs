import { randomBytes } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { getDomain } = require('tldts');
const { values } = parseArgs({ options: {
  'app-origin': { type: 'string' }, 'download-origin': { type: 'string' }, 'preview-origin': { type: 'string' },
  'staging-path': { type: 'string' },
} });
function origin(name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error(`--${name} must be an exact HTTPS origin`);
  return url;
}
const app = origin('app-origin'), download = origin('download-origin'), preview = origin('preview-origin');
const site = url => getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
if (app.hostname === download.hostname || site(app) !== site(download)) throw new Error('Mail and downloads require distinct same-site HTTPS hostnames');
if ([app.hostname, download.hostname].includes(preview.hostname) || site(preview) === site(app)) throw new Error('Preview requires a separate cookie-free site');
const directory = resolve('.local');
await mkdir(directory, { recursive: true, mode: 0o700 });
const keyId = `downloads-${randomBytes(6).toString('hex')}`;
const secret = randomBytes(32).toString('base64url');
const files = [
  [resolve(directory, 'attachments.env'), [
    `DOWNLOAD_ORIGIN=${download.origin}`,
    `ATTACHMENT_PREVIEW_ORIGIN=${preview.origin}`,
    `DOWNLOAD_KEY_ID=${keyId}`,
    `DOWNLOAD_SECRET=${secret}`,
    `ATTACHMENT_STAGING_PATH=${JSON.stringify(resolve(values['staging-path'] ?? resolve(directory, 'attachments')).replaceAll('\\', '/'))}`,
    'DOWNLOAD_SESSION_TTL_SECONDS=3600', 'DOWNLOAD_MAX_SESSIONS=16', 'DOWNLOAD_MAX_PENDING_SESSIONS=4',
    'ATTACHMENT_MAX_PREVIEW_BYTES=20971520', 'ATTACHMENT_STAGE_MAX_BYTES=268435456', 'ATTACHMENT_STORAGE_MAX_BYTES=5368709120', '',
  ].join('\n')],
  [resolve(directory, 'download-worker.secrets.json'), JSON.stringify({ CONTROL_SECRET: secret }, null, 2) + '\n'],
  [resolve(directory, 'attachment-deployment.json'), JSON.stringify({ appOrigin: app.origin, downloadOrigin: download.origin,
    previewOrigin: preview.origin, controlKeyId: keyId, previewParentOrigins: [app.origin] }, null, 2) + '\n'],
];
const handles = [];
try {
  // Exclusively create all destinations first; never replace a working environment or its signing key.
  for (const [path, content] of files) handles.push({ path, content, file: await open(path, 'wx', 0o600) });
  for (const item of handles) { await item.file.writeFile(item.content); await item.file.sync(); }
} catch (error) {
  for (const item of handles) { await item.file.close().catch(() => {}); await unlink(item.path).catch(() => {}); }
  throw error;
}
for (const item of handles) await item.file.close();
console.log('Created private attachment configuration and a separate Worker secret. No cloud resources or DNS records were changed.');
console.log('Configure the Worker origins, callback URL, private bucket and request-start limiter before enabling this environment.');
