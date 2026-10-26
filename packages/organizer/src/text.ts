// Text transforms used by the token catalogue and the assembly clean-up passes.

import type { ColonReplacement } from '@arclight/shared';

/** Protected stand-in for a truncation ellipsis (spec 2.5.3); becomes `...` at the very end. */
export const ELLIPSIS = '';
/** Protected stand-in for the `--` "and others" language marker so separator collapsing keeps it. */
export const DOUBLE_DASH = '';

export function restorePlaceholders(text: string): string {
  return text.replaceAll(ELLIPSIS, '...').replaceAll(DOUBLE_DASH, '--');
}

const encoder = new TextEncoder();

/** UTF-8 byte length, counting placeholders as the text they will become. */
export function byteLength(text: string): number {
  return encoder.encode(restorePlaceholders(text)).length;
}

// ---------------------------------------------------------------------------------------
// Illegal characters and colons (spec section 3)
// ---------------------------------------------------------------------------------------

export interface CleanOptions {
  replaceIllegalCharacters: boolean;
  colonReplacement: ColonReplacement;
  customColonReplacement?: string | undefined;
}

const COLON_TEXT: Record<Exclude<ColonReplacement, 'smart' | 'custom'>, string> = {
  delete: '',
  dash: '-',
  spaceDash: ' -',
  spaceDashSpace: ' - ',
};

const ILLEGAL_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['\\', '+'],
  ['/', '+'],
  ['<', ''],
  ['>', ''],
  ['?', '!'],
  ['*', '-'],
  ['|', ''],
  ['"', ''],
];

export function cleanIllegal(value: string, options: CleanOptions): string {
  let s = value;
  if (!options.replaceIllegalCharacters) {
    s = s.replaceAll(':', '');
    for (const [ch] of ILLEGAL_REPLACEMENTS) s = s.replaceAll(ch, '');
  } else {
    switch (options.colonReplacement) {
      case 'smart':
        s = s.replaceAll(': ', ' - ').replaceAll(':', '-');
        break;
      case 'custom':
        s = s.replaceAll(':', options.customColonReplacement ?? '');
        break;
      default:
        s = s.replaceAll(':', COLON_TEXT[options.colonReplacement]);
    }
    for (const [ch, rep] of ILLEGAL_REPLACEMENTS) s = s.replaceAll(ch, rep);
  }
  return s.replace(/^[ .]+/, '').replace(/ +$/, '');
}

// ---------------------------------------------------------------------------------------
// Titles (spec 5.1, 5.2)
// ---------------------------------------------------------------------------------------

export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}

/** The "clean title" transform (spec 5.2). */
export function cleanTitle(input: string): string {
  let s = input.replaceAll('&', 'and').replaceAll('/', ' ');
  // punctuation standing alone between whitespace
  s = s.replace(/(?<=\s)[,<>\\;:'"|`~!?@$%^*\-_=](?=\s)/g, '');
  // apostrophe-like marks before whitespace, end of text, or a contraction ending
  s = s.replace(/['`:?,](?=(?:s|m|t|ve|ll|d|re)?(?:\s|$))/gi, '');
  s = s.replace(/[()[\]{}]/g, '');
  s = stripDiacritics(s);
  return s.replace(/\s+/g, ' ').trim();
}

const TRAILING_YEAR = /\s*\((\d{4})\)$/;

export function trailingYear(title: string): string | undefined {
  return TRAILING_YEAR.exec(title.trim())?.[1];
}

export function titleWithoutYear(title: string): string {
  return title.trim().replace(TRAILING_YEAR, '');
}

/** Title plus ` (Year)`, unless it already ends in a parenthesised year or year is 0. */
export function titleYear(title: string, year: number): string {
  if (trailingYear(title) !== undefined || !year) return title;
  return `${title} (${year})`;
}

/** Moves a leading The/An/A to the end after a comma, keeping a trailing `(...)` qualifier last. */
export function titleThe(title: string): string {
  const m = /^(the|an|a)\s+(.+?)(\s+\([^()]*\))?$/i.exec(title.trim());
  if (!m) return title;
  return `${m[2]}, ${m[1]}${m[3] ?? ''}`;
}

/** First letter/digit (of the first two characters), upper-case, diacritics removed; else `_`. */
export function firstCharacter(text: string): string {
  const chars = Array.from(stripDiacritics(text));
  for (const ch of chars.slice(0, 2)) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return '_';
}

/** Length modifier for text tokens (spec 2.5.1). */
export function truncateText(text: string, modifier: string | undefined): string {
  if (!text.trim()) return '';
  if (modifier === undefined || !/^-?\d+$/.test(modifier)) return text;
  const n = Number.parseInt(modifier, 10);
  const chars = Array.from(text);
  const max = Math.abs(n);
  if (n === 0 || chars.length <= max) return text;
  const keep = Math.max(0, max - 3);
  if (n > 0) return chars.slice(0, keep).join('').replace(/[ .]+$/, '') + ELLIPSIS;
  return ELLIPSIS + (keep ? chars.slice(-keep).join('') : '').replace(/^[ .]+/, '');
}

/** Cuts to at most `maxBytes` UTF-8 bytes including a trailing ellipsis. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  if (maxBytes < 4) return '';
  let out = '';
  let used = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (used + b > maxBytes - 3) break;
    out += ch;
    used += b;
  }
  return out.replace(/[ .]+$/, '') + ELLIPSIS;
}

/** Edition normalisation (spec 6.3.1). */
export function formatEdition(edition: string): string {
  let s = edition.trim().toLowerCase();
  s = s.replace(/(^|[\s(\-])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  s = s.replace(/\b(\d+)(st|nd|rd|th|mm)\b/gi, (_m, num: string, suf: string) => num + suf.toLowerCase());
  s = s.replace(/\b(imax|3d|sdr|hdr|dv)\b/gi, (w) => w.toUpperCase());
  return s;
}

// ---------------------------------------------------------------------------------------
// Component clean-up (spec 4.9, 4.10, 2.7)
// ---------------------------------------------------------------------------------------

export function collapseSeparators(text: string): string {
  return text.replace(/([ ._-])\1+/g, '$1');
}

const RESERVED = /^(aux|com[1-9]|con|lpt[1-9]|nul|prn)(\.|$)/i;

/**
 * Reserved device names: a component starting with one followed by a dot gets the dot replaced
 * by `_` (spec 2.7). Arclight extension: a component that *is* a reserved name gets `_` appended.
 */
export function fixReservedName(component: string): string {
  const m = RESERVED.exec(component);
  if (!m) return component;
  if (m[2] === '.') return `${m[1]}_${component.slice(m[0].length)}`;
  return `${component}_`;
}

/** File-name component clean-up before placeholders are restored. */
export function cleanupFileComponent(text: string): string {
  return collapseSeparators(text.trim()).replace(/[ ._-]+$/, '');
}

export function cleanupFolderComponent(text: string, season = false): string {
  const collapsed = collapseSeparators(text);
  return season ? collapsed.replace(/^[ ._-]+|[ ._-]+$/g, '') : collapsed.replace(/^[ .]+|[ .]+$/g, '');
}

export function finalizeComponent(text: string): string {
  return fixReservedName(restorePlaceholders(text));
}

export function splitPath(format: string): string[] {
  return format.split(/[\\/]/).filter((s) => s.length > 0);
}
