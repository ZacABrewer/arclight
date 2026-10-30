import { useQuery } from '@tanstack/react-query';
import type { HealthAction, HealthListQueryInput, HealthScanRequestInput, HealthScanSettingsInput } from '@arclight/shared';
import { healthScanApi } from '../api/health-scan.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const healthScanKeys = {
  all: ['libraryHealth'] as const,
  list: (query: Omit<HealthListQueryInput, 'ids'>) => ['libraryHealth', 'list', query] as const,
  settings: ['libraryHealth', 'settings'] as const,
};

/** Jobs whose end means the findings changed. */
export function isHealthJob(name: string): boolean {
  return name === 'HealthScan' || name === 'HealthCheck';
}

/** Findings; polls while a scan runs so counts move without a reload. */
export function useHealthFindings(query: Omit<HealthListQueryInput, 'ids'> = {}, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: healthScanKeys.list(query),
    queryFn: () => healthScanApi.list(query),
    retry: false,
    enabled: opts.enabled ?? true,
    refetchInterval: (q) => (q.state.data?.running ? 5000 : false),
  });
}

export function useHealthScan() {
  return useInvalidatingMutation((body: HealthScanRequestInput) => healthScanApi.scan(body), [healthScanKeys.all], { errorTitle: t('library.health.couldNotStartScan') });
}

export function useHealthAction() {
  return useInvalidatingMutation(
    ({ action, ids }: { action: HealthAction; ids: readonly number[] }) => healthScanApi.act(action, ids),
    [healthScanKeys.all, ['series'], ['movie'], ['music'], ['audiobook'], ['wanted']],
    { errorTitle: t('library.health.actionFailed') },
  );
}

export function useHealthSettings() {
  return useQuery({ queryKey: healthScanKeys.settings, queryFn: () => healthScanApi.settings() });
}

export function useSaveHealthSettings() {
  return useInvalidatingMutation((body: HealthScanSettingsInput) => healthScanApi.saveSettings(body), [healthScanKeys.settings, ['jobs']]);
}
