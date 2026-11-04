import { and, not, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

// SQL prefilters in front of the shared matcher (`rankMatches`), for searches that cannot read a
// whole table into JS. They only have to keep every row the matcher could accept, while reading
// few others, so they compare against the column lowercased with its spaces and punctuation
// squashed out: a normalized query word (letters and digits only) is then a substring of every
// title it can match exactly, by prefix, by substring or run together across words ("spiderman"
// in "Spider-Man", "greys" in "Grey's Anatomy"). SQLite's lower() folds ASCII only and titles
// keep their accents, so an unaccented word can still miss an accented title in SQL.

export type SearchColumn = SQLiteColumn | SQL;

/** Characters squashed out of a column (the matcher splits or drops all of them). */
const SQUASH = [' ', '-', '.', ':', "'", '’', '·', ',', '!', '?', '&', '/', '(', ')'];

/** lower(col) without SQUASH characters; never NULL, so NOT(...) of a filter stays boolean. */
export function squashed(col: SearchColumn): SQL {
  let expr: SQL = sql`lower(coalesce(${col}, ''))`;
  for (const ch of SQUASH) expr = sql`replace(${expr}, ${ch}, '')`;
  return expr;
}

const anyCol = (cols: readonly SearchColumn[], pattern: string) => or(...cols.map((c) => sql`${squashed(c)} LIKE ${pattern}`))!;

/** Pass 1: every query word is in one of the columns. */
export function allWordsFilter(words: readonly string[], cols: readonly SearchColumn[]): SQL {
  return and(...words.map((w) => anyCol(cols, `%${w}%`)))!;
}

/**
 * Pass 2 (null for a one-letter word): the longest word's characters in order (`%w%o%r%d%`), the
 * matcher's loose step, minus pass 1's rows. Rows matched only through other query words'
 * columns (keywords) come in here too.
 */
export function looseFilter(words: readonly string[], cols: readonly SearchColumn[]): SQL | null {
  const word = words.reduce((a, b) => (b.length > a.length ? b : a));
  if (word.length < 2) return null;
  return and(anyCol(cols, `%${[...word].join('%')}%`), not(allWordsFilter(words, cols)))!;
}

/** Up to `limit` rows: pass 1, then pass 2 while there is room. */
export function prefiltered<R>(words: readonly string[], cols: readonly SearchColumn[], limit: number, read: (where: SQL, limit: number) => R[]): R[] {
  const rows = read(allWordsFilter(words, cols), limit);
  const loose = rows.length < limit ? looseFilter(words, cols) : null;
  return loose ? rows.concat(read(loose, limit - rows.length)) : rows;
}
