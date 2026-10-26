import { useQuery } from '@tanstack/react-query';
import { healthApi } from '../api/health.js';
import { systemApi } from '../api/system.js';
import { queryKeys } from './query-keys.js';

export function useSystemStatus() {
  return useQuery({ queryKey: queryKeys.systemStatus, queryFn: systemApi.status, refetchInterval: 30_000 });
}

/** Health is pushed over the event feed; the slow poll is only a safety net. */
export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, refetchInterval: 5 * 60_000 });
}
