import { describe, expect, it } from 'vitest';
import { MAX_INBOUND_BYTES } from '@dreampost/protocol';
import { fingerprintMessageContent, MAIL_CONTENT_FINGERPRINT_VERSION } from '../src/mail/content-fingerprint.js';

const headers = [
  'From: Owner <owner@example.test>', 'Sender: owner@example.test', 'Reply-To: replies@example.test',
  'To: Person <person@example.test>', 'Cc: self@example.test', 'Subject: Exact subject',
  'References: <ancestor@example.test>', 'In-Reply-To: <parent@example.test>',
  'Date: Thu, 1 Oct 2026 10:00:00 +0000', 'Message-ID: <local@example.test>',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="opaque-boundary"',
  'X-DreamPost-Test: preserved extension',
];
const body = '--opaque-boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nExact authored body =E2=9C=93\r\n--opaque-boundary\r\nContent-Type: application/octet-stream; name="fixture.bin"\r\nContent-Disposition: attachment; filename="fixture.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAwQF\r\n--opaque-boundary--\r\n';
const raw = (fields = headers, content: string | Buffer = body) => Buffer.concat([Buffer.from(fields.join('\r\n') + '\r\n\r\n'), Buffer.from(content)]);
const proof = (fields = headers, content: string | Buffer = body) => fingerprintMessageContent(raw(fields, content));

