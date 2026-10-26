import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigManagedKeys } from '@arclight/shared';
import { configApi, type ConfigImportBody } from '../api/config.js';

// Config as code. Locking pages: read `useManagedKeys()` and pass
// `managed={isSectionManaged(keys.data, '<settings section>')}` to SettingsSection
// (pages/settings/shared.tsx); it draws the lock badge and disables the section's inputs.

export const configKeys = {
  managed: ['config', 'managed-keys'] as const,
};

/** What ARCLIGHT_CONFIG_FILE / ARCLIGHT_SETTING__* own. A failure (older server) reads as nothing managed. */
export function useManagedKeys() {
  return useQuery({ queryKey: configKeys.managed, queryFn: configApi.managedKeys, retry: false, staleTime: 60_000 });
}

/** Keys of a settings section owned by the config file or env (empty when unmanaged). */
export function managedSectionKeys(keys: ConfigManagedKeys | undefined, section: string): string[] {
  return keys?.settings[section] ?? [];
}

/** True when any key of settings `section` (`metadata`, `guides`, …) is managed. */
export function isSectionManaged(keys: ConfigManagedKeys | undefined, section: string): boolean {
  return managedSectionKeys(keys, section).length > 0;
}

/** True when a resource (kind `indexers`, key `Nyaa`) is owned by the config file. */
export function isResourceManaged(keys: ConfigManagedKeys | undefined, kind: string, key: string): boolean {
  return (keys?.resources[kind] ?? []).includes(key);
}

export function useConfigImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfigImportBody) => configApi.import(body),
    meta: { silent: true },
    onSuccess: async (result) => {
      // A real apply can touch every settings page: refetch everything.
      if (result.applied) await qc.invalidateQueries();
    },
  });
}
