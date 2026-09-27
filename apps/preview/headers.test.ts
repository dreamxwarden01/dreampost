import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { previewHeaders, previewParentOrigins, productionHeaderManifest } from './headers';

const parents = ['https://mail.example.test'];
describe('isolated renderer production policy', () => {
  it('uses an exact ancestor allowlist and forbids JavaScript eval, forms, plugins, and nested frames', () => {
    const headers = previewHeaders(parents), csp = headers['Content-Security-Policy']!;
    expect(csp).toContain("script-src 'self';"); expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval/);
    expect(csp).toContain('frame-ancestors https://mail.example.test');
    for (const directive of ['form-action', 'object-src', 'frame-src', 'base-uri']) expect(csp).toContain(`${directive} 'none'`);
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(previewHeaders([])['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });
  it.each(['https://*.example.test', 'https://mail.example.test/path', 'https://user:password@example.test', 'http://mail.example.test'])('rejects unsafe parent configuration %s', value => {
    expect(() => previewParentOrigins(value)).toThrow();
  });
  it('emits the actual production manifest during a real build', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dreampost-preview-headers-'));
    try {
      const require = createRequire(import.meta.url), vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
      await promisify(execFile)(process.execPath, [vite, 'build', '--outDir', directory, '--emptyOutDir'], {
        cwd: fileURLToPath(new URL('./', import.meta.url)), env: { PATH: process.env['PATH'], PREVIEW_PARENT_ORIGINS: parents.join(','), CI: '1' },
      });
      expect(await readFile(join(directory, '_headers'), 'utf8')).toBe(productionHeaderManifest(parents));
      expect(JSON.parse(await readFile(join(directory, 'preview-config.json'), 'utf8'))).toEqual({ parentOrigins: parents });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
