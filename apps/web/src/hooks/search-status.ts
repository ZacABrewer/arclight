import { useQuery } from '@tanstack/react-query';
import type { SearchItemType } from '@arclight/shared';
import { searchStatusApi } from '../api/search-status.js';

// Search status (last search, next scheduled search) per episode / movie. The first key segment
// is 'history' so live.ts's release/history invalidations (a search grabs, a job finishes)
// refresh it like the decision log.
export const searchStatusKeys = {
  all: ['history', 'searchStatus'] as const,
  list: (mediaType: SearchItemType, ids: readonly number[]) => ['history', 'searchStatus', mediaType, ids] as const,
};

/** At most 500 ids per request (the api's limit); an empty list asks nothing. */
export function useSearchStatus(mediaType: SearchItemType, ids: readonly number[], enabled = true) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b).slice(0, 500);
  return useQuery({
    queryKey: searchStatusKeys.list(mediaType, sorted),
    queryFn: () => searchStatusApi.list(mediaType, sorted),
    enabled: enabled && sorted.length > 0,
    retry: false,
    staleTime: 30_000,
    // "in 3 h" drifts; refresh now and then while the page stays open.
    refetchInterval: 5 * 60_000,
  });
}
