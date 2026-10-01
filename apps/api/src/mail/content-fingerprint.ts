import { createHash } from 'node:crypto';
import { MAX_INBOUND_BYTES } from '@dreampost/protocol';

export const MAIL_CONTENT_FINGERPRINT_VERSION = 1 as const;
export interface MailContentFingerprint { version: typeof MAIL_CONTENT_FINGERPRINT_VERSION; sha256: string }
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_HEADER_FIELDS = 512;
// These fields describe transport, authentication or provider-assigned identity.
// Excluding them is not validation of their contents or a sender-authentication claim.
const TRANSPORT_HEADERS = new Set([
  'date', 'message-id', 'received', 'return-path', 'delivered-to',
  'x-original-to', 'x-envelope-to', 'x-envelope-from',
  'authentication-results', 'received-spf', 'dkim-signature',
  'arc-authentication-results', 'arc-message-signature', 'arc-seal',
  // Added by the controlled Cloudflare send/receive path, not message content.
  'feedback-id', 'x-cf-spamh-score',
]);
const SINGLETON_IDENTITY_HEADERS = new Set(['date', 'message-id']);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function withoutEmptyMultipartEpilogue(body: Buffer, contentType: string | undefined): Buffer {
  // The live fidelity probe preserved every MIME part byte and appended one CRLF
  // after the closing delimiter. Only empty CRLF epilogue lines are transport
  // padding here. Plain text, part whitespace and nonempty epilogues stay exact.
  // Unsupported parameter forms keep strict bytes rather than being guessed.
  const type = /^[ \t]*multipart\/[a-z0-9!#$%&'*+.^_`|~-]+[ \t]*;[ \t]*boundary[ \t]*=[ \t]*(?:"([a-z0-9'()+_,./:=?\-]{1,70})"|([a-z0-9'()+_,./:=?\-]{1,70}))[ \t]*$/i.exec(contentType ?? '');
  const boundary = type?.[1] ?? type?.[2];
  if (!boundary) return body;
  const opening = Buffer.from(`--${boundary}\r\n`), closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  const start = body.indexOf(opening), endAt = body.lastIndexOf(closing);
  if (start < 0 || (start > 0 && (body[start - 2] !== 13 || body[start - 1] !== 10)) || endAt <= start) return body;
  const end = endAt + closing.length;
  for (let offset = end; offset < body.length; offset += 2) {
    if (body[offset] !== 13 || body[offset + 1] !== 10) return body;
  }
  return body.subarray(0, end);
}

function withoutPlainTextTransportPadding(body: Buffer, fields: Array<{ name: string; value: string }>): Buffer {
  const value = (name: string) => fields.find(field => field.name === name)?.value.trim();
  // The real generator emits QP for Unicode, 7bit for ASCII and bare text/plain
  // without an encoding for an empty body. Broader HTML/charset/attachment cases
  // are not inferred. The immutable raw digest still records exact transport bytes.
  const type = value('content-type') ?? '', encoding = value('content-transfer-encoding')?.toLowerCase();
  if (fields.some(field => field.name === 'content-disposition' || field.name === 'content-id')) return body;
  if (/^text\/plain$/i.test(type) && encoding === undefined) {
    for (let offset = 0; offset < body.length; offset += 2) {
      if (body[offset] !== 13 || body[offset + 1] !== 10) return body;
    }
    return body.subarray(0, 0);
  }
  if (!/^text\/plain;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8")$/i.test(type)
    || (encoding !== 'quoted-printable' && encoding !== '7bit')) return body;
  for (let offset = 0; offset < body.length; offset++) {
    const byte = body[offset]!;
    if (encoding === '7bit' && byte !== 9 && byte !== 13 && byte !== 10 && (byte < 32 || byte > 126)) return body;
    if (body[offset] === 13 && body[offset + 1] !== 10) return body;
    if (body[offset] === 10 && body[offset - 1] !== 13) return body;
  }
  let end = body.length;
  while (end >= 2 && body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
  // A quoted-printable soft break is encoded content, not an empty terminal line.
  // Keep at least one original CRLF; missing line termination remains distinct.
  if (body.length - end < 4 || (encoding === 'quoted-printable' && end > 0 && body[end - 1] === 61)) return body;
  return body.subarray(0, end + 2);
}

/**
 * Complete, conservative MIME content equivalence, not sender authentication.
 * Callers must separately bind the accepted outbox, recipient and admission-era
 * mailbox. The version includes the exact exclusion/canonicalization policy.
 *
 * Every other top-level header is protected, including unknown extension fields.
 * Header names/order are canonicalized; unfolding only removes CRLF, retaining
 * its whitespace bytes. Values are otherwise exact, including encoded words.
 * All MIME parts, nested headers and attachment bytes are hashed without
 * decoding, trimming, line-ending repair or Unicode normalization. Only empty
 * CRLF epilogue lines after a supported multipart closing delimiter, or surplus
 * terminal CRLF lines in the supported generated plain-text representation, are
 * omitted. Both append-only changes were confirmed by separate live probes.
 * This proves content equivalence under that policy, never raw-byte identity.
 * Strict representation differences deliberately fail to correlate. Bounded or
 * malformed input is unavailable evidence; never substitute reader text for it.
 */
export function fingerprintMessageContent(raw: Uint8Array): MailContentFingerprint | null {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > MAX_INBOUND_BYTES) return null;
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const separator = bytes.indexOf('\r\n\r\n');
  if (separator <= 0 || separator > MAX_HEADER_BYTES) return null;
  // Latin-1 is a lossless mapping of header bytes, not a charset interpretation.
  const lines = bytes.subarray(0, separator).toString('latin1').split('\r\n');
  const fields: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    if (!line || /[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return null;
    if (/^[ \t]/.test(line)) {
      const previous = fields.at(-1);
      if (!previous) return null;
      previous.value += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(line.slice(0, colon))) return null;
    if (fields.length >= MAX_HEADER_FIELDS) return null;
    fields.push({ name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1) });
  }
  const seen = new Set<string>();
  const protectedHeaders: Array<[string, string]> = [];
  let hasFrom = false;
  for (const field of fields) {
    if ((!TRANSPORT_HEADERS.has(field.name) || SINGLETON_IDENTITY_HEADERS.has(field.name)) && seen.has(field.name)) return null;
    seen.add(field.name);
    if (field.name === 'from') {
      if (!field.value.trim()) return null;
      hasFrom = true;
    }
    if (!TRANSPORT_HEADERS.has(field.name)) protectedHeaders.push([field.name, field.value]);
  }
  if (!hasFrom) return null;
  protectedHeaders.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const multipartBody = withoutEmptyMultipartEpilogue(bytes.subarray(separator + 4), fields.find(field => field.name === 'content-type')?.value);
  const body = withoutPlainTextTransportPadding(multipartBody, fields);
  const canonical = JSON.stringify({ kind: 'dreampost-mail-content', version: MAIL_CONTENT_FINGERPRINT_VERSION,
    headers: protectedHeaders, bodySize: body.byteLength, bodySha256: digest(body) });
  return { version: MAIL_CONTENT_FINGERPRINT_VERSION, sha256: digest(canonical) };
}
