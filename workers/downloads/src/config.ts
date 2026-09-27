import { getDomain } from 'tldts';
import { DOWNLOAD_CONTROL_PATH, type SigningKey } from '@dreampost/protocol';
export interface Variables {
  APP_ORIGIN: string; DOWNLOAD_ORIGIN: string; BACKEND_CONTROL_URL: string; CONTROL_KEY_ID: string; CONTROL_SECRET: string;
  ALLOW_INSECURE_LOCAL?: string; ALLOW_LOCAL_RATE_LIMIT_BYPASS?: string; MAX_DOWNLOAD_SESSIONS?: string; MAX_BOOTSTRAP_CHALLENGES?: string;
}
export interface Config { appOrigin: string; downloadOrigin: string; backendUrl: string; key: SigningKey; keys: Record<string, string>; secure: boolean; localRateLimitBypass: boolean; maxSessions: number; maxChallenges: number }
function count(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Invalid cookie count limit');
  const n = Number(value); if (!Number.isSafeInteger(n) || n > max) throw new Error('Invalid cookie count limit'); return n;
}
export function readConfig(env: Variables): Config {
  const local = env.ALLOW_INSECURE_LOCAL === 'true';
  function url(value: string) {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:'
      && !(local && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)))) throw new Error('Invalid download URL');
    return parsed;
  }
  const app = url(env.APP_ORIGIN), download = url(env.DOWNLOAD_ORIGIN), backend = url(env.BACKEND_CONTROL_URL);
  const site = (value: URL) => `${value.protocol}//${getDomain(value.hostname, { allowPrivateDomains: true }) ?? value.hostname}`;
  if (app.pathname !== '/' || download.pathname !== '/' || app.origin === download.origin || site(app) !== site(download)
    || backend.pathname !== DOWNLOAD_CONTROL_PATH) throw new Error('Download and application origins must be distinct and same-site');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.CONTROL_KEY_ID) || typeof env.CONTROL_SECRET !== 'string' || new TextEncoder().encode(env.CONTROL_SECRET).length < 32) throw new Error('Invalid download machine key');
  const localRateLimitBypass = env.ALLOW_LOCAL_RATE_LIMIT_BYPASS === 'true';
  if (localRateLimitBypass && (!local || [app, download, backend].some(value => !['127.0.0.1', 'localhost'].includes(value.hostname)))) throw new Error('Rate-limit bypass is only allowed for explicit loopback tests');
  const key = { id: env.CONTROL_KEY_ID, secret: env.CONTROL_SECRET };
  return { appOrigin: app.origin, downloadOrigin: download.origin, backendUrl: backend.href, key, keys: { [key.id]: key.secret },
    secure: download.protocol === 'https:', localRateLimitBypass, maxSessions: count(env.MAX_DOWNLOAD_SESSIONS, 16, 32), maxChallenges: count(env.MAX_BOOTSTRAP_CHALLENGES, 4, 8) };
}
