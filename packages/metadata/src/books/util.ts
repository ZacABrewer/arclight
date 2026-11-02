// Small pure helpers shared by the book and comic clients, the merge functions and the catalog.
// Not part of the public API except where books/index.ts re-exports them.

import {
  normalizeLanguage,
  normalizePersonName,
  normalizeTitle,
  text,
  toIsbn13,
  uniqueStrings,
} from '../audiobook-util.js';
import type { BookRecord, BookSeriesRef, BookSourceName } from './types.js';

const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  japanese: 'ja',
  portuguese: 'pt',
  dutch: 'nl',
  swedish: 'sv',
  danish: 'da',
  norwegian: 'no',
  finnish: 'fi',
  polish: 'pl',
  russian: 'ru',
  chinese: 'zh',
  korean: 'ko',
  hindi: 'hi',
  turkish: 'tr',
};

/**
 * ISO 639-1 code from "en", "eng", "English" or "/languages/eng". Languages the table does not
 * know pass through lower-cased ("ara"), so a filter still compares like with like.
 */
export function bookLanguageCode(value: string | null | undefined): string | undefined {
  const name = normalizeLanguage(value);
  if (!name) return undefined;
  return LANGUAGE_NAME_TO_CODE[name] ?? name.split('-')[0];
}

/** Valid ISBN-13s (ISBN-10s converted) without duplicates. */
export function isbn13List(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const isbn = toIsbn13(value);
    if (isbn) out.add(isbn);
  }
  return [...out];
}

/** `YYYY-MM-DD`, `YYYY-MM` or `YYYY` prefix of a date string, or undefined. */
export function partialDate(value: string | number | null | undefined): string | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? String(value) : undefined;
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(raw);
  if (!match) return undefined;
  const [, year, month, day] = match;
  if (month === undefined || month === '00') return year;
  if (day === undefined || day === '00') return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

/** Same URL on https (Google Books and ComicVine still hand out http image links). */
export function httpsUrl(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  return raw.replace(/^http:\/\//i, 'https://');
}

/** A positive finite number from a number or numeric string. */
export function numberFrom(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** An id as a string (Hardcover and ComicVine use numbers, search indexes strings). */
export function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return text(value);
  return undefined;
}

const SERIES_PATTERNS: RegExp[] = [
  /^(.+?)\s*\(\s*(?:#|no\.?\s*|book\s+|vol\.?\s*|volume\s+)?(\d+(?:\.\d+)?(?:-\d+)?)\s*\)$/i,
  /^(.+?)[\s,;]*#\s*(\d+(?:\.\d+)?(?:-\d+)?)$/i,
  /^(.+?)[\s,;]+(?:book|vol\.?|volume|no\.?)\s*(\d+(?:\.\d+)?(?:-\d+)?)$/i,
];

/** "Mistborn #1", "Mistborn (1)", "Mistborn, Book 1" → `{ name: 'Mistborn', position: '1' }`. */
export function parseSeriesString(value: string): BookSeriesRef | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  for (const pattern of SERIES_PATTERNS) {
    const match = pattern.exec(raw);
    const name = text(match?.[1]?.replace(/[\s,;:]+$/, ''));
    if (match && name) return { name, position: match[2]! };
  }
  return { name: raw };
}

/** Normalized title for matching, with series suffixes ("…, Book 1", "… #1") dropped too. */
export function bookTitleKey(title: string): string {
  const withoutSeries = title
    .replace(/\s*#\s*\d+(?:\.\d+)?\s*$/, '')
    .replace(/[\s,;]+(?:book|vol\.?|volume)\s+\d+(?:\.\d+)?\s*$/i, '');
  return normalizeTitle(withoutSeries);
}

/** Title + first author key used for the last-resort de-duplication. */
export function bookMatchKey(record: Pick<BookRecord, 'title' | 'authors'>): string | undefined {
  const title = bookTitleKey(record.title);
  const author = record.authors[0] ? normalizePersonName(record.authors[0].name) : '';
  return title && author ? `${title}|${author}` : undefined;
}

/** Best key of a book record: `isbn:` first, then `ol:`, `hc:`, `gb:`. */
export function bookRecordKey(
  record: Pick<BookRecord, 'isbn13' | 'olWorkId' | 'hardcoverId' | 'googleVolumeId'>,
): string {
  if (record.isbn13) return `isbn:${record.isbn13}`;
  if (record.olWorkId) return `ol:${record.olWorkId}`;
  if (record.hardcoverId) return `hc:${record.hardcoverId}`;
  return `gb:${record.googleVolumeId ?? 'unknown'}`;
}

/** Every key a book record is known by. */
export function bookRecordKeys(
  record: Pick<BookRecord, 'isbn13' | 'isbns' | 'olWorkId' | 'hardcoverId' | 'googleVolumeId'>,
): string[] {
  return uniqueStrings([
    record.isbn13 ? `isbn:${record.isbn13}` : undefined,
    ...record.isbns.map((i) => `isbn:${i}`),
    record.olWorkId ? `ol:${record.olWorkId}` : undefined,
    record.hardcoverId ? `hc:${record.hardcoverId}` : undefined,
    record.googleVolumeId ? `gb:${record.googleVolumeId}` : undefined,
  ]);
}

/** Genres split on " / " (Google Books "Fiction / Fantasy / Epic") and de-duplicated. */
export function genreList(values: Iterable<string | null | undefined>): string[] {
  const parts: string[] = [];
  for (const value of values) {
    for (const part of (value ?? '').split(/\s+\/\s+/)) parts.push(part);
  }
  return uniqueStrings(parts.filter((p) => p.toLowerCase() !== 'general'));
}

export function sourceList(values: Iterable<BookSourceName>): BookSourceName[] {
  return [...new Set(values)];
}
