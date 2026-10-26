import { useQuery } from '@tanstack/react-query';
import { statsApi } from '../api/stats.js';

// System → Stats. ['library'] events do not touch these; they refetch on focus and every 5 min.
export const statsKeys = {
  all: ['stats'] as const,
  storage: (top: number) => ['stats', 'storage', top] as const,
  library: ['stats', 'library'] as const,
  activity: (days: number) => ['stats', 'activity', days] as const,
};

const STALE = 5 * 60_000;

export function useStorageStats(top = 10) {
  return useQuery({ queryKey: statsKeys.storage(top), queryFn: () => statsApi.storage(top), staleTime: STALE, retry: false });
}

export function useLibraryStats() {
  return useQuery({ queryKey: statsKeys.library, queryFn: statsApi.library, staleTime: STALE, retry: false });
}

export function useActivityStats(days = 30) {
  return useQuery({ queryKey: statsKeys.activity(days), queryFn: () => statsApi.activity(days), staleTime: STALE, retry: false });
}
