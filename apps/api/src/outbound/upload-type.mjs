// Content classification only; documents remain untrusted and are never opened here.
// Keep the bounded raster container checks aligned with attachments/extraction-worker.mjs.
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
export function inferUploadMimeType(value) {
  const bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  const raster=rasterType(bytes);
  if(raster)return raster.type;
  return /^%PDF-[12]\.[0-9]/.test(bytes.toString('ascii',0,Math.min(8,bytes.length)))?'application/pdf':'application/octet-stream';
}
