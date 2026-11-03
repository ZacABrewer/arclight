import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { listSearchLikePattern } from '@arclight/shared';

/**
 * `column LIKE '%value%'` with `%`, `_` and `\` in `value` matched literally (SQLite's LIKE is
 * case-insensitive for ASCII). For a single "contains" filter; list pages with word search use
 * `listSearchCondition` from list-search.ts.
 */
export function likeContains(column: SQLWrapper | SQL, value: string): SQL {
  return sql`${column} LIKE ${listSearchLikePattern(value)} ESCAPE '\\'`;
}
