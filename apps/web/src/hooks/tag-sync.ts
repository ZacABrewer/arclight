import { useQuery } from '@tanstack/react-query';
import { tagSyncApi } from '../api/tag-sync.js';
import { t } from '../i18n/index.js';
import { useInvalidatingMutation } from './settings-keys.js';

export const tagSyncKeys = {
  status: (id: string) => ['settings', 'mediaservers', id, 'tagsync'] as const,
};

/** The status line; polled while a run is going. */
export function useTagSyncStatus(id: string | null) {
  return useQuery({
    queryKey: tagSyncKeys.status(id ?? ''),
    queryFn: () => tagSyncApi.status(id ?? ''),
    enabled: id !== null,
    retry: false,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
}

export function useRunTagSync(id: string) {
  return useInvalidatingMutation(() => tagSyncApi.run(id), [tagSyncKeys.status(id)], { errorTitle: t('settings.mediaServers.tagSync.failed') });
}
