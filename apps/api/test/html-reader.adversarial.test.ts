import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Parser } from 'htmlparser2';
import * as cssTree from 'css-tree';
import { renderMailHtml } from '../src/html-render-core.mjs';

type Element = { tag: string; attributes: Record<string, string> };
type Inspection = { elements: Element[]; stylesheets: string[]; declarations: string[]; text: string };

// These assertions inspect the serialized result. Real-browser reparse and network
// interception tests remain necessary; htmlparser2 alone cannot prove mXSS safety.
function inspect(html: string): Inspection {
  const result: Inspection = { elements: [], stylesheets: [], declarations: [], text: '' };
  const stack: string[] = [];
  const parser = new Parser({
    onopentag(tag, attributes) {
      result.elements.push({ tag, attributes });
      if (attributes.style) result.declarations.push(attributes.style);
      stack.push(tag);
    },
    ontext(value) {
      if (stack.at(-1) === 'style') result.stylesheets.push(value);
      else result.text += value;
    },
    onclosetag() { stack.pop(); },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return result;
}

function cssNodes(view: Inspection): Array<{ type: string; name?: string; value?: unknown; property?: string }> {
  const result: Array<{ type: string; name?: string; value?: unknown; property?: string }> = [];
  for (const [source, context] of [
    ...view.stylesheets.map((s) => [s, 'stylesheet'] as const),
    ...view.declarations.map((s) => [s, 'declarationList'] as const),
  ]) {
    const ast = cssTree.parse(source, { context });
    cssTree.walk(ast, (node) => { result.push(node); });
  }
  return result;
}

const activeTags = new Set([
  'script', 'form', 'input', 'button', 'select', 'option', 'textarea',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
  'noscript', 'xmp', 'noembed', 'noframes', 'plaintext', 'template',
  'base', 'meta', 'link', 'audio', 'video', 'source', 'track',
]);
const automaticAttributes = new Set([
  'srcset', 'imagesrcset', 'poster', 'ping', 'srcdoc', 'xlink:href',
  'action', 'formaction', 'manifest', 'data', 'codebase', 'archive',
  'lowsrc', 'dynsrc', 'profile', 'usemap',
]);

function expectInert(view: Inspection) {
  for (const element of view.elements) {
    if (element.tag === 'meta') {
      // The renderer can emit its own document policy; sender refresh/resource
      // metadata may never survive. Check the shape instead of ignoring all meta.
      const a = element.attributes;
      if (a.charset) {
        expect(a).toEqual({ charset: 'utf-8' });
      } else if (a['http-equiv']?.toLowerCase() === 'content-security-policy') {
        expect(Object.keys(a).sort()).toEqual(['content', 'http-equiv']);
        expect(a.content).toContain("default-src 'none'");
        expect(a.content).toContain("script-src 'none'");
        expect(a.content).toContain("base-uri 'none'");
        expect(a.content).toContain("form-action 'none'");
      } else if (a['http-equiv']?.toLowerCase() === 'x-dns-prefetch-control') {
        expect(a).toEqual({ 'http-equiv': 'x-dns-prefetch-control', content: 'off' });
      } else if (a.name === 'referrer') {
        expect(a).toEqual({ name: 'referrer', content: 'no-referrer' });
      } else {
        expect(a.name).toBe('viewport');
        expect(Object.keys(a).sort()).toEqual(['content', 'name']);
        expect(a.content).toMatch(/^width=device-width,\s*initial-scale=1$/);
      }
      continue;
    }
    expect(activeTags.has(element.tag), `Unexpected active element: ${element.tag}`).toBe(false);
    for (const name of Object.keys(element.attributes)) {
      expect(name, `${element.tag} retained an event attribute`).not.toMatch(/^on/i);
      expect(automaticAttributes.has(name), `${element.tag} retained ${name}`).toBe(false);
    }
  }
}

function expectNoExternalResources(view: Inspection) {
  expectInert(view);
  for (const { tag, attributes } of view.elements) {
    if (attributes.src) expect(attributes.src, `${tag} source`).toMatch(/^data:image\/(png|jpeg|gif|webp);base64,/);
    expect(attributes.background).toBeUndefined();
  }
  for (const node of cssNodes(view)) {
    if (node.type === 'Url') expect(node.value, 'Blocked view retained an external CSS resource').toMatch(/^data:image\/(png|jpeg|gif|webp);base64,/);
    if (node.type === 'Function') expect(node.name?.toLowerCase()).not.toMatch(/^(url|var|env|attr|image|image-set|-webkit-image-set)$/);
    if (node.type === 'Atrule') expect(node.name?.toLowerCase()).not.toMatch(/^(import|font-face|namespace)$/);
    if (node.type === 'Declaration') expect(node.property).not.toMatch(/^--/);
  }
}

function renderBlocked(html: string, extra: Record<string, unknown> = {}) {
  return renderMailHtml({ html, remoteImages: 'blocked', ...extra });
}

const pixelBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=';
function pixelCandidate(extra: Record<string, unknown> = {}) {
  return {
    contentId: 'pixel@example.test', mimeType: 'image/png', base64: pixelBase64,
    sizeBytes: Buffer.from(pixelBase64, 'base64').byteLength, ...extra,
  };
}

describe('mail reader adversarial serialization', () => {
  it('keeps a remote image inert while retaining readable content and a resource count', () => {
    const result = renderBlocked('<p>Readable message</p><img src="https://images.example.com/pixel.png" alt="Logo" width="40" height="20">');
    expect(result.remoteImageCount).toBe(1);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(inspect(result.html).text).toContain('Readable message');
    expectNoExternalResources(inspect(result.html));
  });

  it.each([
    ['scripts and handlers', '<p onclick="alert(1)">keep</p><script>alert(1)</script><img src=x onerror="alert(1)">'],
    ['forms and image inputs', '<form action="https://sink.example.com/"><input type="image" src="https://sink.example.com/i"><button formaction="https://sink.example.com/">Send</button></form>'],
    ['document metadata and hints', '<base href="https://sink.example.com/"><meta http-equiv="refresh" content="0;url=https://sink.example.com/"><link rel="dns-prefetch" href="//sink.example.com"><link rel="preload" as="image" href="https://sink.example.com/i">'],
    ['frames and objects', '<iframe srcdoc="<script>alert(1)</script>" src="https://sink.example.com/"></iframe><object data="https://sink.example.com/"></object><embed src="https://sink.example.com/">'],
    ['SVG animation', '<svg><a><animate attributeName="href" values="#safe;javascript:alert(1)"></animate><text>link</text></a><image href="https://sink.example.com/i"/></svg>'],
    ['SVG raw-text namespace switch', '<svg><textarea><img src="https://sink.example.com/i" onerror="alert(1)"></textarea></svg>'],
    ['MathML namespace switch', '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">'],
    ['noscript reparsing', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">unsafe</p></noscript>'],
    ['literal raw-text closing tags', '<textarea>hello</textarea/><img src=x onerror="alert(1)"><xmp>text</xmp/><script>alert(1)</script>'],
    ['templates and custom elements', '<template><img src=x onerror="alert(1)"></template><evil-widget onclick="alert(1)" src="https://sink.example.com/"></evil-widget>'],
    ['media resources', '<video poster="https://sink.example.com/p"><source src="https://sink.example.com/v"><track src="https://sink.example.com/t"></video><audio src="https://sink.example.com/a"></audio>'],
  ])('removes active capabilities from %s', (_name, html) => {
    const result = renderBlocked(`${html}<p>tail-marker</p>`);
    expectNoExternalResources(inspect(result.html));
    expect(inspect(result.html).elements.some(({ tag }) => tag.includes('-'))).toBe(false);
  });

  it.each([
    ['ordinary URL', 'background-image:url(https://images.example.com/p.png)'],
    ['escaped function', String.raw`background-image:u\72l(https://images.example.com/p.png)`],
    ['custom property indirection', '--track:url(https://images.example.com/p.png);background:var(--track)'],
    ['image-set', 'background-image:image-set("https://images.example.com/p.png" 1x)'],
    ['cursor and generated content', 'cursor:url(https://images.example.com/c.cur),auto;content:url(https://images.example.com/p.png)'],
    ['SVG URL function', 'filter:url(https://images.example.com/filter.svg#x);clip-path:url(https://images.example.com/c.svg#x)'],
  ])('blocks CSS resource access in attributes and stylesheets: %s', (_name, declaration) => {
    const result = renderBlocked(`<style>.mail-css { ${declaration}; color:#123456 }</style><p class="mail-css" style="${declaration};color:#123456">CSS marker</p>`);
    const view = inspect(result.html);
    expectNoExternalResources(view);
    expect(view.text).toContain('CSS marker');
  });

  it('does not turn a retained CSS string into active HTML during serialization', () => {
    const result = renderBlocked(String.raw`<style>.x {font-family:"\3c /style\3e \3c img src=x onerror=alert(1)\3e "}</style><p class="x">safe marker</p>`);
    const view = inspect(result.html);
    expectNoExternalResources(view);
    expect(view.elements.some(({ tag }) => tag === 'img')).toBe(false);
    expect(view.text).toContain('safe marker');
  });

  it('drops imports, fonts, nested resource rules, and CSS raw-text breakout markup', () => {
    const result = renderBlocked(String.raw`<style>
      @import "https://images.example.com/theme.css";
      @font-face {font-family:track;src:url(https://images.example.com/font.woff2)}
      @media (max-width:600px) {.x {background:url(https://images.example.com/bg.png)}}
      .x::before {content:"\3c /style\3e \3c img src=x onerror=alert(1)\3e "}
    </style><p class="x">style marker</p>`);
    expectNoExternalResources(inspect(result.html));
    expect(inspect(result.html).text).toContain('style marker');
  });
});

describe('mail reader URL boundaries', () => {
  it('permits an HTTPS image only in the allowed variant', () => {
    const html = '<img src="https://images.example.com:443/logo.png?item=1&amp;item=2" alt="Logo">';
    expectNoExternalResources(inspect(renderBlocked(html).html));
    const view = inspect(renderMailHtml({ html, remoteImages: 'allowed' }).html);
    const sources = view.elements.map(({ attributes }) => attributes.src).filter(Boolean);
    expect(sources).toHaveLength(1);
    const url = new URL(sources[0]!);
    expect(url.origin).toBe('https://images.example.com');
    expect(url.searchParams.getAll('item')).toEqual(['1', '2']);
  });

  it.each([
    'http://images.example.com/p.png', '//images.example.com/p.png', '/api/messages',
    'javascript:alert(1)', 'java&#x0a;script:alert(1)', 'file:///etc/passwd',
    'ftp://images.example.com/p.png', 'https://user:password@images.example.com/p.png',
    'https://images.example.com:8443/p.png', 'https://localhost/p.png',
    'https://localhost./p.png', 'https://127.0.0.1/p.png', 'https://2130706433/p.png',
    'https://10.0.0.1/p.png', 'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/p.png', 'https://[::ffff:127.0.0.1]/p.png',
    'data:image/svg+xml,%3Csvg%20onload=alert(1)%3E', `data:image/png;base64,${pixelBase64}`,
  ])('does not activate an unsafe image source even when images are permitted: %s', (src) => {
    const result = renderMailHtml({ html: `<img src="${src}"><p>kept</p>`, remoteImages: 'allowed' });
    const view = inspect(result.html);
    expect(view.elements.some(({ attributes }) => Boolean(attributes.src))).toBe(false);
    expect(view.text).toContain('kept');
  });

  it('permits only the selected HTTPS background resource after image approval', () => {
    const result = renderMailHtml({
      html: '<style>.x{background-image:url(https://images.example.com/bg.png)}</style><p class="x">background</p>',
      remoteImages: 'allowed',
    });
    const urls = cssNodes(inspect(result.html)).filter((node) => node.type === 'Url').map((node) => node.value);
    expect(urls).toEqual(['https://images.example.com/bg.png']);
    expect(result.remoteImageCount).toBe(1);
  });

  it.each([
    String.raw`background-image:u\72l(https://127.0.0.1/p.png)`,
    'background:url(https://mail.example.com/api/private)',
    '--image:url(https://images.example.com/p.png);background:var(--image)',
    'background-image:image-set("https://images.example.com/p.png" 1x)',
    'background-image:url(javascript:alert(1))',
  ])('keeps rejected CSS capabilities disabled after image approval: %s', (declaration) => {
    const result = renderMailHtml({
      html: `<style>.x{${declaration}}</style><p class="x" style="${declaration.replaceAll('"', '&quot;')}">body</p>`,
      remoteImages: 'allowed', blockedOrigins: ['https://mail.example.com'],
    });
    expectNoExternalResources(inspect(result.html));
  });

  it('blocks the entire application origin for image, background, and navigation URLs', () => {
    const result = renderMailHtml({
      html: '<a href="https://MAIL.example.com:443/api/danger">account</a><img src="https://mail.example.com/api/private"><table background="https://mail.example.com/a"><tr><td style="background-image:url(https://mail.example.com/b)">message</td></tr></table>',
      remoteImages: 'allowed', blockedOrigins: ['https://mail.example.com'],
    });
    const view = inspect(result.html);
    expectNoExternalResources(view);
    expect(view.elements.some(({ attributes }) => Boolean(attributes.href))).toBe(false);
  });

  it('does not confuse an unrelated hostname with the application origin', () => {
    const result = renderMailHtml({
      html: '<img src="https://mail.example.com.attacker.example.net/logo.png">',
      remoteImages: 'allowed', blockedOrigins: ['https://mail.example.com'],
    });
    expect(inspect(result.html).elements.find(({ tag }) => tag === 'img')?.attributes.src)
      .toBe('https://mail.example.com.attacker.example.net/logo.png');
  });

  it('rewrites HTTP(S) links to isolated new tabs without beacons or downloads', () => {
    const html = '<a href="https://links.example.com/one" target="_self" rel="opener" ping="https://sink.example.com/ping" download>one</a><a href="http://links.example.com/two" target="_top">two</a>';
    const view = inspect(renderBlocked(html).html);
    expectInert(view);
    const links = view.elements.filter(({ tag, attributes }) => tag === 'a' && attributes.href);
    expect(links).toHaveLength(2);
    for (const { attributes } of links) {
      expect(attributes.target).toBe('_blank');
      expect(attributes.rel?.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
      expect(attributes.rel?.split(/\s+/)).not.toContain('opener');
      expect(attributes.download).toBeUndefined();
    }
  });

  it.each([
    'javascript:alert(1)', 'java&#x09;script:alert(1)', 'data:text/html,test',
    'mailto:person@example.test', 'file:///tmp/mail', '//links.example.com/',
    '/api/private', '#section', 'https://user:secret@links.example.com/',
  ])('removes non-HTTP(S) or ambiguous navigation: %s', (href) => {
    const view = inspect(renderBlocked(`<a href="${href}">readable link</a>`).html);
    expect(view.elements.some(({ attributes }) => Boolean(attributes.href))).toBe(false);
    expect(view.text).toContain('readable link');
  });
});

describe('mail reader inline assets and useful layout', () => {
  it('renders a matching bounded CID PNG without enabling external images', () => {
    const result = renderBlocked('<p>inline</p><img src="cid:pixel@example.test">', { inlineCandidates: [pixelCandidate()] });
    const view = inspect(result.html);
    expectNoExternalResources(view);
    expect(view.elements.find(({ tag }) => tag === 'img')?.attributes.src).toBe(`data:image/png;base64,${pixelBase64}`);
    expect(result.remoteImageCount).toBe(0);
  });

  it.each([
    ['claimed SVG', { mimeType: 'image/svg+xml' }],
    ['MIME mismatch', { mimeType: 'image/jpeg' }],
    ['invalid base64', { base64: 'not-base64!!!', sizeBytes: 9 }],
    ['wrong declared size', { sizeBytes: 1 }],
    ['truncated PNG', { base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), sizeBytes: 8 }],
    ['HTML bytes', { base64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'), sizeBytes: 27 }],
  ])('does not render an invalid inline candidate: %s', (_name, extra) => {
    const view = inspect(renderBlocked('<img src="cid:pixel@example.test"><p>body remains</p>', { inlineCandidates: [pixelCandidate(extra)] }).html);
    expect(view.elements.some(({ attributes }) => Boolean(attributes.src))).toBe(false);
    expect(view.text).toContain('body remains');
  });

  it('rejects ambiguous duplicate CID candidates rather than selecting one silently', () => {
    const result = renderBlocked('<img src="cid:pixel@example.test">', {
      inlineCandidates: [pixelCandidate(), pixelCandidate()],
    });
    expect(inspect(result.html).elements.some(({ attributes }) => Boolean(attributes.src))).toBe(false);
  });

  it('matches bracketed Content-ID metadata and percent-encoded CID references', () => {
    const result = renderBlocked('<img src="cid:pixel%40example.test">', {
      inlineCandidates: [pixelCandidate({ contentId: '<pixel@example.test>' })],
    });
    expect(inspect(result.html).elements.find(({ tag }) => tag === 'img')?.attributes.src)
      .toBe(`data:image/png;base64,${pixelBase64}`);
  });

  it('does not resolve an unknown CID against a URL or an unrelated inline part', () => {
    const result = renderBlocked('<img src="cid:missing@example.test"><p>body</p>', { inlineCandidates: [pixelCandidate()] });
    expect(inspect(result.html).elements.some(({ attributes }) => Boolean(attributes.src))).toBe(false);
    expect(result.remoteImageCount).toBe(0);
  });

  it('rejects excessive PNG dimensions before emitting an image data URL', () => {
    const bytes = Buffer.from(pixelBase64, 'base64');
    bytes.writeUInt32BE(1_000_000, 16);
    const candidate = pixelCandidate({ base64: bytes.toString('base64'), sizeBytes: bytes.byteLength });
    const result = renderBlocked('<img src="cid:pixel@example.test">', { inlineCandidates: [candidate] });
    expect(inspect(result.html).elements.some(({ attributes }) => Boolean(attributes.src))).toBe(false);
  });

  it('preserves table structure, class styling, text color, and a mobile width rule', () => {
    const html = '<style>.newsletter {color:#123456;border-collapse:collapse} @media (max-width:600px) {.newsletter {width:100%}}</style><table class="newsletter" cellpadding="8"><tbody><tr><th colspan="2">Receipt</th></tr><tr><td style="color:#123456">Item</td><td>10.00</td></tr></tbody></table>';
    const view = inspect(renderBlocked(html).html);
    expectNoExternalResources(view);
    for (const name of ['table', 'tbody', 'tr', 'th', 'td']) expect(view.elements.some(({ tag }) => tag === name)).toBe(true);
    expect(view.elements.find(({ tag }) => tag === 'th')?.attributes.colspan).toBe('2');
    expect(view.elements.find(({ tag }) => tag === 'table')?.attributes.class).toContain('newsletter');
    expect([...view.stylesheets, ...view.declarations].join('\n')).toContain('#123456');
    expect(view.stylesheets.join('\n')).toMatch(/@media\s*\([^)]*max-width\s*:\s*600px\)/);
    expect(view.text).toContain('Receipt');
    expect(view.text).toContain('10.00');
  });

  it('preserves Unicode, harmless literal markup, and preformatted text', () => {
    const view = inspect(renderBlocked('<p>\u4e2d\u6587 \u0645\u0631\u062d\u0628\u0627 &lt;script&gt; is text</p><pre>line 1\n  line 2</pre>').html);
    expectNoExternalResources(view);
    expect(view.text).toContain('\u4e2d\u6587 \u0645\u0631\u062d\u0628\u0627 <script> is text');
    expect(view.text).toContain('line 1\n  line 2');
  });

  it('fails explicitly on oversized source rather than returning unsanitized HTML', () => {
    expect(() => renderBlocked('x'.repeat(32 * 1024 * 1024))).toThrow('html_source_too_large');
  });
});


// Produce a valid one-pixel PNG with a harmless ancillary text chunk so that
// expanded CID data exceeds a single source-style budget without a large bitmap.
function paddedPng(byteLength = 20 * 1024): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const payload = Buffer.concat([Buffer.from(name, 'ascii'), data]);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 2;
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', deflateSync(Buffer.from([0, 20, 40, 60])));
  const end = chunk('IEND', Buffer.alloc(0));
  const text = Buffer.alloc(byteLength - signature.length - ihdr.length - idat.length - end.length - 12, 120);
  text.write('Comment\0', 0, 'ascii');
  return Buffer.concat([signature, ihdr, idat, chunk('tEXt', text), end]);
}

function paddedCss(source: string, size: number) {
  return source + '/*' + 'x'.repeat(size - source.length - 4) + '*/';
}
function sourceImageCandidate(contentId: string, bytes: Buffer) {
  return { contentId, mimeType: 'image/png', base64: bytes.toString('base64'), sizeBytes: bytes.length };
}

describe('review regressions: interaction, budgets, and useful content', () => {
  it.each(['hover', 'focus', 'active', String.raw`h\6f ver`])('never enables an external background in the %s interaction state', (pseudo) => {
    const result = renderMailHtml({
      html: `<style>.tile:${pseudo}{background-image:url(https://images.example.com/interaction.png);color:#123456}</style><p class="tile">state text</p>`,
      remoteImages: 'allowed',
    });
    expectNoExternalResources(inspect(result.html));
    expect(result.remoteImageCount).toBe(0);
    expect(inspect(result.html).text).toContain('state text');
  });

  it.each(['(min-height:1px)', '(orientation:landscape)', '(prefers-color-scheme:dark)', '(hover:hover)', '(min-resolution:2dppx)'])('drops resource-bearing media rules outside the width policy: %s', (condition) => {
    const result = renderMailHtml({
      html: `<style>@media ${condition}{.tile{background-image:url(https://images.example.com/probe.png)}}</style><p class="tile">media text</p>`,
      remoteImages: 'allowed',
    });
    expectNoExternalResources(inspect(result.html));
    expect(result.remoteImageCount).toBe(0);
  });

  it('retains normal backgrounds and screen/print width styling', () => {
    const result = renderMailHtml({
      html: '<style>.tile{background-image:url(https://images.example.com/normal.png)}@media screen and (max-width:600px){.tile{padding:9px}}@media print{.tile{color:#123456}}</style><p class="tile">normal text</p>',
      remoteImages: 'allowed',
    });
    const view = inspect(result.html);
    expect(cssNodes(view).filter((node) => node.type === 'Url').map((node) => node.value))
      .toEqual(['https://images.example.com/normal.png']);
    expect(view.stylesheets.join('')).toContain('@media screen and (max-width:600px)');
    expect(view.stylesheets.join('')).toContain('@media print');
    expect(view.stylesheets.join('')).toContain('padding:9px');
    expect(view.stylesheets.join('')).toContain('color:#123456');
    expect(result.remoteImageCount).toBe(1);
  });

  it('maintains independent 128KiB stylesheet and 512KiB inline source budgets', () => {
    const stylesheet = paddedCss('.budget{color:#123456}', 128 * 1024);
    const inline = paddedCss('padding:9px;', 16 * 1024);
    const html = `<style>${stylesheet}</style>` + Array.from({ length: 32 }, (_, i) => `<p class="budget" style="${inline}">row ${i}</p>`).join('');
    const result = renderBlocked(html);
    const view = inspect(result.html);
    expect(view.stylesheets.join('')).toContain('.budget{color:#123456}');
    expect(view.elements.filter(({ tag, attributes }) => tag === 'p' && attributes.style === 'padding:9px')).toHaveLength(32);
    expect(result.warnings).toEqual([]);
  });

  it('warns on stylesheet source overflow while preserving independent inline formatting', () => {
    const result = renderBlocked(`<style>${paddedCss('.over{color:#123456}', 128 * 1024 + 1)}</style><p class="over" style="padding:9px">readable</p>`);
    const view = inspect(result.html);
    expect(view.stylesheets.join('')).not.toContain('.over{');
    expect(view.elements.find(({ tag }) => tag === 'p')?.attributes.style).toBe('padding:9px');
    expect(result.warnings.some((warning: string) => /formatting/i.test(warning))).toBe(true);
  });

  it('warns on aggregate inline source overflow rather than silently losing late styles', () => {
    const full = paddedCss('padding:9px;', 16 * 1024);
    const html = Array.from({ length: 32 }, () => `<p style="${full}">early</p>`).join('') + '<p id="late" style="color:#123456">late text</p>';
    const result = renderBlocked(html);
    const view = inspect(result.html);
    expect(view.elements.filter(({ tag, attributes }) => tag === 'p' && attributes.style === 'padding:9px')).toHaveLength(32);
    expect(view.elements.find(({ attributes }) => attributes.id === 'late')?.attributes.style).toBeUndefined();
    expect(view.text).toContain('late text');
    expect(result.warnings.some((warning: string) => /formatting/i.test(warning))).toBe(true);
  });

  it('allows 12,000 declarations and reports the next declaration as a formatting limit', () => {
    const source = `<style>.many{${'color:red;'.repeat(12_000)}}</style><p class="many">many declarations</p>`;
    const within = renderBlocked(source);
    expect(cssNodes(inspect(within.html)).filter((node) => node.type === 'Declaration' && node.property === 'color'
      && cssTree.generate(node.value as cssTree.CssNode) === 'red')).toHaveLength(12_000);
    expect(within.warnings).toEqual([]);
    const over = renderBlocked(source + '<p id="late" style="padding:9px">late text</p>');
    expect(inspect(over.html).elements.find(({ attributes }) => attributes.id === 'late')?.attributes.style).toBeUndefined();
    expect(over.warnings.some((warning: string) => /formatting/i.test(warning))).toBe(true);
  });

  it('does not let invalid selectors consume external-image counts or inline output budget', () => {
    const bytes = paddedPng();
    const candidate = sourceImageCandidate('large@example.test', bytes);
    const discarded = 'background-image:url(cid:large@example.test);'.repeat(320);
    const result = renderMailHtml({
      html: `<style>[data-untrusted]{${discarded}background-image:url(https://images.example.com/discarded.png)}</style><img src="cid:large@example.test"><img src="https://images.example.com/visible.png">`,
      remoteImages: 'allowed', inlineCandidates: [candidate],
    });
    const view = inspect(result.html);
    expect(view.elements.filter(({ tag }) => tag === 'img').map(({ attributes }) => attributes.src))
      .toEqual([`data:image/png;base64,${candidate.base64}`, 'https://images.example.com/visible.png']);
    expect(result.remoteImageCount).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('retains a 20KiB CID table background alongside its source padding', () => {
    const bytes = paddedPng();
    expect(bytes.length).toBe(20 * 1024);
    const candidate = sourceImageCandidate('large@example.test', bytes);
    const result = renderBlocked('<table><tr><td background="cid:large@example.test" style="padding:9px">Invoice</td></tr></table>', { inlineCandidates: [candidate] });
    const view = inspect(result.html);
    expectNoExternalResources(view);
    const cell = view.elements.find(({ tag }) => tag === 'td');
    expect(cell?.attributes.style).toContain('padding:9px');
    expect(cssNodes(view).filter((node) => node.type === 'Url').map((node) => node.value))
      .toEqual([`data:image/png;base64,${candidate.base64}`]);
    expect(result.warnings).toEqual([]);
  });

  it('unwraps form/button presentation without discarding the invoice or retaining actions', () => {
    const result = renderBlocked('<form action="https://payments.example.com/charge" method="post" onsubmit="alert(1)"><p>Invoice total 42</p><button type="submit" formaction="https://payments.example.com/other" onclick="alert(1)">Pay</button></form>');
    const view = inspect(result.html);
    expectNoExternalResources(view);
    expect(view.text).toContain('Invoice total 42');
    expect(view.text).toContain('Pay');
    expect(view.elements.some(({ attributes }) => 'method' in attributes || 'formaction' in attributes || 'action' in attributes)).toBe(false);
  });

  it('caps aggregate CID pixels at 40M despite tiny encoded header fixtures', () => {
    // Header-only fixtures intentionally exercise budget accounting, not browser
    // decoding validity. Each declares 16M pixels while occupying only 24 bytes.
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(4000, 16); bytes.writeUInt32BE(4000, 20);
    const candidates = Array.from({ length: 20 }, (_, i) => sourceImageCandidate(`budget-${i}@example.test`, bytes));
    const html = candidates.map(({ contentId }) => `<img src="cid:${contentId}">`).join('');
    const result = renderBlocked(html, { inlineCandidates: candidates });
    const images = inspect(result.html).elements.filter(({ tag, attributes }) => tag === 'img' && attributes.src?.startsWith('data:image/png;'));
    expect(images).toHaveLength(2);
    expect(result.warnings.some((warning: string) => /embedded images/i.test(warning))).toBe(true);
    expect(result.remoteImageCount).toBe(0);
    const oversized = Buffer.from(bytes); oversized.writeUInt32BE(4001, 16);
    const individual = renderBlocked('<img src="cid:over@example.test">', { inlineCandidates: [sourceImageCandidate('over@example.test', oversized)] });
    expect(inspect(individual.html).elements.some(({ attributes }) => Boolean(attributes.src))).toBe(false);
    expect(individual.warnings.some((warning: string) => /embedded images/i.test(warning))).toBe(true);
  });
});
