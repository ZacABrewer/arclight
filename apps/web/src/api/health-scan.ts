import {
  HealthActionResult,
  HealthListResponse,
  HealthScanSettings,
  Job,
  type HealthAction,
  type HealthListQueryInput,
  type HealthScanRequestInput,
  type HealthScanSettingsInput,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/health-scan/routes.ts (docs/API.md § Library health scan).

type ListQuery = Omit<HealthListQueryInput, 'ids'>;

export const healthScanApi = {
  list: (query: ListQuery = {}) => request('/library/health', HealthListResponse, { query: query as Record<string, string | number | undefined> }),
  /** Starts a HealthScan (whole library) or HealthCheck (items / files) job (202). */
  scan: (body: HealthScanRequestInput) => request('/library/health/scan', Job, { method: 'POST', json: body }),
  act: (action: HealthAction, ids: readonly number[]) => request('/library/health/action', HealthActionResult, { method: 'POST', json: { action, ids } }),
  settings: () => request('/settings/healthscan', HealthScanSettings),
  saveSettings: (body: HealthScanSettingsInput) => request('/settings/healthscan', HealthScanSettings, { method: 'PUT', json: body }),
};
