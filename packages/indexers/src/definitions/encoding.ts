/**
 * Character-set helpers (spec S2.4): decode response bytes with the definition encoding and
 * percent-encode query/form values in it. Single-byte legacy encodings (windows-125x,
 * ISO-8859-x, KOI8...) are encoded through a reverse table built from `TextDecoder`;
 * multi-byte legacy encodings fall back to UTF-8 for *encoding* (decoding still works).
 */

const encoderTables = new Map<string, Map<number, number> | null>();

export function normalizeEncoding(label: string | undefined): string {
  const l = (label ?? 'utf-8').trim().toLowerCase();
  return l === 'utf8' ? 'utf-8' : l;
}

export function isSupportedEncoding(label: string): boolean {
  try {
    new TextDecoder(normalizeEncoding(label));
    return true;
  } catch {
    return false;
  }
}

export function decodeBytes(bytes: Uint8Array, encoding: string | undefined): string {
  const enc = normalizeEncoding(encoding);
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function singleByteTable(enc: string): Map<number, number> | null {
  if (encoderTables.has(enc)) return encoderTables.get(enc) ?? null;
  let table: Map<number, number> | null = null;
  try {
    const decoder = new TextDecoder(enc);
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const decoded = decoder.decode(all);
    // Single-byte iff every byte decoded to exactly one UTF-16 unit.
    if (decoded.length === 256) {
      table = new Map();
      for (let i = 0; i < 256; i++) {
        const code = decoded.charCodeAt(i);
        if (code !== 0xfffd && !table.has(code)) table.set(code, i);
      }
    }
  } catch {
    table = null;
  }
  encoderTables.set(enc, table);
  return table;
}

/** String to bytes in `encoding`; unmappable characters become `?`. */
export function encodeString(text: string, encoding: string | undefined): Uint8Array {
  const enc = normalizeEncoding(encoding);
  if (enc === 'utf-8') return new TextEncoder().encode(text);
  const table = singleByteTable(enc);
  if (!table) return new TextEncoder().encode(text);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = table.get(text.charCodeAt(i)) ?? 0x3f;
  return out;
}

const UNRESERVED = /[A-Za-z0-9\-_.~*]/;

/** Form-style percent-encoding (space -> `+`) in the given encoding. */
export function formEncode(text: string, encoding: string | undefined): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') out += '+';
    else if (UNRESERVED.test(ch)) out += ch;
    else for (const b of encodeString(ch, encoding)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Path-segment encoding: like `formEncode` but spaces become `%20` (S4.7). */
export function pathEncode(text: string, encoding: string | undefined): string {
  return formEncode(text, encoding).replace(/\+/g, '%20');
}

/** Percent-decode (`+` = space) in the given encoding; malformed escapes are kept. */
export function formDecode(text: string, encoding: string | undefined): string {
  const bytes: number[] = [];
  const s = text.replace(/\+/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
    }
  }
  const enc = normalizeEncoding(encoding);
  // ASCII/UTF-8 bytes of literal text are only meaningful for UTF-8; legacy pages rarely mix.
  return decodeBytes(Uint8Array.from(bytes), enc);
}

/** Serialise ordered key/value pairs as `k=v&k2=v2` (form encoding). */
export function serializePairs(pairs: ReadonlyArray<readonly [string, string]>, encoding: string | undefined, separator = '&'): string {
  return pairs.map(([k, v]) => `${formEncode(k, encoding)}=${formEncode(v, encoding)}`).join(separator);
}
