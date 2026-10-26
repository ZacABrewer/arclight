import {
  MigrateStatus,
  MigrateSourcesResponse,
  MigrationPlan,
  type MigrateApplyRequest,
  type MigrateSourceInput,
} from '@media-tron/shared';
import { request } from './client.js';

/** Adoption importer: analyse and import an existing *arr / Bazarr / Seerr installation. */
export const migrateApi = {
  sources: () => request('/migrate/sources', MigrateSourcesResponse),
  plan: (source: MigrateSourceInput) => request('/migrate/plan', MigrationPlan, { method: 'POST', json: source }),
  apply: (body: MigrateApplyRequest) => request('/migrate/apply', MigrateStatus, { method: 'POST', json: body }),
  status: () => request('/migrate/status', MigrateStatus),
};
