import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = new URL(process.env.DEV_API_TARGET ?? 'http://127.0.0.1:3001');

if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
  throw new Error('DEV_API_TARGET must be an HTTP or HTTPS URL without credentials.');
}

const publicHost = process.env.DEV_PUBLIC_HOSTNAME;
if (publicHost && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(publicHost)) {
  throw new Error('DEV_PUBLIC_HOSTNAME must be one explicit lowercase hostname without scheme or port.');
}
const allowedHosts = publicHost ? [publicHost] : [];

const proxy = Object.fromEntries(['/api', '/auth', '/backchannel', '/.well-known'].map(path => [path, { target: target.origin, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy, allowedHosts },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy, allowedHosts },
});
