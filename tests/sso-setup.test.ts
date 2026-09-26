import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
const run = promisify(execFile);
const script = resolve('scripts/setup-sso.mjs');
const base = ['--issuer', 'https://identity.example.test', '--client-id', 'dreampost-dev', '--name', 'DreamPost Dev',
  '--public-base-url', 'https://mail.example.test', '--domain', 'example.test'];

describe('SSO deployment setup', () => {
  it('emits the current decomposed registration contract and keeps the private key separate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dreampost-sso-setup-'));
    try {
      await run(process.execPath, [script, ...base], { cwd });
      const directory = join(cwd, '.local');
      const registration = JSON.parse(await readFile(join(directory, 'sso-registration.json'), 'utf8'));
      expect(registration).toEqual({ client_id: 'dreampost-dev', name: 'DreamPost Dev', hostname: 'mail.example.test',
        redirect_paths: ['/auth/callback'], events_path: '/backchannel/events', jwks_uri: 'https://mail.example.test/.well-known/jwks.json',
        jwks: null, allowed_scopes: ['openid', 'profile', 'email'], is_first_party: true, entry_policy: 'opt_in' });
      const privateText = await readFile(join(directory, 'sso-client-key.json'), 'utf8');
      const privateKey = JSON.parse(privateText);
      const publicKeys = JSON.parse(await readFile(join(directory, 'sso-public-jwks.json'), 'utf8'));
      expect(publicKeys.keys[0]).toMatchObject({ kid: privateKey.kid, x: privateKey.x, kty: 'OKP', crv: 'Ed25519' });
      expect(publicKeys.keys[0]).not.toHaveProperty('d');
      expect(JSON.stringify(registration)).not.toContain(privateKey.d);
      expect((await stat(join(directory, 'sso-client-key.json'))).mode & 0o777).toBe(0o600);
      await expect(run(process.execPath, [script, ...base], { cwd })).rejects.toThrow();
      expect(await readFile(join(directory, 'sso-client-key.json'), 'utf8')).toBe(privateText);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it.each(['MixedCase', 'client.with.dots', '-client', 'x'.repeat(65)])('rejects a client ID incompatible with the SSO registry: %s', async clientId => {
    const cwd = await mkdtemp(join(tmpdir(), 'dreampost-invalid-sso-'));
    try {
      const args = [...base]; args[args.indexOf('--client-id') + 1] = clientId;
      await expect(run(process.execPath, [script, ...args], { cwd })).rejects.toThrow();
      await expect(stat(join(cwd, '.local', 'sso-client-key.json'))).rejects.toThrow();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it.each(['http://127.0.0.1:5173', 'https://mail.example.test:8443'])('rejects an origin the hostname-only registry cannot represent: %s', async origin => {
    const cwd = await mkdtemp(join(tmpdir(), 'dreampost-sso-origin-'));
    try {
      const args = [...base]; args[args.indexOf('--public-base-url') + 1] = origin;
      await expect(run(process.execPath, [script, ...args, '--allow-insecure-local'], { cwd })).rejects.toThrow();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
