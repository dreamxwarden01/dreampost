import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError } from '../errors.js';
import { AuthService } from './service.js';
import { type AuthConfig, type AuthOptions } from './types.js';
import { readCookies, serializeCookie } from './cookies.js';

export { AuthService } from './service.js';
export type { Actor } from './service.js';
export type { AuthConfig, AuthOptions } from './types.js';
export { AUTH_PERMISSIONS, SESSION_COOKIE, SECURE_SESSION_COOKIE } from './types.js';

/** Registers local RP endpoints only. It never registers a client or contacts the live SSO at startup. */
export function registerAuthRoutes(app: FastifyInstance, pool: Pool, config: AuthConfig, options: AuthOptions = {}): AuthService {
  const service = new AuthService(pool, config, options);
  void app.register(async (auth) => {
    auth.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    auth.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 65_536 }, (_request, body, done) => {
      const params = new URLSearchParams(body as string);
      const tokens = params.getAll('event_token');
      if (tokens.length !== 1) { done(new ApiError(400, 'invalid_event_request')); return; }
      done(null, { event_token: tokens[0] });
    });
    auth.get('/.well-known/jwks.json', async (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=300');
      return service.oidc.publicJwks();
    });
    auth.get('/auth/session', async (request) => service.sessionInfo(request));
    auth.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (request, reply) => {
      const flow = await service.beginLogin(request.query.returnTo);
      const previous = Object.keys(readCookies(request.headers.cookie)).filter((name) => name.startsWith(service.flowCookiePrefix));
      const cookies = previous.slice(0, Math.max(0, previous.length - 4)).map((name) => serializeCookie(name, '', service.oidc.secureCookies, { path: service.flowCookiePath, maxAge: 0 }));
      cookies.push(serializeCookie(`${service.flowCookiePrefix}${flow.state}`, flow.secret, service.oidc.secureCookies, { path: service.flowCookiePath, maxAge: 600 }));
      reply.header('Set-Cookie', cookies);
      return reply.redirect(flow.url);
    });
    auth.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/auth/callback', async (request, reply) => {
      const { state, code } = request.query;
      const cookies: string[] = [];
      if (typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state)) {
        cookies.push(serializeCookie(`${service.flowCookiePrefix}${state}`, '', service.oidc.secureCookies, { path: service.flowCookiePath, maxAge: 0 }));
      }
      reply.header('Set-Cookie', cookies);
      const login = await service.completeLogin(state, code, readCookies(request.headers.cookie));
      cookies.push(serializeCookie(service.sessionCookieName, login.token, service.oidc.secureCookies,
        login.persistent ? { maxAge: (login.expiresAt - Date.now()) / 1000 } : {}));
      reply.header('Set-Cookie', cookies);
      return reply.redirect(login.returnTo);
    });
    auth.post('/auth/logout', async (request, reply) => {
      const logoutUrl = await service.logout(request);
      reply.header('Set-Cookie', serializeCookie(service.sessionCookieName, '', service.oidc.secureCookies, { maxAge: 0 }));
      return { logoutUrl };
    });
    auth.post<{ Body: { event_token?: unknown } }>('/backchannel/events', { bodyLimit: 65_536 }, async (request, reply) => {
      const token = request.body?.event_token;
      if (typeof token !== 'string' || token.length > 65_536) throw new ApiError(400, 'invalid_event_request');
      await service.acceptEvents(token);
      return reply.code(204).send();
    });
  });
  return service;
}
