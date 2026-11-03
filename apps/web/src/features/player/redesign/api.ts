import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HouseholdProfile,
  HouseholdProfilesResponse,
  MyListResponse,
  ProfileSettings,
  SelectProfileResponse,
  TrickplayManifest,
  VideoFeatured,
  type HouseholdProfileCreate,
  type HouseholdProfileUpdate,
  type MyListKey,
  type ProfileSettingsPatch,
} from '@arclight/shared';
import { ApiError, request } from '../../../api/client.js';
import { authKeys } from '../../../auth/guard.js';
import { useAuth } from '../../../auth/auth-context.js';
import { browseKeys } from '../browse/api.js';
import { playerKeys } from '../api.js';
import { t } from '../../../i18n/index.js';

// The redesign's calls (redesign spec §1.1, §1.2):
//   GET    /households/profiles                      profiles of the account, the active one
//   POST   /households/profiles/:id/select           switch (PIN when set)
//   GET    /households/profiles/active/settings      ProfileSettings of the active profile
//   PUT    /households/profiles/active/settings      patch them
//   POST/PATCH/DELETE /households/profiles[/:id]     manage (owner profile only)
//   GET    /playback/my-list, PUT/DELETE /playback/my-list/:key
//   GET    /playback/video/featured?limit
//   GET    /playback/video/trickplay/:mediaFileId

export const householdApi = {
  profiles: () => request('/households/profiles', HouseholdProfilesResponse),
  select: (id: number, pin?: string, password?: string) =>
    request(`/households/profiles/${id}/select`, SelectProfileResponse, { method: 'POST', json: { ...(pin ? { pin } : {}), ...(password ? { password } : {}) } }),
  settings: () => request('/households/profiles/active/settings', ProfileSettings),
  saveSettings: (patch: ProfileSettingsPatch) => request('/households/profiles/active/settings', ProfileSettings, { method: 'PUT', json: patch }),
  create: (body: HouseholdProfileCreate) => request('/households/profiles', HouseholdProfile, { method: 'POST', json: body }),
  update: (id: number, body: HouseholdProfileUpdate) => request(`/households/profiles/${id}`, HouseholdProfile, { method: 'PATCH', json: body }),
  remove: (id: number) => request(`/households/profiles/${id}`, null, { method: 'DELETE' }),
};

export const redesignApi = {
  myList: () => request('/playback/my-list', MyListResponse),
  addToMyList: (key: MyListKey) => request(`/playback/my-list/${encodeURIComponent(key)}`, null, { method: 'PUT' }),
  removeFromMyList: (key: MyListKey) => request(`/playback/my-list/${encodeURIComponent(key)}`, null, { method: 'DELETE' }),
  featured: (limit = 5) => request('/playback/video/featured', VideoFeatured, { query: { limit } }),
  trickplay: (mediaFileId: number) => request(`/playback/video/trickplay/${mediaFileId}`, TrickplayManifest),
};

export const householdKeys = {
  all: ['households'] as const,
  profiles: ['households', 'profiles'] as const,
  settings: ['households', 'settings'] as const,
};

export const redesignKeys = {
  // Under the browse prefix so a profile switch or a watched change refreshes them with the pages.
  myList: [...browseKeys.all, 'video', 'my-list'] as const,
  featured: [...browseKeys.all, 'video', 'featured'] as const,
  trickplay: (mediaFileId: number) => [...playerKeys.all, 'trickplay', mediaFileId] as const,
};

