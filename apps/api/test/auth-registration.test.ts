import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { OidcClient } from '../src/auth/oidc.js';
import type { AuthConfig } from '../src/auth/types.js';

let privateJwk: JWK;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA', { extractable: true });
  privateJwk = { ...await exportJWK(keys.privateKey), kid: 'registration-test-key' };
});
function client(overrides: Partial<AuthConfig> = {}) {
  return new OidcClient({ issuer: 'https://identity.example.test', clientId: 'dreampost-dev',
    publicBaseUrl: 'https://mail.example.test', clientPrivateJwk: privateJwk, ...overrides });
}

describe('DreamSSO admin registration contract', () => {
  it('exports the exact decomposed create-API schema and only public JWKS fields', () => {
    const rp = client();
    expect(rp.registrationMaterial()).toEqual({ client_id: 'dreampost-dev', name: 'DreamPost',
      hostname: 'mail.example.test', redirect_paths: ['/auth/callback'], events_path: '/backchannel/events',
      jwks_uri: 'https://mail.example.test/.well-known/jwks.json', jwks: null,
      allowed_scopes: ['openid', 'profile', 'email'], is_first_party: true, entry_policy: 'opt_in' });
    expect(rp.publicJwks()).toEqual({ keys: [{ kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x,
      kid: privateJwk.kid, alg: 'EdDSA', use: 'sig' }] });
    expect(JSON.stringify(rp.publicJwks())).not.toContain('"d":');
  });

  it.each(['', 'DreamPost', 'dreampost.dev', '-dreampost', 'dreampost_', 'a'.repeat(65)])('rejects a noncanonical client slug: %s', (clientId) => {
    expect(() => client({ clientId })).toThrow('lowercase slug');
  });

  it('accepts the same one-character and 64-character boundaries as DreamSSO', () => {
    expect(client({ clientId: 'a' }).registrationMaterial().client_id).toBe('a');
    expect(client({ clientId: 'a'.repeat(64) }).registrationMaterial().client_id).toHaveLength(64);
  });

  it('allows explicit loopback HTTP runtime but refuses incompatible registration material', () => {
    const local = client({ publicBaseUrl: 'http://127.0.0.1:3001', allowInsecureLocal: true });
    expect(local.secureCookies).toBe(false);
    expect(() => local.registrationMaterial()).toThrow('HTTPS hostname on port 443');
  });

  it('refuses a nondefault HTTPS port while canonicalizing the default HTTPS port', () => {
    expect(() => client({ publicBaseUrl: 'https://mail.example.test:8443' }).registrationMaterial()).toThrow('HTTPS hostname on port 443');
    const defaultPort = client({ publicBaseUrl: 'https://mail.example.test:443' });
    expect(defaultPort.redirectUri).toBe('https://mail.example.test/auth/callback');
    expect(defaultPort.registrationMaterial().hostname).toBe('mail.example.test');
  });

  it('uses a configured valid display name', () => {
    expect(client({ clientName: 'DreamPost Dev' }).registrationMaterial().name).toBe('DreamPost Dev');
    expect(() => client({ clientName: ' ' })).toThrow('display names');
    expect(() => client({ clientName: 'x'.repeat(101) })).toThrow('display names');
  });
});
