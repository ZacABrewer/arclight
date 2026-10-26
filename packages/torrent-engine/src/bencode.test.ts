import { describe, expect, it } from 'vitest';
import { decode, decodePrefix, encode, rawDictValues, type BDict } from './bencode.js';
import { TorrentEngineError } from './errors.js';

const b = (s: string) => Buffer.from(s, 'latin1');

describe('bencode decode', () => {
  it('decodes integers', () => {
    expect(decode(b('i42e'))).toBe(42);
    expect(decode(b('i-7e'))).toBe(-7);
    expect(decode(b('i0e'))).toBe(0);
  });

  it('decodes huge integers as bigint', () => {
    expect(decode(b('i123456789012345678901234567890e'))).toBe(123456789012345678901234567890n);
  });

  it('decodes byte strings as Buffers', () => {
    const v = decode(b('4:spam'));
    expect(Buffer.isBuffer(v)).toBe(true);
    expect((v as Buffer).toString()).toBe('spam');
    expect((decode(b('0:')) as Buffer).length).toBe(0);
  });

  it('keeps binary bytes intact', () => {
    const raw = Buffer.concat([b('3:'), Buffer.from([0, 255, 128])]);
    expect([...(decode(raw) as Buffer)]).toEqual([0, 255, 128]);
  });

  it('decodes lists and dicts', () => {
    const v = decode(b('d3:bar4:spam3:fooi42e4:listl1:ai1eee')) as BDict;
    expect((v.bar as Buffer).toString()).toBe('spam');
    expect(v.foo).toBe(42);
    expect(Array.isArray(v.list)).toBe(true);
  });

  it.each([
    ['i01e', 'leading zero'],
    ['i-0e', 'negative zero'],
    ['ie', 'invalid integer'],
    ['i12', 'unterminated integer'],
    ['5:abc', 'string exceeds data'],
    ['03:abc', 'leading zero'],
    ['l1:a', 'unterminated list'],
    ['d1:ai1e', 'unterminated dictionary'],
    ['di1ei2ee', 'key must be a string'],
    ['d1:ai1e1:ai2ee', 'duplicate'],
    ['i1ei2e', 'trailing data'],
    ['x', 'unexpected byte'],
    ['', 'unexpected end'],
  ])('rejects %j (%s)', (input, msg) => {
    expect(() => decode(b(input))).toThrowError(msg);
    try {
      decode(b(input));
    } catch (e) {
      expect(e).toBeInstanceOf(TorrentEngineError);
      expect((e as TorrentEngineError).code).toBe('bencode');
    }
  });

  it('rejects unsorted keys only in strict mode', () => {
    const data = b('d1:bi1e1:ai2ee');
    expect(() => decode(data)).not.toThrow();
    expect(() => decode(data, { strictKeyOrder: true })).toThrowError('not sorted');
  });

  it('limits nesting depth', () => {
    expect(() => decode(b('l'.repeat(100) + 'e'.repeat(100)))).toThrowError('too deep');
  });

  it('decodePrefix reports the end offset', () => {
    const data = b('d1:ai1eeTRAILER');
    const { value, end } = decodePrefix(data);
    expect((value as BDict).a).toBe(1);
    expect(data.subarray(end).toString()).toBe('TRAILER');
  });

  it('rawDictValues returns exact sub-value bytes', () => {
    const raw = rawDictValues(b('d4:infod1:xi1ee1:zi2ee'));
    expect(raw.get('info')?.toString()).toBe('d1:xi1ee');
    expect(raw.get('z')?.toString()).toBe('i2e');
  });

  it('does not let __proto__ keys pollute objects', () => {
    const v = decode(b('d9:__proto__i1ee')) as BDict;
    expect(v['__proto__']).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('bencode encode', () => {
  it('encodes all types and sorts keys', () => {
    expect(encode({ z: 1, a: 'x', m: [1, 'b'], buf: Buffer.from([1, 2]) }).toString('latin1')).toBe(
      'd1:a1:x3:buf2:\x01\x021:mli1e1:be1:zi1ee',
    );
  });

  it('skips undefined values and encodes booleans as ints', () => {
    expect(encode({ a: undefined, b: true }).toString()).toBe('d1:bi1ee');
  });

  it('encodes utf-8 strings by byte length', () => {
    expect(encode('é').toString('latin1')).toBe('2:\xc3\xa9');
  });

  it('rejects non-integers', () => {
    expect(() => encode(1.5)).toThrowError('non-integer');
  });

  it('round-trips decoded values byte-for-byte', () => {
    const input = b('d4:infod6:lengthi10e4:name3:abce4:listli-1ei99999999999999999999eee');
    expect(encode(decode(input) as BDict).equals(input)).toBe(true);
  });

  it('encodes Maps', () => {
    expect(encode(new Map([['b', 1], ['a', 2]])).toString()).toBe('d1:ai2e1:bi1ee');
  });
});