/** The account's profiles. A server without households (404) reads as "just you". */
export function useHouseholdProfiles(enabled = true) {
  return useQuery({
    queryKey: householdKeys.profiles,
    queryFn: async () => {
      try {
        return await householdApi.profiles();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Defaults for every field (ProfileSettings' own), for servers without households. */
export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = ProfileSettings.parse({});

/** The active profile's settings; the defaults until they load (or when the server has none). */
export function useProfileSettings(): ProfileSettings {
  const q = useQuery({
    queryKey: householdKeys.settings,
    queryFn: async () => {
      try {
        return await householdApi.settings();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return DEFAULT_PROFILE_SETTINGS;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  return q.data ?? DEFAULT_PROFILE_SETTINGS;
}

/** Patch the active profile's settings; the screen updates at once. */
export function useSaveProfileSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProfileSettingsPatch) => householdApi.saveSettings(patch),
    meta: { errorTitle: t('player.redesign.settings.couldNotSave') },
    onMutate: (patch) => {
      const before = qc.getQueryData<ProfileSettings>(householdKeys.settings);
      qc.setQueryData<ProfileSettings>(householdKeys.settings, { ...(before ?? DEFAULT_PROFILE_SETTINGS), ...stripUndefined(patch) } as ProfileSettings);
      return { before };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.before) qc.setQueryData(householdKeys.settings, ctx.before);
    },
    onSuccess: (saved) => {
      qc.setQueryData(householdKeys.settings, saved);
      void qc.invalidateQueries({ queryKey: householdKeys.profiles });
    },
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Switch profiles (the whole browser session, §4.6). Afterwards everything cached belonged to the
 * old profile: re-read /auth/me and drop the rest.
 */
export function useSelectProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pin, password }: { id: number; pin?: string | undefined; password?: string | undefined }) => householdApi.select(id, pin, password),
    meta: { silent: true },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: authKeys.all });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== authKeys.all[0] });
      await qc.invalidateQueries();
    },
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: HouseholdProfileCreate) => householdApi.create(body),
    meta: { errorTitle: t('player.redesign.profiles.couldNotSave') },
    onSuccess: () => qc.invalidateQueries({ queryKey: householdKeys.profiles }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: HouseholdProfileUpdate }) => householdApi.update(id, body),
    meta: { errorTitle: t('player.redesign.profiles.couldNotSave') },
    onSuccess: () => qc.invalidateQueries({ queryKey: householdKeys.profiles }),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => householdApi.remove(id),
    meta: { errorTitle: t('player.redesign.profiles.couldNotDelete') },
    onSuccess: () => qc.invalidateQueries({ queryKey: householdKeys.profiles }),
  });
}

/** The active profile as /auth/me reports it; null on servers without households. */
export function useActiveProfile() {
  const { session } = useAuth();
  return session?.activeProfile ?? null;
}

/** Profiles cannot request (§2.5): request entry points show only on the owner profile. */
export function useIsOwnerProfile(): boolean {
  const active = useActiveProfile();
  return active ? active.isOwner : true;
}

// ---- My List --------------------------------------------------------------------------------

export function myListKey(kind: 'movie' | 'series', id: number): MyListKey {
  return `${kind}:${id}`;
}

export function useMyList(enabled = true) {
  return useQuery({
    queryKey: redesignKeys.myList,
    queryFn: async () => {
      try {
        return await redesignApi.myList();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { items: [] };
        throw err;
      }
    },
    enabled,
  });
}

/** Add or remove a title; detail pages, the hero and My List refresh. */
export function useToggleMyList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, add }: { key: MyListKey; add: boolean }) => (add ? redesignApi.addToMyList(key) : redesignApi.removeFromMyList(key)),
    meta: { errorTitle: t('player.redesign.myList.couldNotUpdate') },
    onSuccess: () => qc.invalidateQueries({ queryKey: browseKeys.all }),
  });
}

// ---- Featured and trickplay ----------------------------------------------------------------

export function useFeatured(enabled = true) {
  return useQuery({
    queryKey: redesignKeys.featured,
    queryFn: async () => {
      try {
        return await redesignApi.featured(5);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { items: [] };
        throw err;
      }
    },
    enabled,
    staleTime: 10 * 60_000,
  });
}

/**
 * Scrub thumbnails for a file. Starts from the session's manifest; while it is pending, asks
 * again every 20 s (generation runs in the background on the server).
 */
export function useTrickplay(mediaFileId: number | null, initial: TrickplayManifest | null | undefined) {
  return useQuery({
    queryKey: redesignKeys.trickplay(mediaFileId ?? 0),
    queryFn: () => redesignApi.trickplay(mediaFileId ?? 0),
    enabled: mediaFileId !== null && mediaFileId > 0,
    ...(initial && initial.mediaFileId === mediaFileId ? { initialData: initial } : {}),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 20_000 : false),
    retry: false,
    meta: { silent: true },
  });
}
