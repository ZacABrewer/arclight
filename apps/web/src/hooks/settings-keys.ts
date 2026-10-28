import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { t } from '../i18n/index.js';

// Query keys for the settings and activity pages. First segments line up with what live.ts
// invalidates: ['settings'] on a settings event, ['indexers'] on an indexer event, ['queue'] and
// ['history'] on queue/release/import/history events. The library pages' per-domain profile
// keys (libraryKeys.qualityProfiles, musicKeys.qualityProfiles) sit under the quality-profile
// key, so a profile save refreshes them too.
export const settingsKeys = {
  qualityProfiles: ['settings', 'qualityprofiles'] as const,
  customFormats: ['settings', 'customformats'] as const,
  customFormatSchema: ['settings', 'customformats', 'schema'] as const,
  delayProfiles: ['settings', 'delayprofiles'] as const,
  releaseProfiles: ['settings', 'releaseprofiles'] as const,
  qualityDefinitions: ['settings', 'qualitydefinitions'] as const,
  indexers: ['indexers', 'list'] as const,
  indexerSchema: ['indexers', 'schema'] as const,
  indexerCategories: ['indexers', 'categories'] as const,
  indexerDefinitions: (query: unknown) => ['indexers', 'definitions', query] as const,
  indexerDefinition: (id: string) => ['indexers', 'definition', id] as const,
  /** Under ['indexers', 'definitions'] so definition reloads and syncs refresh it. */
  indexerCatalogue: ['indexers', 'definitions', 'catalogue'] as const,
  indexerCatalogueEntry: (key: string) => ['indexers', 'definitions', 'entry', key] as const,
  communityCatalogue: ['indexers', 'definitions', 'community'] as const,
  indexerProxies: ['indexers', 'proxies'] as const,
  indexerStats: (days: number) => ['indexers', 'stats', days] as const,
  indexerOptions: ['settings', 'indexers'] as const,
  downloadClients: ['settings', 'downloadclients'] as const,
  downloadClientSchema: ['settings', 'downloadclients', 'schema'] as const,
  remotePathMappings: ['settings', 'remotepathmappings'] as const,
  metadata: ['settings', 'metadata'] as const,
  mediaManagement: ['settings', 'mediamanagement'] as const,
  naming: ['settings', 'naming'] as const,
  namingSamples: (draft: unknown) => ['settings', 'naming', 'samples', draft] as const,
  notifications: ['settings', 'notifications'] as const,
  notificationSchema: ['settings', 'notifications', 'schema'] as const,
};

export const activityKeys = {
  queue: (query: unknown) => ['queue', 'list', query] as const,
  queueStatus: ['queue', 'status'] as const,
  /** Under ['queue'] so queue invalidations (download / queue events) refresh it too. */
  queueTimeline: (id: number) => ['queue', 'timeline', id] as const,
  /** Library queue badges (GET /queue/summary). */
  queueSummary: ['queue', 'summary'] as const,
  history: (filter: unknown) => ['history', 'list', filter] as const,
  blocklist: (page: number, pageSize: number) => ['history', 'blocklist', page, pageSize] as const,
};

export interface MutationOptions {
  /** Title of the failure toast. */
  errorTitle?: string;
  /** The caller renders the error itself (e.g. inline in a dialog). */
  silent?: boolean;
}

/** A mutation that refetches `keys` once it settles. */
export function useInvalidatingMutation<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  keys: readonly QueryKey[],
  options: MutationOptions = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    meta: options.silent ? { silent: true } : { errorTitle: options.errorTitle ?? t('hooks.settingsKeys.couldNotSave') },
    onSettled: async () => {
      await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}
