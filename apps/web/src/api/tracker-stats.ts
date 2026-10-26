import { TrackerAccountSettings, TrackerStatsResource, TrackerStatsSyncResult, type TrackerAccountSettingsInput } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/tracker-stats/routes.ts (private-tracker helpers).

export const trackerStatsApi = {
  /** Tracker account settings of a torrent indexer (defaults when never saved). */
  account: (indexerId: number) => request(`/indexer/${indexerId}/tracker`, TrackerAccountSettings),
  saveAccount: (indexerId: number, body: TrackerAccountSettingsInput) =>
    request(`/indexer/${indexerId}/tracker`, TrackerAccountSettings, { method: 'PUT', json: body }),
  list: () => request('/tracker/stats', TrackerStatsResource.array()),
  sync: () => request('/tracker/stats/sync', TrackerStatsSyncResult, { method: 'POST' }),
};
