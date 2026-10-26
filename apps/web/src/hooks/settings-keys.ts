import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { t } from '../i18n/index.js';

// Query keys for the settings and activity pages. First segments line up with what live.ts
// invalidates: ['settings'] on a settings event, ['indexers'] on an indexer event, ['queue'] and
// ['history'] on queue/release/import/history events. The quality-profile key is shared with
// the library pages (libraryKeys.qualityProfiles) so both read one cache entry.
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
