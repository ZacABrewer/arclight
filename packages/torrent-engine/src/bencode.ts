import { TorrentEngineError } from './errors.js';

/**
 * Bencode values. Byte strings decode to `Buffer`; dictionary keys decode to `latin1`
 * strings so every key byte round-trips. Integers decode to `number` when they fit in the
 * safe integer range and to `bigint` otherwise.
 */
export type BValue = number | bigint | Buffer | BValue[] | BDict;
export interface BDict {
  [key: string]: BValue;
}

/** Values accepted by `encode`: decoded values plus JS strings and plain objects. */
export type BEncodable =
  | number
  | bigint
  | boolean
  | string
  | Uint8Array
  | readonly BEncodable[]
  | { readonly [key: string]: BEncodable | undefined }
  | Map<string, BEncodable>;

export interface DecodeOptions {
  /** Reject dictionaries whose keys are not sorted (default false; duplicates always fail). */
  strictKeyOrder?: boolean;
  /** Maximum nesting depth (default 64). */
  maxDepth?: number;
}

function fail(message: string, pos: number): never {
  throw new TorrentEngineError('bencode', `${message} at offset ${pos}`);
}

const COLON = 0x3a;

class Decoder {
  pos: number;
  constructor(
    readonly buf: Buffer,
    start: number,
    readonly opts: Required<DecodeOptions>,
  ) {
    this.pos = start;
  }

  value(depth: number): BValue {
    if (depth > this.opts.maxDepth) fail('nesting too deep', this.pos);
    const c = this.buf[this.pos];
    if (c === undefined) fail('unexpected end of data', this.pos);
    if (c === 0x69 /* i */) return this.int();
    if (c === 0x6c /* l */) return this.list(depth);
    if (c === 0x64 /* d */) return this.dict(depth);
    if (c >= 0x30 && c <= 0x39) return this.bytes();
    return fail(`unexpected byte 0x${c.toString(16)}`, this.pos);
  }

  int(): number | bigint {
    const start = this.pos + 1;
    const end = this.buf.indexOf(0x65 /* e */, start);
    if (end < 0) fail('unterminated integer', this.pos);
    const text = this.buf.toString('latin1', start, end);
    if (!/^-?\d+$/.test(text)) fail(`invalid integer "${text}"`, this.pos);
    if (text === '-0') fail('negative zero', this.pos);
    if ((text.startsWith('0') && text.length > 1) || text.startsWith('-0'))
      fail('integer with leading zero', this.pos);
    this.pos = end + 1;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : BigInt(text);
  }

  bytes(): Buffer {
    const colon = this.buf.indexOf(COLON, this.pos);
    if (colon < 0) fail('unterminated string length', this.pos);
    const text = this.buf.toString('latin1', this.pos, colon);
    if (!/^\d+$/.test(text)) fail(`invalid string length "${text}"`, this.pos);
    if (text.length > 1 && text.startsWith('0')) fail('string length with leading zero', this.pos);
    const len = Number(text);
    const start = colon + 1;
    if (start + len > this.buf.length) fail('string exceeds data', this.pos);
    this.pos = start + len;
    return this.buf.subarray(start, start + len);
  }

  list(depth: number): BValue[] {
    this.pos++;
    const out: BValue[] = [];
    for (;;) {
      const c = this.buf[this.pos];
      if (c === undefined) fail('unterminated list', this.pos);
      if (c === 0x65) {
        this.pos++;
        return out;
      }
      out.push(this.value(depth + 1));
    }
  }

  dict(depth: number): BDict {
    this.pos++;
    const out = Object.create(null) as BDict;
    let prev: Buffer | null = null;
    for (;;) {
      const c = this.buf[this.pos];
      if (c === undefined) fail('unterminated dictionary', this.pos);
      if (c === 0x65) {
        this.pos++;
        return out;
      }
      if (c < 0x30 || c > 0x39) fail('dictionary key must be a string', this.pos);
      const keyPos = this.pos;
      const keyBuf = this.bytes();
      if (prev !== null) {
        const cmp = Buffer.compare(prev, keyBuf);
        if (cmp === 0) fail('duplicate dictionary key', keyPos);
        if (cmp > 0 && this.opts.strictKeyOrder) fail('dictionary keys not sorted', keyPos);
      }
      prev = keyBuf;
      const key = keyBuf.toString('latin1');
      if (Object.prototype.hasOwnProperty.call(out, key)) fail('duplicate dictionary key', keyPos);
      out[key] = this.value(depth + 1);
    }
  }
}

function resolveOpts(opts: DecodeOptions): Required<DecodeOptions> {
  return { strictKeyOrder: opts.strictKeyOrder ?? false, maxDepth: opts.maxDepth ?? 64 };
}

