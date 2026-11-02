import { useQuery } from '@tanstack/react-query';
import type { WatchStatsSettings, WrappedShareCreate } from '@arclight/shared';
import { watchStatsApi, type StatsQuery, type WrappedParams } from '../api/watch-stats.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Stats and Year in review under ['watchstats']; the settings and the newsletter preview under
// ['settings'] so a settings event (and a save) refreshes them.
export const watchStatsKeys = {
  all: ['watchstats'] as const,
  stats: (query: StatsQuery) => ['watchstats', 'stats', query] as const,
  growth: (days: number) => ['watchstats', 'growth', days] as const,
  wrapped: (params: WrappedParams) => ['watchstats', 'wrapped', params] as const,
  shares: (userId: number | undefined) => ['watchstats', 'shares', userId ?? 'me'] as const,
  settings: ['settings', 'watchstats'] as const,
  newsletter: ['settings', 'watchstats', 'newsletter'] as const,
};

export function usePlaybackStats(query: StatsQuery) {
  return useQuery({ queryKey: watchStatsKeys.stats(query), queryFn: () => watchStatsApi.stats(query), retry: false });
}

export function useLibraryGrowth(days: number, enabled = true) {
  return useQuery({ queryKey: watchStatsKeys.growth(days), queryFn: () => watchStatsApi.growth(days), enabled, retry: false });
}

export function useWrapped(params: WrappedParams) {
  return useQuery({ queryKey: watchStatsKeys.wrapped(params), queryFn: () => watchStatsApi.wrapped(params), retry: false });
}

export function useWrappedShares(userId: number | undefined) {
  return useQuery({ queryKey: watchStatsKeys.shares(userId), queryFn: () => watchStatsApi.shares(userId), retry: false });
}

/** Errors render inline next to the share list. */
export function useCreateWrappedShare() {
  return useInvalidatingMutation((body: WrappedShareCreate) => watchStatsApi.createShare(body), [['watchstats', 'shares']], { silent: true });
}

export function useRevokeWrappedShare() {
  return useInvalidatingMutation((id: number) => watchStatsApi.revokeShare(id), [['watchstats', 'shares']], { errorTitle: t('watchStats.wrapped.couldNotRevoke') });
}

export function useWatchStatsSettings(enabled = true) {
  return useQuery({ queryKey: watchStatsKeys.settings, queryFn: watchStatsApi.settings, enabled, retry: false });
}

export function useSaveWatchStatsSettings() {
  return useInvalidatingMutation((body: WatchStatsSettings) => watchStatsApi.saveSettings(body), [watchStatsKeys.settings]);
}

export function useNewsletter() {
  return useQuery({ queryKey: watchStatsKeys.newsletter, queryFn: watchStatsApi.newsletter, retry: false });
}

/** The caller toasts the outcome (a failed send answers 502 with the SMTP error). */
export function useSendNewsletter() {
  return useInvalidatingMutation(() => watchStatsApi.sendNewsletter(), [watchStatsKeys.newsletter], { silent: true });
}
