import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: {
  issuer: { type: 'string' }, 'client-id': { type: 'string' }, name: { type: 'string' }, 'public-base-url': { type: 'string' },
  domain: { type: 'string' }, 'account-portal': { type: 'string' }, 'allow-insecure-local': { type: 'boolean', default: false },
} });
function origin(value, name) {
  if (!value) throw new Error(`Supply --${name}`);
  const url = new URL(value);
  const local = values['allow-insecure-local'] && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`Invalid --${name} origin`);
  return url.origin;
}
const issuer = origin(values.issuer, 'issuer');
const publicBase = origin(values['public-base-url'], 'public-base-url');
const clientId = values['client-id'];
if (!clientId || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(clientId)) throw new Error('Supply a lowercase --client-id with alphanumeric ends, at most 64 characters, and only letters, digits, hyphens, or underscores');
const clientName = (values.name ?? 'DreamPost').trim();
if (!clientName || clientName.length > 100 || /[\r\n\x00]/.test(clientName)) throw new Error('Supply a valid --name of at most 100 characters');
const publicUrl = new URL(publicBase);
if (publicUrl.protocol !== 'https:' || publicUrl.port) throw new Error('DreamSSO registration requires an HTTPS public origin without a non-default port');
const domain = values.domain?.toLowerCase();
if (!domain || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Supply a valid --domain');
const directory = resolve('.local');
await mkdir(directory, { recursive: true });
const keyFile = resolve(directory, 'sso-client-key.json');
const envFile = resolve(directory, 'sso.env');
const registrationFile = resolve(directory, 'sso-registration.json');
for (const file of [keyFile, envFile, registrationFile, resolve(directory, 'sso-public-jwks.json')]) {
  try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error(`Refusing to replace existing configuration: ${file}`);
}
const privateJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
const publicJwk = { crv: privateJwk.crv, kty: privateJwk.kty, x: privateJwk.x };
const kid = createHash('sha256').update(JSON.stringify(publicJwk)).digest('base64url');
privateJwk.kid = kid; privateJwk.alg = 'EdDSA';
const lines = ['AUTH_MODE=sso', `SSO_ISSUER=${issuer}`, `SSO_CLIENT_ID=${clientId}`, `SSO_CLIENT_NAME=${JSON.stringify(clientName)}`,
  `PUBLIC_BASE_URL=${publicBase}`, `SSO_CLIENT_KEY_FILE=${JSON.stringify(keyFile)}`,
  `MAIL_DEFAULT_DOMAIN=${domain}`, `MAIL_MANAGED_DOMAINS=${domain}`,
  `SSO_ALLOW_INSECURE_LOCAL=${values['allow-insecure-local'] ? 'true' : 'false'}`];
if (values['account-portal']) lines.push(`SSO_ACCOUNT_PORTAL_URL=${origin(values['account-portal'], 'account-portal')}`);
await writeFile(keyFile, JSON.stringify(privateJwk, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(envFile, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(registrationFile, JSON.stringify({ client_id: clientId, name: clientName,
  hostname: publicUrl.hostname, redirect_paths: ['/auth/callback'], events_path: '/backchannel/events',
  jwks_uri: `${publicBase}/.well-known/jwks.json`, jwks: null,
  allowed_scopes: ['openid', 'profile', 'email'], is_first_party: true, entry_policy: 'opt_in' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(resolve(directory, 'sso-public-jwks.json'), JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Created private .local/sso.env and .local/sso-client-key.json. Do not share the private key.');
console.log('Public registration material is in .local/sso-registration.json. No identity-provider registration was performed.');
