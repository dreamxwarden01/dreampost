import { sha256Hex } from '@dreampost/protocol';
import type { Config } from './config.js';
import { HttpError } from './http.js';

/** Coarse pre-authentication protection. This is neither identity nor exact accounting. */
export async function admitRequestStart(request: Request, limiter: RateLimit | undefined, config: Config): Promise<void> {
  if (config.localRateLimitBypass) return;
  if (!limiter || typeof limiter.limit !== 'function') throw new HttpError(503, 'request_limiter_unavailable');
  // Cloudflare sets this on public inbound traffic. Never key pre-auth admission on
  // attacker-selected session IDs, cookie contents, forwarded headers, or paths.
  // Missing/malformed addresses share a bounded bucket rather than bypassing it.
  const supplied = request.headers.get('cf-connecting-ip');
  const client = supplied && /^[0-9a-f:.]{3,64}$/i.test(supplied) ? supplied.toLowerCase() : 'unknown-client';
  const clientHash = await sha256Hex(new TextEncoder().encode(client));
  let outcome: RateLimitOutcome;
  try { outcome = await limiter.limit({ key: `dreampost-download-start-v1:${clientHash}` }); }
  catch { throw new HttpError(503, 'request_limiter_unavailable'); }
  if (outcome?.success === false) throw new HttpError(429, 'request_rate_limited');
  if (outcome?.success !== true) throw new HttpError(503, 'request_limiter_unavailable');
}
