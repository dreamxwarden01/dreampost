import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = wranglerRequire('miniflare');
export const downloadsBundlePath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
/** Build with pnpm --filter @dreampost/downloads dry-run first. All R2 storage is local/ephemeral. */
export async function createDownloadsMiniflare({ bindings, outboundService, requestLimit = 600 }) {
  await access(downloadsBundlePath);
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1) throw new Error('Invalid synthetic request limit');
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'download-test', modules: true, scriptPath: downloadsBundlePath,
    compatibilityDate: '2026-09-27', cf: false, log: new Log(LogLevel.ERROR), bindings, r2Buckets: ['ATTACHMENTS'], r2Persist: false,
    ratelimits: { REQUEST_START_LIMITER: { namespace_id: '10001', simple: { limit: requestLimit, period: 60 } } },
    outboundService: outboundService ?? (() => new Response('Outbound network disabled', { status: 502 })),
  }));
  try { await mf.ready; return mf; } catch (error) { await mf.dispose(); throw error; }
}
