import {
  MigrateDiscovery,
  MigrateReport,
  MigrateSourceCleanupResult,
  MigrateSourcesResponse,
  MigrateStackPreview,
  MigrateStackStatus,
  MigrateStatus,
  MigrateTestResult,
  MigrationPlan,
  type MigrateApplyRequest,
  type MigrateSourceCleanupRequest,
  type MigrateSourceInput,
  type MigrateStackApplyRequest,
  type MigrateStackRequest,
} from '@arclight/shared';
import { buildUrl, request } from './client.js';

/**
 * Adoption importer: analyse and import an existing *arr / Bazarr / Seerr / qBittorrent stack.
 * A source app that refuses the key or cannot be reached answers 502 (never 401/403), so it
 * never signs the admin out.
 */
export const migrateApi = {
  sources: () => request('/migrate/sources', MigrateSourcesResponse),
  discover: () => request('/migrate/discover', MigrateDiscovery),
  test: (source: MigrateSourceInput) => request('/migrate/test', MigrateTestResult, { method: 'POST', json: source }),
  plan: (source: MigrateSourceInput) => request('/migrate/plan', MigrationPlan, { method: 'POST', json: source }),
  apply: (body: MigrateApplyRequest) => request('/migrate/apply', MigrateStatus, { method: 'POST', json: body }),
  status: () => request('/migrate/status', MigrateStatus),
  stack: {
    preview: (body: MigrateStackRequest) => request('/migrate/stack/preview', MigrateStackPreview, { method: 'POST', json: body }),
    apply: (body: MigrateStackApplyRequest) => request('/migrate/stack/apply', MigrateStackStatus, { method: 'POST', json: body }),
    resume: () => request('/migrate/stack/resume', MigrateStackStatus, { method: 'POST' }),
    status: () => request('/migrate/stack/status', MigrateStackStatus),
    report: (runId?: number) => request('/migrate/stack/report', MigrateReport, { query: { runId } }),
    /** Link that downloads the report as a JSON file. */
    reportDownloadUrl: (runId?: number) => buildUrl('/migrate/stack/report', { runId, download: 1 }),
    cleanup: (body: MigrateSourceCleanupRequest) => request('/migrate/stack/source-cleanup', MigrateSourceCleanupResult, { method: 'POST', json: body }),
  },
};