describe('complete MIME content correlation fingerprint', () => {
  it('returns a deterministic versioned complete digest without changing raw bytes', () => {
    const bytes = raw(), before = Buffer.from(bytes), first = fingerprintMessageContent(bytes);
    expect(first).toMatchObject({ version: MAIL_CONTENT_FINGERPRINT_VERSION, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(fingerprintMessageContent(bytes)).toEqual(first); expect(bytes).toEqual(before);
  });
  it('tolerates explicitly excluded transport and provider identity changes only', () => {
    const changed = headers.map(line => line.startsWith('Date:') ? 'Date: Fri, 2 Oct 2026 10:00:00 +0000'
      : line.startsWith('Message-ID:') ? 'Message-ID: <provider@example.test>' : line);
    changed.push('Received: from provider by edge', 'Received: another transport hop', 'Return-Path: <bounce@example.test>',
      'Delivered-To: self@example.test', 'X-Original-To: self@example.test', 'X-Envelope-To: self@example.test',
      'X-Envelope-From: rewritten-bounce@example.test', 'Authentication-Results: arbitrary untrusted text',
      'Received-SPF: pass; untrusted text', 'DKIM-Signature: arbitrary signature', 'DKIM-Signature: second signature',
      'ARC-Authentication-Results: arbitrary text', 'ARC-Message-Signature: arbitrary text', 'ARC-Seal: arbitrary text');
    expect(proof(changed)).toEqual(proof());
  });
  it('canonicalizes only header order/name and lossless unfolding', () => {
    const changed = [...headers].reverse().map(line => line.startsWith('Subject:') ? 'sUbJeCt: Exact\r\n subject' : line);
    expect(proof(changed)).toEqual(proof());
    expect(proof(headers.map(line => line.startsWith('Subject:') ? 'Subject: Exact  subject' : line))).not.toEqual(proof());
  });
  it.each(['From', 'Sender', 'Reply-To', 'To', 'Cc', 'Subject', 'References', 'In-Reply-To', 'MIME-Version', 'Content-Type', 'X-DreamPost-Test'])(
    'protects the complete %s field rather than reader display text', name => {
      const changed = headers.map(line => line.startsWith(`${name}:`) ? `${line} changed` : line);
      expect(proof(changed)).not.toEqual(proof());
    });
  it('protects every MIME body byte, attachment payload, nested header and trailing whitespace', () => {
    for (const changed of [body.replace('AAECAwQF', 'AAECAwQG'), body.replace('fixture.bin', 'changed.bin'),
      body.replace('text/plain', 'text/html'), body.replace('Exact authored body', 'Changed authored body'),
      body + ' ', body.replaceAll('\r\n', '\n')]) expect(proof(headers, changed)).not.toEqual(proof());
    const binary = Buffer.from([0, 255, 128, 10]);
    expect(proof(headers, binary)).not.toEqual(proof(headers, Buffer.from([0, 254, 128, 10])));
  });
  it('tolerates only observed transport annotations and empty multipart epilogue CRLF lines', () => {
    const changed = [...headers, 'Feedback-ID: synthetic:provider', 'X-Cf-Spamh-Score: 0'];
    expect(proof(changed, body + '\r\n')).toEqual(proof());
    expect(proof(changed, body + '\r\n\r\n')).toEqual(proof());
    for (const suffix of [' ', '\n', '\r', '\r\n ', '\r\nnot empty', '\r\n\0']) {
      expect(proof(changed, body + suffix)).not.toEqual(proof());
    }
    expect(proof(headers, body.replace('AAECAwQF\r\n', 'AAECAwQF\r\n\r\n'))).not.toEqual(proof());
  });
  it('normalizes only terminal empty CRLF lines for the observed generated plain-text encoding', () => {
    const plain = [...headers.map(line => line.startsWith('Content-Type:') ? 'Content-Type: text/plain; charset=utf-8' : line), 'Content-Transfer-Encoding: quoted-printable'];
    const text = 'First line =E2=9C=93\r\n\r\nLast line\r\n';
    expect(proof(plain, text + '\r\n')).toEqual(proof(plain, text));
    expect(proof(plain, text + '\r\n\r\n')).toEqual(proof(plain, text));
    for (const changed of [text + ' ', text.replace('Last line', 'Last  line'), text.replace('\r\n\r\n', '\r\n'),
      text.replace('Last line\r\n', 'Last line \r\n'), text.replaceAll('\r\n', '\n'), text.slice(0, -2)]) {
      expect(proof(plain, changed)).not.toEqual(proof(plain, text));
    }
    expect(proof(plain, 'Soft break=\r\n\r\n')).not.toEqual(proof(plain, 'Soft break=\r\n'));
    expect(proof(plain, 'Bare\nline\r\n\r\n')).not.toEqual(proof(plain, 'Bare\nline\r\n'));
  });
  it('validates 7bit bytes and keeps literal equals signs distinct from quoted-printable soft breaks', () => {
    const plain = [...headers.map(line => line.startsWith('Content-Type:') ? 'Content-Type: text/plain; charset=utf-8' : line), 'Content-Transfer-Encoding: 7bit'];
    expect(proof(plain, 'Literal equals=\r\n\r\n')).toEqual(proof(plain, 'Literal equals=\r\n'));
    for (const content of ['Invalid \u0080\r\n', 'Control \0\r\n', 'Bare\nline\r\n']) {
      expect(proof(plain, content + '\r\n')).not.toEqual(proof(plain, content));
    }
    const empty = headers.map(line => line.startsWith('Content-Type:') ? 'Content-Type: text/plain' : line);
    expect(proof(empty, '\r\n')).toEqual(proof(empty, ''));
    expect(proof(empty, ' \r\n')).not.toEqual(proof(empty, ''));
    expect(proof(empty, 'Nonempty\r\n\r\n')).not.toEqual(proof(empty, 'Nonempty\r\n'));
  });
  it('never applies plain-text padding rules to HTML, attachments or unproven transfer representations', () => {
    const plain = [...headers.map(line => line.startsWith('Content-Type:') ? 'Content-Type: text/plain; charset=utf-8' : line), 'Content-Transfer-Encoding: quoted-printable'];
    const variants = [plain.map(line => line.replace('text/plain', 'text/html')), plain.map(line => line.replace('utf-8', 'iso-8859-1')),
      plain.map(line => line.replace('quoted-printable', 'base64')), plain.map(line => line.replace('quoted-printable', 'binary')),
      [...plain, 'Content-Disposition: attachment; filename=source.txt'], [...plain, 'Content-ID: <part@example.test>']];
    for (const fields of variants) expect(proof(fields, 'Content\r\n\r\n')).not.toEqual(proof(fields, 'Content\r\n'));
  });
  it('keeps unproven plain-text forms strict and never guesses malformed multipart framing', () => {
    const plain = headers.map(line => line.startsWith('Content-Type:') ? 'Content-Type: text/plain; charset=utf-8' : line);
    expect(proof(plain, 'Authored body\r\n\r\n')).not.toEqual(proof(plain, 'Authored body\r\n'));
    const broken = body.replace('--opaque-boundary--\r\n', '--different-boundary--\r\n');
    expect(proof(headers, broken + '\r\n')).not.toEqual(proof(headers, broken));
    const noOpening = body.replace('--opaque-boundary\r\n', '--wrong-opening\r\n').replace('--opaque-boundary\r\n', '--wrong-opening\r\n');
    expect(proof(headers, noOpening + '\r\n')).not.toEqual(proof(headers, noOpening));
    const unsupported = headers.map(line => line.startsWith('Content-Type:') ? line + '; unrecognized=value' : line);
    expect(proof(unsupported, body + '\r\n')).not.toEqual(proof(unsupported));
  });
  it('does not confuse identical visible text with extra alternative parts or attachment data', () => {
    expect(proof(headers, body.replace('--opaque-boundary--', '--opaque-boundary\r\nContent-Type: text/html\r\n\r\n<script>hidden bytes</script>\r\n--opaque-boundary--'))).not.toEqual(proof());
    expect(proof(headers, body.replace('Exact authored body =E2=9C=93', 'Exact authored body =e2=9c=93'))).not.toEqual(proof());
  });
  it.each(['From', 'Sender', 'Reply-To', 'To', 'Cc', 'Subject', 'References', 'In-Reply-To', 'MIME-Version', 'Content-Type', 'X-DreamPost-Test', 'Date', 'Message-ID'])(
    'fails closed on duplicate %s fields instead of accepting parser-first/last interpretations', name => {
      const existing = headers.find(line => line.startsWith(`${name}:`))!;
      expect(proof([...headers, existing])).toBeNull();
    });
  it('protects added Bcc, content-transfer-encoding and unknown extension headers', () => {
    for (const extra of ['Bcc: hidden@example.test', 'Content-Transfer-Encoding: base64', 'X-Unrecognized-Semantics: changed']) {
      expect(proof([...headers, extra])).not.toEqual(proof());
    }
  });
  it('fails closed on missing From, malformed framing, control bytes or invalid continuations', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('From: a@example.test\n\nbody'), Buffer.from('From: a@example.test\r\nbody'),
      raw(headers.filter(line => !line.startsWith('From:'))), raw(['From:   ']), raw([' folded without preceding header', ...headers]),
      raw(['Bad Name: value', ...headers]), raw(['Bad: value\x00', ...headers]), raw(['Bad: value\nInjected: value', ...headers])]) {
      expect(fingerprintMessageContent(bytes)).toBeNull();
    }
  });
  it('bounds raw bytes, header bytes and header count before accepting evidence', () => {
    expect(fingerprintMessageContent(Buffer.alloc(MAX_INBOUND_BYTES + 1))).toBeNull();
    expect(proof(['From: a@example.test', `X-Large: ${'a'.repeat(256 * 1024)}`])).toBeNull();
    expect(proof(['From: a@example.test', ...Array.from({ length: 512 }, (_, index) => `X-Field-${index}: value`)])).toBeNull();
  });
  it('preserves non-ASCII header bytes without Unicode or charset reinterpretation', () => {
    const changed = headers.map(line => line.startsWith('Subject:') ? 'Subject: caf\u00e9' : line);
    expect(proof(changed)).not.toEqual(proof(headers.map(line => line.startsWith('Subject:') ? 'Subject: cafe\u0301' : line)));
  });
});