export function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Decodes exactly one value; trailing bytes are an error. */
export function decode(data: Uint8Array, opts: DecodeOptions = {}): BValue {
  const d = new Decoder(toBuffer(data), 0, resolveOpts(opts));
  const v = d.value(0);
  if (d.pos !== d.buf.length) fail('trailing data', d.pos);
  return v;
}

/** Decodes one value starting at `start` and reports where it ended (for framed payloads). */
export function decodePrefix(
  data: Uint8Array,
  start = 0,
  opts: DecodeOptions = {},
): { value: BValue; end: number } {
  const d = new Decoder(toBuffer(data), start, resolveOpts(opts));
  const value = d.value(0);
  return { value, end: d.pos };
}

/**
 * Returns the raw encoded bytes of each key of a top-level dictionary, so callers can hash
 * a sub-value (the torrent `info` dict) exactly as it appeared in the input.
 */
export function rawDictValues(data: Uint8Array): Map<string, Buffer> {
  const buf = toBuffer(data);
  if (buf[0] !== 0x64) fail('expected a dictionary', 0);
  const d = new Decoder(buf, 1, resolveOpts({}));
  const out = new Map<string, Buffer>();
  for (;;) {
    const c = buf[d.pos];
    if (c === undefined) fail('unterminated dictionary', d.pos);
    if (c === 0x65) break;
    const key = d.bytes().toString('latin1');
    const start = d.pos;
    d.value(1);
    out.set(key, buf.subarray(start, d.pos));
  }
  return out;
}

function lengthPrefix(n: number): Buffer {
  return Buffer.from(`${n}:`, 'latin1');
}

function encodeInto(value: BEncodable, out: Buffer[], depth: number): void {
  if (depth > 64) throw new TorrentEngineError('bencode', 'value nesting too deep to encode');
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TorrentEngineError('bencode', `cannot encode non-integer ${value}`);
    out.push(Buffer.from(`i${value}e`, 'latin1'));
  } else if (typeof value === 'bigint') {
    out.push(Buffer.from(`i${value.toString()}e`, 'latin1'));
  } else if (typeof value === 'boolean') {
    out.push(Buffer.from(value ? 'i1e' : 'i0e', 'latin1'));
  } else if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    out.push(lengthPrefix(b.length), b);
  } else if (value instanceof Uint8Array) {
    out.push(lengthPrefix(value.length), toBuffer(value));
  } else if (Array.isArray(value)) {
    out.push(Buffer.from('l'));
    for (const v of value as readonly BEncodable[]) encodeInto(v, out, depth + 1);
    out.push(Buffer.from('e'));
  } else if (value instanceof Map) {
    encodeDict([...value.entries()], out, depth);
  } else if (typeof value === 'object' && value !== null) {
    const entries: [string, BEncodable][] = [];
    for (const [k, v] of Object.entries(value)) if (v !== undefined) entries.push([k, v as BEncodable]);
    encodeDict(entries, out, depth);
  } else {
    throw new TorrentEngineError('bencode', `cannot encode value of type ${typeof value}`);
  }
}

function encodeDict(entries: [string, BEncodable][], out: Buffer[], depth: number): void {
  // Keys are latin1 strings (as produced by decode), so latin1 bytes give raw byte order.
  const keyed = entries.map(([k, v]) => [Buffer.from(k, 'latin1'), v] as const);
  keyed.sort((a, b) => Buffer.compare(a[0], b[0]));
  out.push(Buffer.from('d'));
  for (const [k, v] of keyed) {
    out.push(lengthPrefix(k.length), k);
    encodeInto(v, out, depth + 1);
  }
  out.push(Buffer.from('e'));
}

/** Encodes a value. Dictionary keys are sorted by raw bytes; `undefined` entries are skipped. */
export function encode(value: BEncodable): Buffer {
  const out: Buffer[] = [];
  encodeInto(value, out, 0);
  return Buffer.concat(out);
}

// ---- typed accessors used by the protocol layers -------------------------------------

export function isDict(v: BValue | undefined): v is BDict {
  return typeof v === 'object' && v !== null && !Buffer.isBuffer(v) && !Array.isArray(v);
}

export function getBytes(d: BDict, key: string): Buffer | undefined {
  const v = d[key];
  return Buffer.isBuffer(v) ? v : undefined;
}

export function getString(d: BDict, key: string): string | undefined {
  const v = d[key];
  return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
}

export function getInt(d: BDict, key: string): number | undefined {
  const v = d[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

export function getList(d: BDict, key: string): BValue[] | undefined {
  const v = d[key];
  return Array.isArray(v) ? v : undefined;
}

export function getDict(d: BDict, key: string): BDict | undefined {
  const v = d[key];
  return isDict(v) ? v : undefined;
}
