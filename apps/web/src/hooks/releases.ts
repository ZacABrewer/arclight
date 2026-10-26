import { useQuery } from '@tanstack/react-query';
import type { PendingRelease } from '@arclight/shared';
import { releasesApi } from '../api/releases.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Pending (delayed) releases. The first key segment is 'queue' so live.ts's queue/release
// invalidations refresh this list too.
export const releaseKeys = {
  pending: ['queue', 'pending-releases'] as const,
};

export function usePendingReleases() {
  return useQuery({ queryKey: releaseKeys.pending, queryFn: releasesApi.pending, refetchInterval: 30_000 });
}

export function useGrabPending() {
  return useInvalidatingMutation(
    (p: PendingRelease) =>
      releasesApi.grab({
        guid: p.guid,
        indexerId: p.indexerId,
        ...(p.seriesId !== undefined ? { seriesId: p.seriesId } : {}),
        ...(p.episodeIds?.length ? { episodeIds: p.episodeIds } : {}),
        ...(p.movieId !== undefined ? { movieId: p.movieId } : {}),
      }),
    [releaseKeys.pending, ['queue']],
    { errorTitle: t('hooks.releases.couldNotGrabRelease') },
  );
}

export function useRemovePending() {
  return useInvalidatingMutation((id: number) => releasesApi.removePending(id), [releaseKeys.pending], {
    errorTitle: t('hooks.releases.couldNotRemovePendingRelease'),
  });
}
