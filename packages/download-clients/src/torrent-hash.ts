/**
 * Derives the id a BitTorrent client will assign to a torrent before it is added, so a
 * grab can be tracked without listing the client afterwards.
 *
 * - v1 and hybrid torrents: lowercase hex SHA-1 of the bencoded `info` dictionary.
 * - v2-only torrents: SHA-256 of `info`, truncated to 20 bytes (what libtorrent-based
 *   clients use as the torrent id).
 */

const CHAR_E = 0x65;
const CHAR_I = 0x69;
const CHAR_L = 0x6c;
const CHAR_D = 0x64;
const CHAR_COLON = 0x3a;
const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;

export class TorrentParseError extends Error {
  override readonly name = 'TorrentParseError';
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(input: string): string {
  let bitCount = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const ch of input.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) throw new TorrentParseError(`Invalid base32 character "${ch}"`);
    buffer = ((buffer << 5) | index) & 0xffff;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >>> bitCount) & 0xff);
    }
  }
  return toHex(Uint8Array.from(bytes));
}

/**
 * Returns the lowercase hex torrent id from a magnet URI, or undefined when the magnet
 * carries no BitTorrent topic.
 */
export function hashFromMagnet(magnet: string): string | undefined {
  const queryStart = magnet.indexOf('?');
  if (!magnet.toLowerCase().startsWith('magnet:') || queryStart < 0) return undefined;
  const params = new URLSearchParams(magnet.slice(queryStart + 1));
  let truncatedV2: string | undefined;
  const topics: Array<[string, string]> = [];
  params.forEach((value, key) => topics.push([key, value]));
  for (const [key, raw] of topics) {
    if (key !== 'xt' && !/^xt\.\d+$/.test(key)) continue;
    const topic = raw.trim();
    const lower = topic.toLowerCase();
    if (lower.startsWith('urn:btih:')) {
      const hash = topic.slice('urn:btih:'.length);
      if (/^[0-9a-fA-F]{40}$/.test(hash)) return hash.toLowerCase();
      if (/^[A-Za-z2-7]{32}$/.test(hash)) return base32ToHex(hash);
      throw new TorrentParseError(`Unrecognised btih hash "${hash}"`);
    }
    if (lower.startsWith('urn:btmh:')) {
      // Multihash prefix 0x12 0x20 = sha2-256, 32-byte digest.
      const multihash = lower.slice('urn:btmh:'.length);
      if (/^1220[0-9a-f]{64}$/.test(multihash)) truncatedV2 = multihash.slice(4, 44);
    }
  }
  return truncatedV2;
}

function readStringHeader(data: Uint8Array, pos: number): { start: number; length: number } {
  const colon = data.indexOf(CHAR_COLON, pos);
  if (colon <= pos) throw new TorrentParseError('Invalid string length');
  let length = 0;
  for (let i = pos; i < colon; i++) {
    const digit = data[i];
    if (digit === undefined || digit < CHAR_ZERO || digit > CHAR_NINE) {
      throw new TorrentParseError('Invalid string length');
    }
    length = length * 10 + (digit - CHAR_ZERO);
  }
  return { start: colon + 1, length };
}

/** Index just past the bencoded value that starts at `pos`. */
function skipValue(data: Uint8Array, pos: number): number {
  const lead = data[pos];
  if (lead === undefined) throw new TorrentParseError('Unexpected end of torrent data');
  if (lead === CHAR_I) {
    const end = data.indexOf(CHAR_E, pos + 1);
    if (end < 0) throw new TorrentParseError('Unterminated integer');
    return end + 1;
  }
  if (lead === CHAR_L || lead === CHAR_D) {
    let cursor = pos + 1;
    while (data[cursor] !== CHAR_E) {
      if (cursor >= data.length) throw new TorrentParseError('Unterminated list or dictionary');
      cursor = skipValue(data, cursor);
    }
    return cursor + 1;
  }
  if (lead >= CHAR_ZERO && lead <= CHAR_NINE) {
    const { start, length } = readStringHeader(data, pos);
    const end = start + length;
    if (end > data.length) throw new TorrentParseError('String runs past end of data');
    return end;
  }
  throw new TorrentParseError(`Unexpected byte 0x${lead.toString(16)} at offset ${pos}`);
}

interface DictEntry {
  key: string;
  valueStart: number;
  valueEnd: number;
}

function readDict(data: Uint8Array, pos: number): DictEntry[] {
  if (data[pos] !== CHAR_D) throw new TorrentParseError('Expected a dictionary');
  const entries: DictEntry[] = [];
  const decoder = new TextDecoder();
  let cursor = pos + 1;
  while (data[cursor] !== CHAR_E) {
    if (cursor >= data.length) throw new TorrentParseError('Unterminated dictionary');
    const { start, length } = readStringHeader(data, cursor);
    const valueStart = start + length;
    const key = decoder.decode(data.subarray(start, valueStart));
    const valueEnd = skipValue(data, valueStart);
    entries.push({ key, valueStart, valueEnd });
    cursor = valueEnd;
  }
  return entries;
}

function readInteger(data: Uint8Array, entry: DictEntry): number | undefined {
  if (data[entry.valueStart] !== CHAR_I) return undefined;
  const text = new TextDecoder().decode(data.subarray(entry.valueStart + 1, entry.valueEnd - 1));
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Computes the torrent id of a .torrent file. Throws `TorrentParseError` on bad input. */
export async function hashFromTorrentFile(file: Uint8Array): Promise<string> {
  const top = readDict(file, 0);
  const info = top.find((entry) => entry.key === 'info');
  if (!info) throw new TorrentParseError('Torrent has no info dictionary');
  const infoEntries = readDict(file, info.valueStart);
  const hasV1Pieces = infoEntries.some((entry) => entry.key === 'pieces');
  const metaVersionEntry = infoEntries.find((entry) => entry.key === 'meta version');
  const metaVersion = metaVersionEntry ? readInteger(file, metaVersionEntry) : undefined;
  // slice() copies into a fresh ArrayBuffer; digest() rejects SharedArrayBuffer-backed views.
  const infoBytes = file.slice(info.valueStart, info.valueEnd);

  if (metaVersion === 2 && !hasV1Pieces) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', infoBytes));
    return toHex(digest.subarray(0, 20));
  }
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', infoBytes)));
}
