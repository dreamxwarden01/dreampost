import { isDownloadId, isDownloadSecret } from '@dreampost/protocol';
import type { Config } from './config.js';
export class HttpError extends Error { constructor(readonly status: number, readonly code: string, readonly clearSession = false) { super(code); } }
export const sessionPrefix = (secure: boolean) => secure ? '__Host-dp-download-' : 'dp-download-';
export const challengePrefix = (secure: boolean) => secure ? '__Host-dp-bootstrap-' : 'dp-bootstrap-';
export function cookies(request: Request, secure: boolean): Map<string, string> {
  const text = request.headers.get('cookie') ?? '';
  if (text.length > 16_384 || new TextEncoder().encode(text).byteLength > 16_384) throw new HttpError(431, 'cookie_header_too_large');
  const prefixes = [sessionPrefix(secure), challengePrefix(secure)];
  const result = new Map<string, string>();
  for (const pair of text.split(';')) {
    const at = pair.indexOf('=');
    const name = (at < 0 ? pair : pair.slice(0, at)).trim();
    // Parent-domain analytics/application cookies may be duplicated or malformed.
    // They do not belong to this service and must not affect its authorization.
    const prefix = prefixes.find(value => name.startsWith(value));
    if (!prefix || !isDownloadId(name.slice(prefix.length))) continue;
    if (result.has(name)) throw new HttpError(400, 'duplicate_cookie');
    // Preserve malformed owned values as invalid. The selected credential must
    // still pass requireSecret; never repair quotes, encodings or missing '='.
    result.set(name, at < 0 ? '' : pair.slice(at + 1).trim());
  }
  return result;
}
export function requireSecret(values: Map<string, string>, name: string): string {
  const value = values.get(name); if (!isDownloadSecret(value)) throw new HttpError(401, 'download_session_required'); return value;
}
export function cookie(name: string, value: string, expiresAt: number, config: Config, now: number): string {
  const remaining = value ? Math.max(1, Math.floor((expiresAt - now) / 1000)) : 0;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${remaining}${config.secure ? '; Secure' : ''}`;
}
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > max) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; } return bytes;
}
export async function jsonBody(request: Request, fields: string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'json_required');
  const declared = request.headers.get('content-length'); if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new HttpError(413, 'body_too_large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBounded(request.body, 4096))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new HttpError(400, 'invalid_request');
  return value as Record<string, unknown>;
}
export function securityHeaders(): Headers {
  return new Headers({ 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-DNS-Prefetch-Control': 'off' });
}
export function cors(headers: Headers, request: Request, config: Config): void {
  headers.set('Vary', 'Origin');
  if (request.headers.get('origin') === config.appOrigin) { headers.set('Access-Control-Allow-Origin', config.appOrigin); headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Disposition, Retry-After, X-DreamPost-Session-Expires-At'); }
}
export function disposition(filename: string): string {
  const clean = new TextDecoder().decode(new TextEncoder().encode(Array.from(filename.replace(/[\x00-\x1f\x7f/\\]/g, '_')).slice(0, 200).join('')));
  const usable = clean && clean !== '.' && clean !== '..' ? clean : 'attachment';
  const ascii = usable.replace(/[^\x20-\x7e]|["%\\]/g, '_');
  const encoded = encodeURIComponent(usable).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export interface ByteRange { offset: number; length: number }
export function parseRange(value: string | null, size: number): ByteRange | undefined {
  if (value === null) return undefined;
  const match = value.length <= 100 ? /^bytes=(\d*)-(\d*)$/.exec(value.trim()) : null;
  if (!match || (!match[1] && !match[2]) || size === 0) throw new HttpError(416, 'range_not_satisfiable');
  const start = match[1] ? Number(match[1]) : undefined, end = match[2] ? Number(match[2]) : undefined;
  if ((start !== undefined && !Number.isSafeInteger(start)) || (end !== undefined && !Number.isSafeInteger(end))) throw new HttpError(416, 'range_not_satisfiable');
  if (start === undefined) { if (!end || end < 1) throw new HttpError(416, 'range_not_satisfiable'); const length = Math.min(end, size); return { offset: size - length, length }; }
  if (start >= size || (end !== undefined && end < start)) throw new HttpError(416, 'range_not_satisfiable');
  return { offset: start, length: Math.min(end ?? size - 1, size - 1) - start + 1 };
}
export function etagMatches(value: string | null, etag: string, weak: boolean): boolean {
  return value !== null && value.split(',').some(part => { const item = part.trim(); return item === '*' || (weak ? item.replace(/^W\//, '') : item) === etag; });
}
