import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, customFetch, importJWK, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { AuthConfig, AuthOptions } from './types.js';

function baseUrl(value: string, allowLocal: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid SSO URL configuration');
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('SSO URLs require HTTPS except explicit loopback development');
  return value.replace(/\/+$/, '');
}

export class OidcClient {
  readonly issuer: string;
  readonly clientName: string;
  readonly internalBase: string;
  readonly publicBase: string;
  readonly origin: string;
  readonly redirectUri: string;
  readonly secureCookies: boolean;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly key: ReturnType<typeof importJWK>;

  constructor(readonly config: AuthConfig, options: AuthOptions = {}) {
    this.issuer = baseUrl(config.issuer, config.allowInsecureLocal === true);
    this.internalBase = baseUrl(config.internalBaseUrl ?? config.issuer, config.allowInsecureLocal === true);
    const publicUrl = new URL(baseUrl(config.publicBaseUrl, config.allowInsecureLocal === true));
    if (publicUrl.pathname !== '/') throw new Error('The application public base URL must be an origin');
    this.publicBase = publicUrl.origin;
    this.origin = publicUrl.origin;
    if (config.accountPortalUrl) baseUrl(config.accountPortalUrl, config.allowInsecureLocal === true);
    if (typeof config.clientId !== 'string' || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(config.clientId)) {
      throw new Error('SSO client IDs must use 1-64 lowercase slug characters with alphanumeric ends');
    }
    this.clientName = (config.clientName ?? 'DreamPost').trim();
    if (!this.clientName || this.clientName.length > 100) throw new Error('SSO client display names must contain 1-100 characters');
    const jwk = config.clientPrivateJwk;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x || !jwk.kid) throw new Error('The RP requires an Ed25519 private JWK with a key ID');
    this.key = importJWK(jwk, 'EdDSA');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.jwks = createRemoteJWKSet(new URL(`${this.internalBase}/jwks`), {
      [customFetch]: this.fetcher, timeoutDuration: 5000, cacheMaxAge: 300_000, cooldownDuration: 1000,
    });
    this.redirectUri = `${this.publicBase}/auth/callback`;
    this.secureCookies = new URL(this.publicBase).protocol === 'https:';
  }

  publicJwks() {
    const key = this.config.clientPrivateJwk;
    return { keys: [{ kty: key.kty, crv: key.crv, x: key.x, kid: key.kid, alg: 'EdDSA', use: 'sig' }] };
  }

  registrationMaterial() {
    const url = new URL(this.publicBase);
    if (url.protocol !== 'https:' || url.port || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)) {
      throw new Error('DreamSSO registration requires an HTTPS hostname on port 443');
    }
    // DreamSSO's admin API composes full URLs from one hostname and relative paths.
    return { client_id: this.config.clientId, name: this.clientName, hostname: url.hostname,
      redirect_paths: ['/auth/callback'], events_path: '/backchannel/events',
      jwks_uri: `${this.publicBase}/.well-known/jwks.json`, jwks: null,
      allowed_scopes: ['openid', 'profile', 'email'], is_first_party: true, entry_policy: 'opt_in' };
  }

  authorizeUrl(flow: { state: string; nonce: string; challenge: string }): string {
    const url = new URL(`${this.issuer}/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId,
      redirect_uri: this.redirectUri, scope: 'openid profile email', state: flow.state, nonce: flow.nonce,
      code_challenge: flow.challenge, code_challenge_method: 'S256' }).toString();
    return url.href;
  }

  async signClientAssertion(): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg: 'EdDSA', kid: this.config.clientPrivateJwk.kid })
      .setIssuer(this.config.clientId).setSubject(this.config.clientId).setAudience(this.issuer)
      .setIssuedAt(now).setExpirationTime(now + 60).setJti(randomUUID()).sign(await this.key);
  }

  async signEventToken(events: Array<{ id: string; type: string; payload: unknown }>, issuedAt?: number): Promise<string> {
    const clock = Math.floor(this.now() / 1000);
    const now = issuedAt ?? clock;
    if (!Number.isSafeInteger(now) || now < 0 || now > clock) throw new Error('Event publication timestamps must not be in the future');
    return new SignJWT({ events }).setProtectedHeader({ alg: 'EdDSA', kid: this.config.clientPrivateJwk.kid, typ: 'events+jwt' })
      .setIssuer(this.config.clientId).setSubject(this.config.clientId).setAudience(this.issuer)
      .setIssuedAt(now).setExpirationTime(now + 120).setJti(randomUUID()).sign(await this.key);
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await this.fetcher(`${this.internalBase}/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri,
        code_verifier: verifier, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await this.signClientAssertion() }),
    });
    if (!response.ok) throw new Error('SSO token exchange failed');
    const body = await response.json() as { id_token?: unknown };
    if (typeof body.id_token !== 'string' || body.id_token.length > 32_768) throw new Error('SSO did not return an ID token');
    return body.id_token;
  }

  async verify(token: string, typ: 'JWT' | 'events+jwt' | 'verdict+jwt'): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.jwks, {
      algorithms: ['EdDSA'], issuer: this.issuer, audience: this.config.clientId, typ,
      requiredClaims: ['iss', 'aud', 'iat', 'exp'], maxTokenAge: typ === 'JWT' ? '10 minutes' : '5 minutes',
      clockTolerance: 5, currentDate: new Date(this.now()),
    });
    if (payload.azp !== undefined && payload.azp !== this.config.clientId) throw new Error('Unexpected authorized party');
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.clientId) throw new Error('Missing authorized party');
    return payload;
  }

  async publishRoles(payload: unknown, issuedAt: number): Promise<void> {
    const eventToken = await this.signEventToken([{ id: randomUUID(), type: 'roles.sync', payload }], issuedAt);
    const response = await this.fetcher(`${this.internalBase}/backchannel/events`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ event_token: eventToken }),
    });
    if (response.status !== 204) throw new Error('SSO role catalog publication failed');
    await response.body?.cancel();
  }

  async reportActivity(sid: string, lastSeen: number): Promise<'valid' | 'invalid' | 'unknown'> {
    try {
      const response = await this.fetcher(`${this.internalBase}/internal/session-activity`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sid, last_seen: lastSeen,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await this.signClientAssertion() }),
      });
      if (response.status === 204) return 'valid';
      if (response.status !== 410) { await response.body?.cancel(); return 'unknown'; }
      const body = await response.json() as { verdict?: unknown };
      if (typeof body.verdict !== 'string') return 'unknown';
      const verdict = await this.verify(body.verdict, 'verdict+jwt');
      return verdict.status === 'invalid' && verdict.sid === sid ? 'invalid' : 'unknown';
    } catch { return 'unknown'; }
  }

  logoutUrl(idTokenHint: string): string {
    const url = new URL(`${this.issuer}/logout`);
    url.search = new URLSearchParams({ client_id: this.config.clientId, id_token_hint: idTokenHint }).toString();
    return url.href;
  }
}
