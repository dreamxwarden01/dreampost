import sanitizeHtml from 'sanitize-html';
import * as cssTree from 'css-tree';
import { parseDocument } from 'htmlparser2';
import { isIP } from 'node:net';

const MAX_HTML = 1024 * 1024;
const MAX_CSS = 128 * 1024;
const MAX_NODES = 12_000;
const MAX_INLINE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const BLOCKED_TAGS = ['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
  'input', 'select', 'option', 'textarea', 'xmp', 'plaintext', 'noembed', 'noframes', 'template', 'title', 'audio', 'video', 'canvas'];
const TAGS = ['a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'ins', 'li', 'main', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'th', 'thead', 'tfoot', 'time', 'tr', 'tt', 'u', 'ul', 'wbr'];
const PROPERTIES = new Set(('color background background-color background-image background-position background-size background-repeat '
  + 'font font-family font-size font-style font-weight font-variant line-height letter-spacing word-spacing '
  + 'text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-transform text-overflow '
  + 'white-space overflow-wrap word-break vertical-align direction unicode-bidi '
  + 'margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left '
  + 'width height min-width min-height max-width max-height box-sizing '
  + 'border border-top border-right border-bottom border-left border-color border-width border-style border-radius '
  + 'border-top-color border-right-color border-bottom-color border-left-color border-top-width border-right-width border-bottom-width border-left-width '
  + 'border-collapse border-spacing table-layout caption-side empty-cells '
  + 'display visibility float clear list-style-type list-style-position overflow overflow-x overflow-y '
  + 'flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content gap row-gap column-gap order').split(' '));
const FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'calc', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient']);
const PSEUDOS = new Set(['hover', 'active', 'focus', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'empty', 'root']);
const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Validate a bounded raster container without executing a decoder or native converter. */
function rasterType(bytes) {
  let type, width = 0, height = 0, frames = 1;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    type = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    // Animated PNG frames must not hide a larger decoding budget.
    if (bytes.includes(Buffer.from('acTL'))) return null;
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    type = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
    let pos = 13 + ((bytes[10] & 128) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0); frames = 0;
    const blocks = () => { while (pos < bytes.length) { const size = bytes[pos++]; if (size === 0) return true; pos += size; } return false; };
    while (pos < bytes.length) {
      const kind = bytes[pos++];
      if (kind === 0x3b) break;
      if (kind === 0x21) { pos++; if (!blocks()) return null; }
      else if (kind === 0x2c) {
        if (pos + 9 > bytes.length || ++frames > 50) return null;
        const frameWidth = bytes.readUInt16LE(pos + 4), frameHeight = bytes.readUInt16LE(pos + 6);
        if (!frameWidth || !frameHeight || frameWidth > width || frameHeight > height) return null;
        const packed = bytes[pos + 8]; pos += 9 + ((packed & 128) ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
        if (!blocks()) return null;
      } else return null;
    }
    if (!frames) return null;
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    type = 'image/jpeg'; let pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos++] !== 0xff) return null;
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(pos);
      if (length < 2 || pos + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) return null;
        height = bytes.readUInt16BE(pos + 3); width = bytes.readUInt16BE(pos + 5); break;
      }
      pos += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    type = 'image/webp'; const format = bytes.toString('ascii', 12, 16);
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
    if (format === 'VP8X') {
      if (bytes[20] & 2) return null;
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (format === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (format === 'VP8L' && bytes[20] === 0x2f) {
      width = 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]);
      height = 1 + (((bytes[24] & 0xf) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6));
    }
  }
  return type && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height * frames <= MAX_PIXELS ? { type, pixels: width * height * frames } : null;
}

