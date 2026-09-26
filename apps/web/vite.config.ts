import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = new URL(process.env.DEV_API_TARGET ?? 'http://127.0.0.1:3001');

if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
  throw new Error('DEV_API_TARGET must be an HTTP or HTTPS URL without credentials.');
}

const proxy = { '/api': { target: target.origin, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
