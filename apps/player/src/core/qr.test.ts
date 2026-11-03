import { describe, expect, it } from 'vitest';
import { normalisePairCode, PAIR_CODE_PATTERN, parsePairingLink } from './qr';

describe('pair codes', () => {
  it('normalises what people type', () => {
    expect(normalisePairCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalisePairCode('ab cd ef gh')).toBe('ABCDEFGH');
  });

  it('accepts only the look-alike-free alphabet', () => {
    expect(PAIR_CODE_PATTERN.test('ABCDEFGH')).toBe(true);
    expect(PAIR_CODE_PATTERN.test('ABCDEFG0')).toBe(false);
    expect(PAIR_CODE_PATTERN.test('ABCDEFGI')).toBe(false);
    expect(PAIR_CODE_PATTERN.test('ABCDEFG')).toBe(false);
  });
});

describe('parsePairingLink', () => {
  it('reads the QR code the web player shows', () => {
    const link = `arclight://pair?server=${encodeURIComponent('https://music.example.com/arclight/')}&code=abcd-efgh`;
    expect(parsePairingLink(link)).toEqual({ server: 'https://music.example.com/arclight', code: 'ABCDEFGH' });
  });

  it('keeps the server when the code is not valid', () => {
    expect(parsePairingLink('arclight://pair?server=http%3A%2F%2F192.168.1.20%3A7878&code=nope')).toEqual({ server: 'http://192.168.1.20:7878', code: null });
  });

  it('takes a plain server address', () => {
    expect(parsePairingLink('https://music.example.com')).toEqual({ server: 'https://music.example.com', code: null });
  });

  it('rejects other links and addresses with credentials', () => {
    expect(parsePairingLink('https://user:pw@music.example.com')).toBeNull();
    expect(parsePairingLink('otherapp://pair?server=x')).toBeNull();
    expect(parsePairingLink('arclight://pair?code=ABCDEFGH')).toBeNull();
    expect(parsePairingLink('hello')).toBeNull();
  });
});
