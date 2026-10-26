import { useQuery } from '@tanstack/react-query';
import type { TrackerAccountSettingsInput } from '@arclight/shared';
import { trackerStatsApi } from '../api/tracker-stats.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Under ['indexers', ...] so an indexer event from live.ts refreshes them too.
export const trackerKeys = {
  all: ['indexers', 'tracker'] as const,
  account: (indexerId: number) => ['indexers', 'tracker', 'account', indexerId] as const,
  stats: ['indexers', 'tracker', 'stats'] as const,
};

export function useTrackerAccount(indexerId: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: trackerKeys.account(indexerId),
    queryFn: () => trackerStatsApi.account(indexerId),
    retry: false,
    enabled: options.enabled ?? true,
  });
}

export function useSaveTrackerAccount(indexerId: number) {
  return useInvalidatingMutation((body: TrackerAccountSettingsInput) => trackerStatsApi.saveAccount(indexerId, body), [trackerKeys.all], {
    errorTitle: t('hooks.trackerStats.couldNotSaveTrackerAccount'),
  });
}

export function useTrackerStats() {
  return useQuery({ queryKey: trackerKeys.stats, queryFn: trackerStatsApi.list, retry: false, refetchInterval: 60_000 });
}

export function useSyncTrackerStats() {
  return useInvalidatingMutation(() => trackerStatsApi.sync(), [trackerKeys.stats], {
    errorTitle: t('hooks.trackerStats.couldNotSyncTrackerStats'),
  });
}
