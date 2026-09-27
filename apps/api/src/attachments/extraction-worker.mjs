import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';

// This process decodes MIME transfer encodings only; it never opens a document or extracts document text.
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
  return type && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height * frames <= 16_000_000 ? { type, pixels: width * height * frames } : null;
}


function field(value, nullable = false) {
  if (value == null && nullable) return null;
  const text = String(value ?? '').replace(/\u0000/g, '\uFFFD');
  if (Buffer.byteLength(text) > 16384) throw new Error('attachment_metadata_limit');
  return text;
}
try {
  const options = workerData.options;
  const parser = new PostalMime(options.mime);
  const mail = await parser.parse(new Uint8Array(workerData.raw));
  // PostalMime 3.0.1 normalizes calendar attachments into UTF-8/newlines. Downloads require the
  // transfer-decoded source bytes instead. This guarded adapter depends on the pinned MIME tree.
  const calendars = mail.attachments.filter(part => ['text/calendar', 'application/ics'].includes(part.mimeType));
  if (calendars.length) {
    const leaves = [];
    const walk = node => {
      if (!node || !Array.isArray(node.childNodes)) throw new Error('attachment_calendar_correspondence_mismatch');
      if (!node.contentType?.multipart && ['text/calendar', 'application/ics'].includes(node.contentType?.parsed?.value)) {
        if (!(node.content instanceof ArrayBuffer) && !(node.content instanceof Uint8Array)) throw new Error('attachment_calendar_correspondence_mismatch');
        leaves.push(node);
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(parser.root);
    if (leaves.length !== calendars.length) throw new Error('attachment_calendar_correspondence_mismatch');
    calendars.forEach((attachment, index) => {
      const leaf = leaves[index];
      if (leaf.contentType.parsed.value !== attachment.mimeType) throw new Error('attachment_calendar_correspondence_mismatch');
      attachment.content = leaf.content;
    });
  }
  if (mail.attachments.length > options.maxParts) throw new Error('attachment_count_limit');
  let totalBytes = 0;
  const parts = mail.attachments.map((attachment, ordinal) => {
    const source = attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content)
      : attachment.content instanceof Uint8Array ? attachment.content : null;
    if (!source) throw new Error('attachment_content_unavailable');
    totalBytes += source.byteLength;
    if (source.byteLength > options.maxDecodedBytes || totalBytes > options.maxDecodedBytes) throw new Error('attachment_decoded_size_limit');
    const bytes = Uint8Array.from(source);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const raster = rasterType(buffer);
    // A magic match only selects an isolated preview path. It is not a malware or PDF validity verdict.
    const isPdf = /^%PDF-[12]\.[0-9]/.test(buffer.toString('ascii', 0, Math.min(8, buffer.length)));
    const previewKind = raster ? 'raster' : isPdf ? 'pdf' : 'none';
    const mediaType = raster?.type ?? (isPdf ? 'application/pdf' : 'application/octet-stream');
    return { ordinal, filename: field(attachment.filename), mimeType: field(attachment.mimeType),
      disposition: field(attachment.disposition, true),
      contentId: field(attachment.contentId, true), sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), previewKind, mediaType, bytes };
  });
  parentPort.postMessage({ ok: true, parts }, parts.map(part => part.bytes.buffer));
} catch (error) {
  const code = ['attachment_calendar_correspondence_mismatch', 'attachment_count_limit', 'attachment_metadata_limit', 'attachment_content_unavailable', 'attachment_decoded_size_limit'].includes(error?.message)
    ? error.message : 'attachment_mime_parse_failed';
  parentPort.postMessage({ ok: false, code });
} finally { parentPort.close(); }
