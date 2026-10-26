import { ActivityStats, IndexerStats, LibraryStats, StorageStats } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror docs/API.md "stats" (contract: packages/shared/src/stats.ts).

export const statsApi = {
  storage: (top = 10) => request('/stats/storage', StorageStats, { query: { top } }),
  library: () => request('/stats/library', LibraryStats),
  activity: (days = 30) => request('/stats/activity', ActivityStats, { query: { days } }),
  indexers: (days = 30) => request('/stats/indexers', IndexerStats, { query: { days } }),
};
