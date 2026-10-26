import { useQuery } from '@tanstack/react-query';
import type { AlertSettings } from '@arclight/shared';
import { alertsApi } from '../api/alerts.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Alert settings sit under ['settings'] (refetched on every `settings` event); the summaries
// under ['summary'], which live.ts invalidates on a `summary` event.
export const alertKeys = {
  settings: ['settings', 'alerts'] as const,
  summaryAll: ['summary'] as const,
  summaryLatest: ['summary', 'latest'] as const,
  summaryList: (limit: number | undefined) => ['summary', 'list', limit ?? null] as const,
};

export function useAlertSettings() {
  return useQuery({ queryKey: alertKeys.settings, queryFn: alertsApi.settings.get, retry: false });
}

export function useSaveAlertSettings() {
  return useInvalidatingMutation((body: AlertSettings) => alertsApi.settings.update(body), [alertKeys.settings], {
    errorTitle: t('hooks.alerts.couldNotSaveAlertSettings'),
  });
}

export function useLatestSummary(enabled = true) {
  return useQuery({ queryKey: alertKeys.summaryLatest, queryFn: alertsApi.summary.latest, retry: false, enabled });
}

export function useSummaries(limit?: number) {
  return useQuery({ queryKey: alertKeys.summaryList(limit), queryFn: () => alertsApi.summary.list(limit), retry: false });
}

/** Build a summary now (the dashboard's "Build now"); `notify` also sends it out. */
export function useGenerateSummary() {
  return useInvalidatingMutation((notify: boolean) => alertsApi.summary.generate({ notify }), [alertKeys.summaryAll], {
    errorTitle: t('hooks.alerts.couldNotBuildSummary'),
  });
}
