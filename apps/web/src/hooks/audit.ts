import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditSettings, MetricsSettings } from '@arclight/shared';
import { auditApi, metricsApi, type AuditFilter } from '../api/audit.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const auditKeys = {
  all: ['audit'] as const,
  page: (filter: AuditFilter, page: number, pageSize: number) => ['audit', 'page', filter, page, pageSize] as const,
  actions: ['audit', 'actions'] as const,
  settings: ['settings', 'audit'] as const,
  metrics: ['settings', 'metrics'] as const,
};

export function useAuditPage(filter: AuditFilter, page: number, pageSize: number) {
  return useQuery({ queryKey: auditKeys.page(filter, page, pageSize), queryFn: () => auditApi.list(filter, page, pageSize), placeholderData: keepPreviousData });
}

export function useAuditActions() {
  return useQuery({ queryKey: auditKeys.actions, queryFn: auditApi.actions, retry: false });
}

export function useAuditSettings() {
  return useQuery({ queryKey: auditKeys.settings, queryFn: auditApi.settings.get, retry: false });
}

export function useSaveAuditSettings() {
  return useInvalidatingMutation((body: AuditSettings) => auditApi.settings.update(body), [auditKeys.settings], { errorTitle: t('hooks.audit.couldNotSaveAuditSettings') });
}

export function useMetricsSettings() {
  return useQuery({ queryKey: auditKeys.metrics, queryFn: metricsApi.settings.get, retry: false });
}

export function useSaveMetricsSettings() {
  return useInvalidatingMutation((body: MetricsSettings) => metricsApi.settings.update(body), [auditKeys.metrics], { errorTitle: t('hooks.audit.couldNotSaveMetricsSettings') });
}
