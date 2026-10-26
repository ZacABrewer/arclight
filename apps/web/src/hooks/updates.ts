import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContainerUpdatesInfo, UpdateInfo, UpdateSettingsUpdate } from '@arclight/shared';
import { solverApi } from '../api/solver.js';
import { updatesApi } from '../api/updates.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Updates and the challenge solver. ['settings'] is invalidated by live.ts on settings events.
export const updateKeys = {
  all: ['updates'] as const,
  info: ['updates', 'info'] as const,
  containers: ['updates', 'containers'] as const,
  settings: ['settings', 'updates'] as const,
};

export const solverKeys = {
  status: ['solver', 'status'] as const,
  settings: ['settings', 'solver'] as const,
};

export function useUpdateInfo() {
  return useQuery({ queryKey: updateKeys.info, queryFn: updatesApi.info, retry: false });
}

export function useCheckForUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updatesApi.check,
    meta: { errorTitle: t('hooks.updates.couldNotCheckForUpdates') },
    onSuccess: (info: UpdateInfo) => qc.setQueryData(updateKeys.info, info),
  });
}

export function useUpdateSettings() {
  return useQuery({ queryKey: updateKeys.settings, queryFn: updatesApi.settings.get, retry: false });
}

export function useSaveUpdateSettings() {
  return useInvalidatingMutation((body: UpdateSettingsUpdate) => updatesApi.settings.update(body), [updateKeys.settings, updateKeys.all], {
    errorTitle: t('hooks.updates.couldNotSaveUpdateSettings'),
  });
}

export function useContainerUpdates() {
  return useQuery({ queryKey: updateKeys.containers, queryFn: updatesApi.containers.info, retry: false });
}

export function useCheckContainers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updatesApi.containers.check,
    meta: { errorTitle: t('hooks.updates.couldNotCheckContainers') },
    onSuccess: (info: ContainerUpdatesInfo) => qc.setQueryData(updateKeys.containers, info),
  });
}

/** Update one container (by name) or, without a name, every container with an update. */
export function useUpdateContainers() {
  return useInvalidatingMutation((name: string | undefined) => (name ? updatesApi.containers.update(name) : updatesApi.containers.updateAll()), [updateKeys.containers], {
    errorTitle: t('hooks.updates.containerUpdateFailed'),
  });
}

export function useSolverStatus() {
  return useQuery({ queryKey: solverKeys.status, queryFn: solverApi.status, retry: false, refetchInterval: 10_000 });
}

export function useSolverSettings() {
  return useQuery({ queryKey: solverKeys.settings, queryFn: solverApi.settings.get, retry: false });
}
