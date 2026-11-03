import { useQuery } from '@tanstack/react-query';
import { VideoFeatured } from '@arclight/shared';
import { browseKeys } from '@web/features/player/browse/api';
import { request } from '../core/api';

// The rotating hero (spec §3.2): GET /playback/video/featured?limit=1..8, stable for a profile for
// the day. A server without it (older version) answers 404: no hero, the rows move up.

export const featuredKeys = { list: (limit: number) => [...browseKeys.all, 'video', 'featured', limit] as const };

export function useFeatured(limit = 5) {
  return useQuery({
    queryKey: featuredKeys.list(limit),
    queryFn: () => request('/playback/video/featured', VideoFeatured, { query: { limit } }),
    retry: false,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
}
