import { createRequire } from 'node:module';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { previewHeaders, previewParentOrigins, productionHeaderManifest } from './headers.ts';

const require = createRequire(import.meta.url);
const parents = previewParentOrigins(process.env['PREVIEW_PARENT_ORIGINS'] ?? '');
const configBody = JSON.stringify({ parentOrigins: parents });
const headers = previewHeaders(parents);
const previewHost = process.env['PREVIEW_PUBLIC_HOSTNAME'];
const assets: Plugin = {
  name: 'isolated-preview-assets',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'preview-config.json', source: configBody });
    this.emitFile({ type: 'asset', fileName: '_headers', source: productionHeaderManifest(parents) });
  },
  configureServer(server) {
    server.middlewares.use('/preview-config.json', (_request, response) => { response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(configBody); });
  },
  async writeBundle(options) {
    const output = options.dir ?? resolve('dist');
    const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
    for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
      await mkdir(resolve(output, 'pdfjs'), { recursive: true });
      await cp(resolve(pdfjs, name), resolve(output, 'pdfjs', name), { recursive: true });
    }
  },
};

export default defineConfig({
  plugins: [assets],
  server: { host: '127.0.0.1', port: 5175, strictPort: true, allowedHosts: previewHost ? [previewHost] : [], headers },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true, allowedHosts: previewHost ? [previewHost] : [], headers },
  build: { target: 'es2022', sourcemap: false },
});
