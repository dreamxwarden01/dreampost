import { createHash, timingSafeEqual } from 'node:crypto';

export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
export function secretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function readCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  const ambiguous = new Set<string>();
  for (const part of (header ?? '').split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || ambiguous.has(name)) continue;
    if (Object.hasOwn(cookies, name)) {
      delete cookies[name];
      ambiguous.add(name);
      continue;
    }
    cookies[name] = part.slice(equals + 1).trim();
  }
  return cookies;
}
export function serializeCookie(name: string, value: string, secure: boolean, options: { path?: string; maxAge?: number } = {}): string {
  const path = options.path ?? '/';
  if (name.startsWith('__Host-') && (!secure || path !== '/')) throw new Error('Host cookies require Secure and Path=/');
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join('; ');
}
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) return '/';
  return value;
}
