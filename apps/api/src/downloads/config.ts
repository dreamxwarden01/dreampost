import { resolve } from 'node:path';
import { getDomain } from 'tldts';
import type { SigningKey } from '@dreampost/protocol';

export interface DownloadConfig {
  origin: string;
  previewOrigin: string;
  key: SigningKey;
  stagingPath: string;
  sessionTtlSeconds: number;
  maxPreviewBytes: number;
  stageMaxBytes: number;
  storageMaxBytes: number;
  maxSessions: number;
  maxPendingSessions: number;
  allowInsecureLocal: boolean;
}

export function loadDownloadConfig(env: NodeJS.ProcessEnv, appBase: string, mailStorePath: string): DownloadConfig | undefined {
  if (!env['DOWNLOAD_ORIGIN']) return undefined;
  const local = env['ALLOW_INSECURE_LOCAL_DOWNLOAD'] === 'true';
  const loopback = (host: string) => ['127.0.0.1', '[::1]', 'localhost'].includes(host) || host.endsWith('.localhost');
  function origin(value: string | undefined, name: string): URL {
    if (!value) throw new Error(`${name} is required`);
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:' && loopback(url.hostname)))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must be an HTTPS origin`);
    return url;
  }
  const app = origin(new URL(appBase).origin, 'PUBLIC_BASE_URL');
  const download = origin(env['DOWNLOAD_ORIGIN'], 'DOWNLOAD_ORIGIN');
  const preview = origin(env['ATTACHMENT_PREVIEW_ORIGIN'], 'ATTACHMENT_PREVIEW_ORIGIN');
  if (download.hostname === app.hostname || preview.hostname === app.hostname || preview.hostname === download.hostname) {
    throw new Error('Mail, download and preview require distinct hostnames, not only different ports');
  }
  const site = (url: URL) => `${url.protocol}//${getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname}`;
  const localPair = local && loopback(app.hostname) && loopback(download.hostname);
  if (!localPair && site(app) !== site(download)) throw new Error('The download origin must be on the same HTTPS site as the mail UI');
  if (!(local && loopback(preview.hostname)) && site(preview) === site(app)) {
    throw new Error('The isolated preview origin must use a different site from mail and downloads');
  }
  function integer(name: string, fallback: number, min: number, max: number): number {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  const id = env['DOWNLOAD_KEY_ID'] ?? '';
  const secret = env['DOWNLOAD_SECRET'] ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || Buffer.byteLength(secret) < 32) throw new Error('A separate download key ID and secret are required');
  const maxSessions = integer('DOWNLOAD_MAX_SESSIONS', 16, 1, 32);
  return {
    origin: download.origin, previewOrigin: preview.origin, key: { id, secret },
    stagingPath: resolve(env['ATTACHMENT_STAGING_PATH'] ?? resolve(mailStorePath, '../attachments')),
    sessionTtlSeconds: integer('DOWNLOAD_SESSION_TTL_SECONDS', 3600, 60, 86400),
    maxPreviewBytes: integer('ATTACHMENT_MAX_PREVIEW_BYTES', 20 * 1024 * 1024, 1024, 25 * 1024 * 1024),
    stageMaxBytes: integer('ATTACHMENT_STAGE_MAX_BYTES', 256 * 1024 * 1024, 25 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
    storageMaxBytes: integer('ATTACHMENT_STORAGE_MAX_BYTES', 5 * 1024 * 1024 * 1024, 25 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
    maxSessions, maxPendingSessions: integer('DOWNLOAD_MAX_PENDING_SESSIONS', 4, 1, maxSessions),
    allowInsecureLocal: local,
  };
}
