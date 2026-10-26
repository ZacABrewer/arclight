import { AlertSettingsResponse, DailySummary, type AlertSettings, type DailySummaryGenerateRequest } from '@arclight/shared';
import { request } from './client.js';

// Alert delivery (quiet hours, daily summary) and the stored daily summaries. Paths mirror
// the api's GET/PUT /settings/alerts and /summary routes; shapes are packages/shared/src/alerts.ts.

export const alertsApi = {
  settings: {
    get: () => request('/settings/alerts', AlertSettingsResponse),
    update: (body: AlertSettings) => request('/settings/alerts', AlertSettingsResponse, { method: 'PUT', json: body }),
  },
  summary: {
    /** The newest stored summary, or null before the first one is built. */
    latest: () => request('/summary/latest', DailySummary.nullable()),
    /** Newest first. */
    list: (limit?: number) => request('/summary', DailySummary.array(), { query: { limit } }),
    /** Build one now; `notify` also sends it through the daily-summary trigger. */
    generate: (body: Partial<DailySummaryGenerateRequest> = {}) => request('/summary', DailySummary, { method: 'POST', json: body }),
  },
};