/** Pure rendering: the function never fetches a URL, runs scripts, or writes a file. */
export function renderMailHtml(input) {
  if (!input || typeof input.html !== 'string' || Buffer.byteLength(input.html) > MAX_HTML) throw new Error('html_source_too_large');
  if (!['blocked', 'allowed'].includes(input.remoteImages)) throw new Error('invalid_image_mode');
  const warnings = new Set();
  const remote = new Set();
  const forbiddenOrigins = new Set((input.blockedOrigins ?? []).map(value => { try { return new URL(value).origin; } catch { return ''; } }));
  const inline = new Map(); const duplicateCids = new Set(); let inlineBytes = 0, inlinePixels = 0;
  for (const item of (input.inlineCandidates ?? []).slice(0, 20)) {
    if (!item || typeof item.contentId !== 'string' || typeof item.base64 !== 'string' || item.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64)) continue;
    const cid = item.contentId.replace(/^<|>$/g, '');
    if (!cid || cid.length > 512 || /[\s\x00-\x1f]/.test(cid)) continue;
    if (inline.has(cid) || duplicateCids.has(cid)) { inline.delete(cid); duplicateCids.add(cid); continue; }
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64 || bytes.length !== item.sizeBytes || bytes.length > MAX_IMAGE_BYTES) continue;
    const raster = rasterType(bytes);
    if (!raster || raster.type !== item.mimeType || inlineBytes + bytes.length > MAX_INLINE_BYTES || inlinePixels + raster.pixels > 40_000_000) { warnings.add('Some embedded images could not be displayed.'); continue; }
    inlineBytes += bytes.length; inlinePixels += raster.pixels; inline.set(cid, `data:${raster.type};base64,${item.base64}`);
  }
  function publicUrl(value, image = false) {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    let url; try { url = new URL(value); } catch { return null; }
    if (!(image ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)) || url.username || url.password
      || url.port || forbiddenOrigins.has(url.origin)) return null;
    const host = url.hostname.toLowerCase();
    // Reject literals and obvious local names. Direct browser DNS resolution is not a server-enforced private-network boundary.
    if (isIP(host) || host.startsWith('[') || !host.includes('.') || host.endsWith('.')
      || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/.test(host)
      || !/^[a-z0-9.-]+$/.test(host)) return null;
    return url.href;
  }
  const safeData = new Set(inline.values()); let embeddedOutputBytes = 0;
  function imageUrl(value, consume = true, allowExternal = true) {
    if (typeof value !== 'string') return null;
    if (/^cid:/i.test(value)) {
      let cid; try { cid = decodeURIComponent(value.slice(4)); } catch { return null; }
      const data = inline.get(cid.replace(/^<|>$/g, ''));
      if (!data) return null;
      if (consume && (embeddedOutputBytes += data.length) > 8 * 1024 * 1024) { warnings.add('Some embedded images could not be displayed.'); return null; }
      return data;
    }
    if (safeData.has(value)) {
      if (consume && (embeddedOutputBytes += value.length) > 8 * 1024 * 1024) return null;
      return value;
    }
    const url = publicUrl(value, true);
    if (!url || !allowExternal) return null;
    remote.add(url);
    return input.remoteImages === 'allowed' ? url : null;
  }
  let stylesheetBytes = 0, inlineCssBytes = 0, declarations = 0, rules = 0;
  const formattingLimit = () => warnings.add('Some formatting could not be applied.');
  function safeDeclarations(block, allowExternalBackgrounds = true) {
    const output = [];
    for (const declaration of block.children ?? []) {
      if (++declarations > 12_000) { formattingLimit(); break; }
      if (declaration.type !== 'Declaration') continue;
      const property = cssTree.ident.decode(declaration.property).toLowerCase();
      if (!PROPERTIES.has(property)) continue;
      let valid = true, count = 0;
      cssTree.walk(declaration.value, node => {
        if (++count > 128) valid = false;
        if (node.type === 'Raw' || node.type === 'Atrule') valid = false;
        if (node.type === 'Function' && !FUNCTIONS.has(cssTree.ident.decode(node.name).toLowerCase())) valid = false;
        if (node.type === 'Url') {
          if (!['background', 'background-image'].includes(property)) { valid = false; return; }
          const target = imageUrl(node.value, true, allowExternalBackgrounds);
          if (target) node.value = target;
          else { node.type = 'Identifier'; node.name = 'none'; delete node.value; }
        }
        if (node.type === 'String' && node.value.length > 512) valid = false;
        if (node.type === 'Dimension' && (!Number.isFinite(Number(node.value)) || Math.abs(Number(node.value)) > 10000)) valid = false;
      });
      if (!valid) continue;
      try {
        if (!cssTree.lexer.matchProperty(property, declaration.value).matched) continue;
        output.push(`${property}:${cssTree.generate(declaration.value)}${declaration.important ? '!important' : ''}`);
      } catch { /* Unsupported CSS is omitted while other declarations survive. */ }
    }
    return output.join(';');
  }
  function style(value) {
    if (typeof value !== 'string') return '';
    if (value.length > 16_384 || (inlineCssBytes += value.length) > 512 * 1024) { formattingLimit(); return ''; }
    try { return safeDeclarations(cssTree.parse(value, { context: 'declarationList', positions: false })); } catch { return ''; }
  }
  function selector(value) {
    if (!value || value.type !== 'SelectorList') return null;
    let valid = true, count = 0;
    cssTree.walk(value, node => {
      if (++count > 128 || !['SelectorList', 'Selector', 'TypeSelector', 'ClassSelector', 'IdSelector', 'Combinator', 'PseudoClassSelector'].includes(node.type)) valid = false;
      if (node.type === 'PseudoClassSelector' && (node.children || !PSEUDOS.has(cssTree.ident.decode(node.name).toLowerCase()))) valid = false;
      if (node.type === 'TypeSelector' && (node.name.includes('|') || node.name.includes('\\'))) valid = false;
    });
    const result = valid ? cssTree.generate(value) : '';
    return result && result.length < 1500 ? result : null;
  }
  function stylesheet(value) {
    if (typeof value !== 'string') return '';
    if ((stylesheetBytes += value.length) > MAX_CSS) { formattingLimit(); return ''; }
    function children(block, depth = 0) {
      if (depth > 3) return '';
      const output = [];
      for (const rule of block.children ?? []) {
        if (++rules > 300) { formattingLimit(); break; }
        if (rule.type === 'Rule') {
          const selectors = selector(rule.prelude); if (!selectors) continue;
          let interactive = false;
          cssTree.walk(rule.prelude, node => { if (node.type === 'PseudoClassSelector' && ['hover', 'active', 'focus'].includes(cssTree.ident.decode(node.name).toLowerCase())) interactive = true; });
          const declarations = safeDeclarations(rule.block, !interactive);
          if (declarations) output.push(`${selectors}{${declarations}}`);
        } else if (rule.type === 'Atrule' && rule.name.toLowerCase() === 'media' && rule.block && rule.prelude) {
          const media = cssTree.generate(rule.prelude);
          if (media.length <= 300 && media.split(',').every(part => /^(?:(?:only\s+)?(?:screen|print|all)\s*(?:and\s*)?)?(?:\((?:min-|max-)?width:\s*\d+(?:\.\d+)?(?:px|em|rem)\)\s*(?:and\s*\((?:min-|max-)?width:\s*\d+(?:\.\d+)?(?:px|em|rem)\))?)?$/i.test(part.trim()) && part.trim())) {
            const inner = children(rule.block, depth + 1); if (inner) output.push(`@media ${media}{${inner}}`);
          }
        }
      }
      return output.join('\n');
    }
    try { return children(cssTree.parse(value, { positions: false })); } catch { return ''; }
  }
  const stylesheets = [];
  const tree = parseDocument(input.html, { decodeEntities: true });
  const stack = [...tree.children].reverse().map(node => ({ node, depth: 0 })); let nodes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++nodes > MAX_NODES || depth > 100) throw new Error('html_structure_too_complex');
    if (node.name === 'style') { stylesheets.push(stylesheet((node.children ?? []).map(child => child.data ?? '').join(''))); continue; }
    if (BLOCKED_TAGS.includes(node.name)) continue;
    for (const child of [...(node.children ?? [])].reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  const dimension = value => typeof value === 'string' && /^(?:\d{1,4}|\d{1,3}%)$/.test(value) && Number.parseInt(value) <= (value.endsWith('%') ? 100 : 8192) ? value : undefined;
  const safe = sanitizeHtml(input.html, {
    allowedTags: TAGS,
    allowedAttributes: { '*': ['class', 'id', 'style', 'dir', 'lang', 'title'],
      a: ['href', 'target', 'rel', 'title'], img: ['src', 'alt', 'width', 'height', 'referrerpolicy', 'decoding'],
      table: ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'align'], td: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign'],
      th: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'scope'], col: ['width', 'span'], font: ['color', 'face', 'size'], ol: ['start', 'type'], li: ['value'] },
    allowedSchemes: ['http', 'https'], allowedSchemesByTag: { img: ['https', 'data'] }, allowProtocolRelative: false,
    disallowedTagsMode: 'discard', nonTextTags: [...BLOCKED_TAGS, 'style'], enforceHtmlBoundary: false,
    nestingLimit: 100, parseStyleAttributes: false,
    transformTags: {
      img: (tagName, attribs) => imageUrl(attribs.src, false) ? { tagName, attribs }
        : { tagName: 'span', attribs: { class: 'dp-image-placeholder', title: 'Image not loaded' }, text: attribs.alt?.slice(0, 500) || 'Image' },
      '*': (originalTag, original) => {
        const tagName = originalTag === 'body' || originalTag === 'html' ? 'div' : originalTag;
        if (!TAGS.includes(tagName)) return { tagName, attribs: {} };
        const attrs = {};
        for (const name of ['class', 'id']) if (typeof original[name] === 'string' && /^[A-Za-z0-9_ -]{1,300}$/.test(original[name])) attrs[name] = original[name];
        if (['ltr', 'rtl', 'auto'].includes(original.dir)) attrs.dir = original.dir;
        if (typeof original.lang === 'string' && /^[A-Za-z-]{1,30}$/.test(original.lang)) attrs.lang = original.lang;
        if (original.title) attrs.title = original.title.slice(0, 500);
        const css = [original.style ?? ''];
        if (original.bgcolor && /^(?:#[0-9a-f]{3,8}|[a-z]{1,20})$/i.test(original.bgcolor)) css.push(`background-color:${original.bgcolor}`);
        if (original.background) css.push(`background-image:url(${JSON.stringify(original.background)})`);
        const inlineStyle = style(css.join(';')); if (inlineStyle) attrs.style = inlineStyle;
        for (const name of ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'colspan', 'rowspan', 'span', 'start', 'value']) {
          const value = dimension(original[name]); if (value !== undefined) attrs[name] = value;
        }
        if (['left', 'center', 'right', 'justify'].includes(original.align)) attrs.align = original.align;
        if (['top', 'middle', 'bottom', 'baseline'].includes(original.valign)) attrs.valign = original.valign;
        if (tagName === 'font') {
          if (/^(?:#[0-9a-f]{3,8}|[a-z]{1,20})$/i.test(original.color ?? '')) attrs.color = original.color;
          if (/^[A-Za-z0-9 ,_-]{1,150}$/.test(original.face ?? '')) attrs.face = original.face;
          if (/^[1-7]$/.test(original.size ?? '')) attrs.size = original.size;
        }
        if (tagName === 'a') {
          const href = publicUrl(original.href);
          if (href) { attrs.href = href; attrs.target = '_blank'; attrs.rel = 'noopener noreferrer'; }
        }
        if (tagName === 'img') {
          const src = imageUrl(original.src);
          if (!src) return { tagName: 'span', attribs: { class: 'dp-image-placeholder', title: 'Image not loaded' }, text: original.alt?.slice(0, 500) || 'Image' };
          attrs.src = src; attrs.alt = original.alt?.slice(0, 1000) ?? ''; attrs.referrerpolicy = 'no-referrer'; attrs.decoding = 'async';
        }
        return { tagName, attribs: attrs };
      },
    },
  });
  // CSS strings may contain HTML raw-text delimiters even after valid CSS parsing.
  const css = stylesheets.join('\n').replaceAll('<', '\\3c ');
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:" + (input.remoteImages === 'allowed' ? ' https:' : '')
    + "; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const document = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escapeText(policy)
    + '"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>html{color-scheme:light}body{margin:16px;background:#fff;color:#202124;font:15px/1.55 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#155eef}.dp-image-placeholder{display:inline-block;border:1px solid #d6d8df;color:#626a7a;padding:2px 6px;font:12px/1.4 Arial,sans-serif}</style>'
    + '<style>' + css + '</style></head><body>' + safe + '</body></html>';
  return { html: document, remoteImageCount: remote.size, warnings: [...warnings] };
}
