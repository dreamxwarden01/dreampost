import { describe, expect, it } from 'vitest';
import { readCookies, serializeCookie } from '../src/auth/cookies.js';
import { SECURE_SESSION_COOKIE } from '../src/auth/types.js';

describe('authentication cookie isolation', () => {
  it('discards every occurrence of an ambiguous cookie name', () => {
    expect(readCookies('session=first; keep=yes; session=second; session=third')).toEqual({ keep: 'yes' });
    expect(readCookies('session=same; session=same')).toEqual({});
  });

  it('requires host-prefixed cookies to use Secure and the root path', () => {
    expect(() => serializeCookie(SECURE_SESSION_COOKIE, 'value', false)).toThrow();
    expect(() => serializeCookie(SECURE_SESSION_COOKIE, 'value', true, { path: '/auth' })).toThrow();
    const value = serializeCookie(SECURE_SESSION_COOKIE, 'value', true);
    expect(value).toBe('__Host-dreampost_session=value; Path=/; HttpOnly; SameSite=Lax; Secure');
    expect(value).not.toContain('Domain=');
  });
});
