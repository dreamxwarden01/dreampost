/** One policy for development, preview, emitted production headers, and browser verification. */
export function previewParentOrigins(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (url.origin !== item || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) throw new Error('PREVIEW_PARENT_ORIGINS must contain exact origins.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('HTTP preview parents must be loopback test origins.');
    return url.origin;
  }))];
}
export function previewHeaders(parents: readonly string[]): Record<string, string> {
  const allowed = previewParentOrigins(parents.join(','));
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src blob: data:; font-src 'self' blob: data:; style-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${allowed.length ? allowed.join(' ') : "'none'"}`,
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-DNS-Prefetch-Control': 'off',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}
export function productionHeaderManifest(parents: readonly string[]): string {
  return `/*\n${Object.entries(previewHeaders(parents)).map(([name, value]) => `  ${name}: ${value}`).join('\n')}\n\n/preview-config.json\n  Cache-Control: no-store\n`;
}
