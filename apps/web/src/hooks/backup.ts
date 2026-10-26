import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupSettings } from '@arclight/shared';
import { backupApi } from '../api/backup.js';
import { queryKeys } from './query-keys.js';
import { t } from '../i18n/index.js';

export const backupKeys = {
  all: ['backup'] as const,
  list: ['backup', 'list'] as const,
  settings: ['backup', 'settings'] as const,
};

export function useBackups() {
  return useQuery({ queryKey: backupKeys.list, queryFn: backupApi.list });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupApi.create,
    meta: { errorTitle: t('hooks.backup.backupFailed') },
    onSuccess: () => qc.invalidateQueries({ queryKey: backupKeys.list }),
  });
}

/** Errors surface in the confirm dialog, so no toast. */
export function useDeleteBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupApi.remove,
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: backupKeys.list }),
  });
}

/** A restore flips /system/status restartRequired; refresh it so the banner shows. */
export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: { id: string } | { file: File }) =>
      'id' in source ? backupApi.restore(source.id) : backupApi.restoreUpload(source.file),
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.systemStatus }),
  });
}

export function useBackupSettings() {
  return useQuery({ queryKey: backupKeys.settings, queryFn: backupApi.settings });
}

export function useSaveBackupSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: BackupSettings) => backupApi.saveSettings(value),
    meta: { errorTitle: t('hooks.backup.couldNotSaveBackupSettings') },
    onSuccess: (data) => qc.setQueryData(backupKeys.settings, data),
  });
}

export function useRestart() {
  return useMutation({ mutationFn: backupApi.restart, meta: { errorTitle: t('hooks.backup.restartFailed') } });
}
