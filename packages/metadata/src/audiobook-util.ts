// Small pure helpers shared by the audiobook clients (Audnexus, Audible, OpenLibrary) and the
// catalog that combines them. Not part of the public API.

/** `{ key: value }` when value is present, else `{}`; keeps exactOptionalPropertyTypes happy. */
export function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/** Non-empty trimmed string or undefined. */
export function text(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function positiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Plain text from the small HTML fragments Audible uses for summaries. */
export function stripHtml(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const plain = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return text(plain);
}

/** `YYYY-MM-DD` from an ISO date/time, or undefined. */
export function isoDate(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match?.[1];
}

/** Series position as a number when it is one ("3" → 3, "1.5" → 1.5, "1-6" → undefined). */
export function positionNumber(position: string | undefined): number | undefined {
  if (position === undefined) return undefined;
  const trimmed = position.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

// ---------------------------------------------------------------------------
// Languages. Audible and Audnexus spell languages out in English ("english"); OpenLibrary uses
// MARC/ISO 639-2 codes ("eng"). The catalog normalises to the lower-case English name.

const LANGUAGE_CODES: Record<string, string> = {
  en: 'english',
  eng: 'english',
  de: 'german',
  ger: 'german',
  deu: 'german',
  fr: 'french',
  fre: 'french',
  fra: 'french',
  es: 'spanish',
  spa: 'spanish',
  it: 'italian',
  ita: 'italian',
  ja: 'japanese',
  jpn: 'japanese',
  pt: 'portuguese',
  por: 'portuguese',
  nl: 'dutch',
  dut: 'dutch',
  nld: 'dutch',
  sv: 'swedish',
  swe: 'swedish',
  da: 'danish',
  dan: 'danish',
  no: 'norwegian',
  nor: 'norwegian',
  fi: 'finnish',
  fin: 'finnish',
  pl: 'polish',
  pol: 'polish',
  ru: 'russian',
  rus: 'russian',
  zh: 'chinese',
  chi: 'chinese',
  zho: 'chinese',
  ko: 'korean',
  kor: 'korean',
  hi: 'hindi',
  hin: 'hindi',
  tr: 'turkish',
  tur: 'turkish',
};

/** "english" from "English", "eng", "en" or "/languages/eng". Unknown codes pass through. */
export function normalizeLanguage(value: string | null | undefined): string | undefined {
  const raw = text(value)?.toLowerCase().replace(/^\/languages\//, '');
  if (!raw) return undefined;
  return LANGUAGE_CODES[raw] ?? raw;
}

// ---------------------------------------------------------------------------
// ISBNs

/** Digits (and a trailing X) of a valid ISBN-10 or ISBN-13; undefined otherwise. */
export function normalizeIsbn(value: string | null | undefined): string | undefined {
  const raw = text(value)?.replace(/[\s-]/g, '').toUpperCase();
  if (!raw) return undefined;
  if (/^\d{13}$/.test(raw)) {
    const sum = [...raw].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? raw : undefined;
  }
  if (/^\d{9}[\dX]$/.test(raw)) {
    const sum = [...raw].reduce((acc, d, i) => acc + (d === 'X' ? 10 : Number(d)) * (10 - i), 0);
    return sum % 11 === 0 ? raw : undefined;
  }
  return undefined;
}

/** ISBN-13 form of a valid ISBN (ISBN-10s get the 978 prefix). */
export function toIsbn13(value: string | null | undefined): string | undefined {
  const isbn = normalizeIsbn(value);
  if (!isbn || isbn.length === 13) return isbn;
  const body = `978${isbn.slice(0, 9)}`;
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

// ---------------------------------------------------------------------------
// Matching keys for de-duplication

function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ');
}

/**
 * Title reduced for matching: diacritics, bracketed notes ("(Unabridged)", "[The Martian]"),
 * the subtitle after a colon, a leading article and punctuation are dropped.
 */
export function normalizeTitle(title: string): string {
  const base = fold(title)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s[:–—-]\s|:/)[0] ?? '';
  return base
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/^\s*(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Person name reduced for matching: "Weir, Andy", "Andy Weir" and "A. Weir" are different
 * spellings, so tokens are sorted and initials dropped ("Dennis E. Taylor" = "Dennis Taylor").
 */
export function normalizePersonName(name: string): string {
  return fold(name)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .sort()
    .join(' ');
}

export function uniqueStrings(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const t = text(value);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
