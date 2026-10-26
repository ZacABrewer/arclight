import { baseTag } from './languages.js';

// Encoding detection and UTF-8 normalisation (spec R6.7, providers 1.10). Uses the ICU
// decoders built into Node's TextDecoder; no external detector.

/** Legacy code pages to try per base language, in order. */
const LANGUAGE_ENCODINGS: Record<string, readonly string[]> = {
  zh: ['gb18030', 'big5'],
  ja: ['shift_jis', 'euc-jp'],
  ko: ['euc-kr'],
  th: ['windows-874'],
  ar: ['windows-1256'],
  fa: ['windows-1256'],
  ur: ['windows-1256'],
  he: ['windows-1255'],
  yi: ['windows-1255'],
  tr: ['windows-1254', 'iso-8859-9'],
  el: ['windows-1253', 'iso-8859-7'],
  vi: ['windows-1258'],
  lt: ['windows-1257'],
  lv: ['windows-1257'],
  et: ['windows-1257'],
  ru: ['windows-1251', 'koi8-r', 'iso-8859-5'],
  uk: ['windows-1251', 'koi8-u'],
  be: ['windows-1251'],
  bg: ['windows-1251'],
  mk: ['windows-1251'],
  // Serbian can be either script; Latin first.
  sr: ['windows-1250', 'windows-1251'],
  cs: ['windows-1250', 'iso-8859-2'],
  sk: ['windows-1250', 'iso-8859-2'],
  pl: ['windows-1250', 'iso-8859-2'],
  hu: ['windows-1250', 'iso-8859-2'],
  sl: ['windows-1250', 'iso-8859-2'],
  hr: ['windows-1250', 'iso-8859-2'],
  bs: ['windows-1250', 'iso-8859-2'],
  ro: ['windows-1250', 'iso-8859-16'],
  sq: ['windows-1250'],
};
const WESTERN = ['windows-1252', 'iso-8859-15'];
/** Candidates for the statistical step when nothing else decided. */
const STATISTICAL = ['windows-1252', 'windows-1250', 'windows-1251', 'windows-1253', 'windows-1254', 'windows-1256', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];

export interface DecodedText {
  text: string;
  /** WHATWG encoding label that decoded the bytes. */
  encoding: string;
  /** Which step decided. */
  method: 'bom' | 'declared' | 'utf-8' | 'language' | 'statistical' | 'fallback';
}

function tryDecode(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Decoded text that a human could have written: no C1 controls, NULs or replacement chars. */
function plausible(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000e-\u001f\u0080-\u009f�]/.test(text);
}

/** Share of characters that are letters, digits, whitespace or common punctuation, minus script mixing. */
function quality(text: string): number {
  if (!text) return 0;
  let good = 0;
  const scripts = new Set<string>();
  for (const ch of text) {
    if (/[\p{L}\p{N}\s.,!?'"\-:;()’“”…]/u.test(ch)) good++;
    if (/\p{Script=Latin}/u.test(ch) && /[^\x00-\x7f]/.test(ch)) scripts.add('latin-ext');
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add('cyrillic');
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add('greek');
    else if (/\p{Script=Arabic}/u.test(ch)) scripts.add('arabic');
    else if (/\p{Script=Han}/u.test(ch)) scripts.add('han');
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) scripts.add('kana');
    else if (/\p{Script=Hangul}/u.test(ch)) scripts.add('hangul');
  }
  // Han + kana is normal Japanese; otherwise each extra script is suspicious.
  let penalty = Math.max(0, scripts.size - 1);
  if (scripts.has('han') && scripts.has('kana') && scripts.size === 2) penalty = 0;
  return good / [...text].length - penalty * 0.05;
}

/**
 * Decode subtitle bytes: BOM, declared encoding, strict UTF-8, language code pages,
 * a statistical pick among common code pages, then windows-1252 as the last resort.
 */
export function decodeSubtitle(bytes: Uint8Array, opts: { declared?: string | undefined; language?: string | undefined } = {}): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', method: 'bom' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', method: 'bom' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', method: 'bom' };
  }
  if (opts.declared) {
    const t = tryDecode(bytes, opts.declared);
    if (t !== undefined && plausible(t)) return { text: t, encoding: normaliseLabel(opts.declared), method: 'declared' };
  }
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== undefined) return { text: utf8, encoding: 'utf-8', method: 'utf-8' };

  const lang = opts.language ? baseTag(opts.language) : undefined;
  const langList = lang ? LANGUAGE_ENCODINGS[lang] : undefined;
  for (const enc of langList ?? WESTERN) {
    const t = tryDecode(bytes, enc);
    if (t !== undefined && plausible(t)) return { text: t, encoding: enc, method: 'language' };
  }

  let best: { text: string; encoding: string; q: number } | undefined;
  for (const enc of STATISTICAL) {
    const t = tryDecode(bytes, enc);
    if (t === undefined || !plausible(t)) continue;
    const q = quality(t);
    if (!best || q > best.q) best = { text: t, encoding: enc, q };
  }
  if (best) return { text: best.text, encoding: best.encoding, method: 'statistical' };
  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', method: 'fallback' };
}

function normaliseLabel(label: string): string {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return label.toLowerCase();
  }
}

/** Decode, normalise line endings to LF and re-encode as UTF-8 (no BOM). */
export function toUtf8(bytes: Uint8Array, opts: { declared?: string | undefined; language?: string | undefined } = {}): { bytes: Uint8Array; text: string; sourceEncoding: string } {
  const decoded = decodeSubtitle(bytes, opts);
  const text = decoded.text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return { bytes: new TextEncoder().encode(text), text, sourceEncoding: decoded.encoding };
}
