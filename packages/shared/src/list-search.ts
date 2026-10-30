import { z } from 'zod';

// The text search of list pages (Activity, Wanted, Requests, System, Settings lists). One
// forgiving rule on both sides: the browser filters loaded lists with `matchesListSearch`, and
// the api turns the same words into SQL LIKE conditions for server-paged lists.
//
//   - case-insensitive;
//   - dots, dashes and underscores count as spaces, so "the office" finds The.Office.S01 and
//     "web dl" finds WEB-DL;
//   - every typed word has to appear (in any of the row's fields, in any order).

/** Longest `q` the api accepts. */
export const LIST_SEARCH_MAX = 200;

/** `q` query parameter of the list endpoints. Blank means no search. */
export const ListSearchParam = z.string().trim().max(LIST_SEARCH_MAX).optional();

const SEPARATORS = /[\s._-]+/u;

/** The words of a search, lower case, separators dropped. Empty for a blank search. */
export function listSearchTokens(query: string | null | undefined): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(SEPARATORS)
    .filter((w) => w.length > 0);
}

/** A field value as searchable text: lower case, separators turned into spaces. */
export function listSearchText(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  return String(value).toLowerCase().replace(/[._-]+/g, ' ');
}

export type ListSearchField = string | number | boolean | null | undefined | readonly (string | number | null | undefined)[];

/**
 * True when every word of `query` appears in at least one of `fields`. A blank query matches
 * everything. `query` may be the raw text or the words from `listSearchTokens`.
 */
export function matchesListSearch(query: string | readonly string[] | null | undefined, fields: readonly ListSearchField[]): boolean {
  const words = typeof query === 'string' || query === null || query === undefined ? listSearchTokens(query) : query;
  if (words.length === 0) return true;
  const haystack = fields
    .flatMap((f) => (Array.isArray(f) ? f : [f]))
    .map(listSearchText)
    .filter((s) => s.length > 0)
    .join('\n');
  if (!haystack) return false;
  return words.every((w) => haystack.includes(w));
}

/** The rows matching `query`; the same array when the query is blank. */
export function filterListSearch<T>(rows: readonly T[], query: string | null | undefined, fields: (row: T) => readonly ListSearchField[]): readonly T[] {
  const words = listSearchTokens(query);
  if (words.length === 0) return rows;
  return rows.filter((r) => matchesListSearch(words, fields(r)));
}

/** A LIKE pattern for one word: `%word%` with `\`, `%` and `_` escaped (use with ESCAPE '\'). */
export function listSearchLikePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
