import { z } from 'zod';
import { AuditPage, AuditSettings, MetricsSettings } from '@arclight/shared';
import { buildUrl, request, type QueryParams } from './client.js';

// Paths mirror apps/api/src/modules/audit and metrics (docs/API.md "audit", "metrics").

export interface AuditFilter {
  user?: string | undefined;
  action?: string | undefined;
  /** ISO-8601, inclusive. */
  from?: string | undefined;
  /** ISO-8601, exclusive. */
  to?: string | undefined;
  /** Text search over user, action, target and details (every word must match). */
  q?: string | undefined;
}

/** Drop empty filters so the query string only carries what is set. */
export function auditQuery(filter: AuditFilter): QueryParams {
  const q: QueryParams = {};
  for (const k of ['user', 'action', 'from', 'to', 'q'] as const) {
    const v = filter[k]?.trim();
    if (v) q[k] = v;
  }
  return q;
}

export const auditApi = {
  list: (filter: AuditFilter, page: number, pageSize: number) => request('/audit', AuditPage, { query: { ...auditQuery(filter), page, pageSize } }),
  actions: () => request('/audit/actions', z.array(z.string())),
  /** CSV download link with the same filters. */
  exportUrl: (filter: AuditFilter) => buildUrl('/audit/export', auditQuery(filter)),
  settings: {
    get: () => request('/settings/audit', AuditSettings),
    update: (body: AuditSettings) => request('/settings/audit', AuditSettings, { method: 'PUT', json: body }),
  },
};

export const metricsApi = {
  settings: {
    get: () => request('/settings/metrics', MetricsSettings),
    update: (body: MetricsSettings) => request('/settings/metrics', MetricsSettings, { method: 'PUT', json: body }),
  },
};
