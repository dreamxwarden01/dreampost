import { describe, expect, it } from 'vitest';
import { parseTypedRecipients, recipientDelimiterIsOutside } from './RecipientField';

describe('recipient entry delimiters', () => {
  it('keeps a comma inside a quoted display name in the unfinished input', () => {
    expect(recipientDelimiterIsOutside('"Surname')).toBe(false);
    expect(recipientDelimiterIsOutside('"Surname, Given" <person@example.test>')).toBe(true);
    expect(parseTypedRecipients('"Surname, Given" <person@example.test>')).toEqual([{ name: 'Surname, Given', address: 'person@example.test' }]);
  });
  it('does not commit an unfinished angle address or an escaped name quote', () => {
    expect(recipientDelimiterIsOutside('Person <person')).toBe(false);
    expect(recipientDelimiterIsOutside(String.raw`"A \"quoted`)).toBe(false);
    expect(recipientDelimiterIsOutside(String.raw`"A \"quoted\" name" <person@example.test>`)).toBe(true);
  });
  it('preserves display names and foreign local-part case when committing a typed list', () => {
    expect(parseTypedRecipients('"Surname, Given" <MixedCase@example.test>; other@example.test')).toEqual([
      { name: 'Surname, Given', address: 'MixedCase@example.test' },
      { name: '', address: 'other@example.test' },
    ]);
  });
});
