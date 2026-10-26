import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProfileMigrationProfileUpdate, ProfileMigrationRequest, ProfileMigrationSettings } from '@arclight/shared';
import { profileMigrationApi, type MismatchListQuery } from '../api/profile-migration.js';
import { libraryKeys } from './library-keys.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';

// Everything lives under ['profileMigration']; live.ts invalidates it on `profileMigration`
// and `profile` events, so progress and mismatch lists follow the server.
export const profileMigrationKeys = {
  all: ['profileMigration'] as const,
  settings: ['profileMigration', 'settings'] as const,
  profiles: ['profileMigration', 'profiles'] as const,
  profile: (id: number) => ['profileMigration', 'profiles', id] as const,
  mismatch: (query: MismatchListQuery) => ['profileMigration', 'mismatch', query] as const,
  items: ['profileMigration', 'items'] as const,
};

export function useProfileMigrationSettings() {
  return useQuery({ queryKey: profileMigrationKeys.settings, queryFn: profileMigrationApi.settings });
}

export function useSaveProfileMigrationSettings() {
  return useInvalidatingMutation((body: Partial<ProfileMigrationSettings>) => profileMigrationApi.saveSettings(body), [profileMigrationKeys.all]);
}

export function useProfileMigrationProgressList() {
  return useQuery({ queryKey: profileMigrationKeys.profiles, queryFn: profileMigrationApi.profiles });
}

export function useProfileMigrationProgress(id: number | null) {
  return useQuery({
    queryKey: profileMigrationKeys.profile(id ?? 0),
    queryFn: () => profileMigrationApi.profile(id!),
    enabled: id !== null,
  });
}

export function useUpdateProfileMigration() {
  return useInvalidatingMutation(
    ({ id, body }: { id: number; body: ProfileMigrationProfileUpdate }) => profileMigrationApi.updateProfile(id, body),
    [profileMigrationKeys.all],
  );
}

export function useProfileMigrationSearchAll() {
  return useInvalidatingMutation((id: number) => profileMigrationApi.searchAll(id), [profileMigrationKeys.all], { silent: true });
}

export function useRetryFailedMigration() {
  return useInvalidatingMutation((id: number) => profileMigrationApi.retryFailed(id), [profileMigrationKeys.all]);
}

/** Preview is a POST without side effects; errors are shown inside the dialog. */
export function useProfileMigrationPreview() {
  return useMutation({ mutationFn: (body: ProfileMigrationRequest) => profileMigrationApi.preview(body), meta: { silent: true } });
}

export function useApplyProfileMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileMigrationRequest) => profileMigrationApi.apply(body),
    meta: { silent: true },
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: profileMigrationKeys.all }),
        qc.invalidateQueries({ queryKey: ['series'] }),
        qc.invalidateQueries({ queryKey: ['movie'] }),
        qc.invalidateQueries({ queryKey: libraryKeys.wanted.all }),
        qc.invalidateQueries({ queryKey: settingsKeys.qualityProfiles }),
      ]);
    },
  });
}

export function useProfileMismatch(query: MismatchListQuery, enabled = true) {
  return useQuery({ queryKey: profileMigrationKeys.mismatch(query), queryFn: () => profileMigrationApi.mismatch(query), enabled });
}

/** Items whose files do not meet their profile, keyed `series:12` / `movie:5` (library badges). */
export function useProfileItemStatuses() {
  return useQuery({
    queryKey: profileMigrationKeys.items,
    queryFn: profileMigrationApi.items,
    select: (rows) => new Map(rows.map((r) => [`${r.mediaType}:${r.id}`, r])),
  });
}
