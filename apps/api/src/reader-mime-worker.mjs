import { parentPort, workerData } from 'node:worker_threads';
import PostalMime from 'postal-mime';

// This worker interprets MIME only. It never evaluates markup or attachment contents.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_INLINE_COUNT = 20;
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

try {
  const email = await PostalMime.parse(new Uint8Array(workerData.raw), {
    attachmentEncoding: 'arraybuffer', maxNestingDepth: 30, maxHeadersSize: 256 * 1024,
    forceRfc822Attachments: true, rfc822Attachments: true, maxRfc822NestingDepth: 5,
  });
  const warnings = new Set();
  const clean = (value) => String(value ?? '').replace(/\u0000/g, '\uFFFD');
  const bounded = (value, maximum, warning) => {
    const text = clean(value);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maximum) return text;
    warnings.add(warning);
    return bytes.subarray(0, maximum).toString('utf8');
  };
  const header = (value) => bounded(value, MAX_HEADER_VALUE_BYTES, 'header_value_truncated');
  const formatAddress = (value) => {
    if (!value) return '';
    if (Array.isArray(value.group)) return `${clean(value.name)}: ${value.group.map(formatAddress).join(', ')};`;
    return value.name && value.address ? `${value.name} <${value.address}>` : value.address ?? value.name ?? '';
  };
  const dateHeaders = email.headers.filter((item) => item.key === 'date');
  const fromHeaders = email.headers.filter((item) => item.key === 'from');
  if (dateHeaders.length > 1) warnings.add('multiple_date_headers');
  if (fromHeaders.length > 1) warnings.add('multiple_from_headers');
  const timestamp = email.date ? Date.parse(email.date) : Number.NaN;
  const sentAt = dateHeaders.length <= 1 && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  const headers = {
    subject: header(email.subject), from: header(formatAddress(email.from)),
    replyTo: header((email.replyTo ?? []).map(formatAddress).join(', ')),
    to: header((email.to ?? []).map(formatAddress).join(', ')),
    cc: header((email.cc ?? []).map(formatAddress).join(', ')),
    dateHeader: header(dateHeaders.map((item) => item.value).join('\n')), sentAt,
    messageId: header(email.messageId),
  };
  const text = bounded(email.text, MAX_TEXT_BYTES, 'plain_text_truncated');
  let htmlSource = email.html ? clean(email.html) : null;
  if (htmlSource !== null && Buffer.byteLength(htmlSource, 'utf8') > MAX_HTML_BYTES) {
    warnings.add('html_too_large'); htmlSource = null;
  }
  const candidateParts = new Map();
  const duplicated = new Set();
  for (const attachment of email.attachments) {
    if (!attachment.contentId) continue;
    let contentId = attachment.contentId.trim();
    if (contentId.startsWith('<') && contentId.endsWith('>')) contentId = contentId.slice(1, -1);
    if (!contentId || contentId.length > 1024 || /[\s<>\u0000-\u001f\u007f]/.test(contentId)) {
      warnings.add('invalid_content_id'); continue;
    }
    if (candidateParts.has(contentId)) { duplicated.add(contentId); warnings.add('duplicate_content_id'); }
    else candidateParts.set(contentId, attachment);
  }
  const inlineCandidates = [];
  let total = 0;
  for (const [contentId, attachment] of candidateParts) {
    if (duplicated.has(contentId)) continue;
    const mimeType = attachment.mimeType.toLowerCase();
    if (!rasterTypes.has(mimeType)) { warnings.add('unsupported_inline_type'); continue; }
    const bytes = attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content)
      : attachment.content instanceof Uint8Array ? attachment.content : null;
    if (!bytes || bytes.length === 0 || bytes.length > MAX_INLINE_BYTES) { warnings.add('inline_image_size_limit'); continue; }
    if (inlineCandidates.length >= MAX_INLINE_COUNT || total + bytes.length > MAX_INLINE_TOTAL_BYTES) {
      warnings.add('inline_image_total_limit'); continue;
    }
    total += bytes.length;
    // Declared MIME types are not trusted validation. The rendering boundary must inspect the actual raster bytes.
    inlineCandidates.push({ contentId, mimeType, sizeBytes: bytes.length, base64: Buffer.from(bytes).toString('base64') });
  }
  parentPort.postMessage({ ok: true, value: {
    subject: headers.subject, from: headers.from, to: headers.to, text,
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 200) || (htmlSource ? 'HTML message' : ''),
    reader: { parserVersion: workerData.parserVersion, headers, htmlSource, inlineCandidates, warnings: [...warnings] },
  } });
} catch {
  parentPort.postMessage({ ok: false, code: 'mime_parse_failed' });
} finally {
  parentPort.close();
}
