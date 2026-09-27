import { describe, expect, it } from 'vitest';
import { parseMimeIsolated, READER_PARSER_VERSION } from '../src/reader-data.js';

const raw = (headers: string[], body: string) => Buffer.from([...headers, '', body].join('\r\n'));
describe('reply and conversation MIME metadata', () => {
  it('keeps parsed visible recipients, case-sensitive references and no Bcc recipient list', async () => {
    const parsed = await parseMimeIsolated(raw([
      'From: Alice <Alice@example.test>', 'Reply-To: Team <team@example.test>',
      'To: "Doe, Jane" <jane@example.test>, Group: one@example.test, two@example.test;',
      'Cc: colleague@example.test', 'Bcc: hidden@example.test', 'Message-ID: <CaseSensitive@example.test>',
      'In-Reply-To: <Parent@example.test>', 'References: <Root@example.test> <Parent@example.test>',
      'Subject: Reply metadata', 'Content-Type: text/plain; charset=utf-8',
    ], 'Visible body'));
    expect(parsed.reader.parserVersion).toBe(READER_PARSER_VERSION);
    expect(parsed.reader.headers.addresses?.to.map(value => value.address)).toEqual(['jane@example.test', 'one@example.test', 'two@example.test']);
    expect(parsed.reader.headers.addresses?.replyTo[0]?.address).toBe('team@example.test');
    expect(parsed.reader.headers.references).toEqual(['<Root@example.test>', '<Parent@example.test>']);
    expect(parsed.reader.headers.inReplyTo).toEqual(['<Parent@example.test>']);
    expect(JSON.stringify(parsed.reader.headers.addresses)).not.toContain('hidden@example.test');
  });
  it('derives searchable and quotable text from HTML-only mail without active or head content', async () => {
    const parsed = await parseMimeIsolated(raw([
      'From: sender@example.test', 'To: recipient@example.test', 'Subject: HTML only',
      'Content-Type: text/html; charset=utf-8',
    ], '<html><head><style>private-style</style><title>not-body</title></head><body><p>Hello &amp; welcome</p><script>private-script()</script><p>\u6d4b\u8bd5 text</p></body></html>'));
    expect(parsed.text).toContain('Hello & welcome');
    expect(parsed.text).toContain('\u6d4b\u8bd5 text');
    expect(parsed.text).not.toMatch(/private-style|private-script|not-body/);
    expect(parsed.reader.htmlSource).toContain('private-script');
  });
  it('does not choose an ambiguous From, Reply-To or Message-ID as structured reply authority', async () => {
    const parsed = await parseMimeIsolated(raw([
      'From: first@example.test', 'From: second@example.test', 'Reply-To: one@example.test', 'Reply-To: two@example.test',
      'To: recipient@example.test', 'Message-ID: <one@example.test>', 'Message-ID: <two@example.test>',
    ], 'Body'));
    expect(parsed.reader.headers.addresses?.from).toEqual([]);
    expect(parsed.reader.headers.addresses?.replyTo).toEqual([]);
    expect(parsed.reader.headers.messageId).toBe('');
    expect(parsed.reader.warnings).toContain('multiple_reply_to_headers');
  });
});
