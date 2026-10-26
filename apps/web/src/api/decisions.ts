import { DecisionLogBatch, DecisionLogPage } from '@arclight/shared';
import { request } from './client.js';

// Decision log: paths mirror apps/api/src/modules/releases/routes.ts (docs/API.md "releases (decision log)").

/** Exactly one item the log is listed for (DecisionLogQuery). */
export type DecisionScope = { seriesId: number } | { episodeId: number } | { movieId: number };

export interface DecisionPageQuery {
  page: number;
  pageSize: number;
}

/** Query string for GET /release/decisions. */
export function decisionsQuery(scope: DecisionScope, paging: DecisionPageQuery): Record<string, number> {
  return { ...scope, page: paging.page, pageSize: paging.pageSize };
}

export const decisionsApi = {
  list: (scope: DecisionScope, paging: DecisionPageQuery) => request('/release/decisions', DecisionLogPage, { query: decisionsQuery(scope, paging) }),
  batch: (batchId: string) => request(`/release/decisions/${encodeURIComponent(batchId)}`, DecisionLogBatch),
};
