import { useQuery } from '@tanstack/react-query';
import { activeStreamsApi } from '../api/active-streams.js';

export const activeStreamsKeys = { all: ['activity', 'streams'] as const };

/** How often the Now playing page asks again. */
export const ACTIVE_STREAMS_POLL_MS = 5_000;

export function useActiveStreams() {
  return useQuery({ queryKey: activeStreamsKeys.all, queryFn: activeStreamsApi.list, refetchInterval: ACTIVE_STREAMS_POLL_MS, retry: false });
}
