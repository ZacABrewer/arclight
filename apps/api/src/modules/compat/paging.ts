import { z } from 'zod';
import type { Json } from './common.js';

// Upstream paging: `page, pageSize, sortKey, sortDirection` in; the same plus
// `totalRecords, records` out. sortDirection is `ascending` / `descending` / `default`.

export const SortDirection = z.enum(['ascending', 'descending', 'default']);
export type SortDirection = z.infer<typeof SortDirection>;

export const PagingQuery = z
  .object({
    page: z.coerce.number().int().min(1).catch(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(1000).catch(10).default(10),
    sortKey: z.string().optional(),
    sortDirection: z
      .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['ascending', 'descending', 'default', 'asc', 'desc']))
      .optional()
      .catch(undefined),
  })
  .passthrough();
export type PagingQuery = z.infer<typeof PagingQuery>;

/** Our `asc`/`desc`, given the default when the client sent none or `default`. */
export function sortOrder(q: Pick<PagingQuery, 'sortDirection'>, fallback: 'asc' | 'desc'): 'asc' | 'desc' {
  switch (q.sortDirection) {
    case 'ascending':
    case 'asc':
      return 'asc';
    case 'descending':
    case 'desc':
      return 'desc';
    default:
      return fallback;
  }
}

function wireDirection(q: Pick<PagingQuery, 'sortDirection'>, fallback: 'asc' | 'desc'): SortDirection {
  return sortOrder(q, fallback) === 'asc' ? 'ascending' : 'descending';
}

/** `{ page, pageSize, sortKey, sortDirection, totalRecords, records }`. */
export function envelope(
  q: PagingQuery,
  defaultSortKey: string,
  totalRecords: number,
  records: Json[],
  pageSize: number = q.pageSize,
  defaultDirection: 'asc' | 'desc' = 'desc',
): Json {
  return {
    page: q.page,
    pageSize,
    sortKey: q.sortKey ?? defaultSortKey,
    sortDirection: wireDirection(q, defaultDirection),
    totalRecords,
    records,
  };
}

/** Slice an in-memory list for a page. */
export function pageOf<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
