import { and, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { listSearchLikePattern, listSearchTokens } from '@arclight/shared';

/**
 * The SQL side of the list-page search (`q`, see packages/shared list-search.ts): every word
 * has to appear, case-insensitively, in at least one of `columns`. Words are split on spaces,
 * dots, dashes and underscores; LIKE wildcards in them are escaped. Undefined for a blank
 * search, so callers can push the result straight into their conditions.
 *
 * `columns` are column references or SQL expressions (a json_extract, a correlated subquery
 * for a joined title). NULL values simply do not match.
 */
export function listSearchCondition(query: string | null | undefined, columns: readonly (SQLWrapper | SQL)[]): SQL | undefined {
  const words = listSearchTokens(query);
  if (words.length === 0 || columns.length === 0) return undefined;
  const perWord = words.map((word) => {
    const pattern = listSearchLikePattern(word);
    return or(...columns.map((c) => sql`lower(${c}) LIKE ${pattern} ESCAPE '\\'`)) as SQL;
  });
  return and(...perWord) as SQL;
}
