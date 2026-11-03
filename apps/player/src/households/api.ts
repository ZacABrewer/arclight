import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  HouseholdError,
  HouseholdProfile,
  HouseholdProfilesResponse,
  ProfileSettings,
  SelectProfileResponse,
  type HouseholdProfileCreate,
  type HouseholdProfileUpdate,
  type ProfileSettingsPatch,
} from '@arclight/shared';
import { ApiError, apiErrorBody, request } from '../core/api';
import { getSession } from '../core/session';
import { rememberReduceMotion } from '../intro/launch';
import { setActiveProfileId } from '../video/quality';
import { markPicked } from './state';

// Households in the app (spec §1.1, §2.3): the profiles of the signed-in account, choosing one
// (with its PIN), and the active profile's settings.
//
//   GET    /households/profiles                      { profiles, activeProfileId, canManage, max }
//   POST   /households/profiles                      add (owner profile only)
//   PATCH  /households/profiles/:id                  edit / set or clear the PIN
//   DELETE /households/profiles/:id
//   POST   /households/profiles/:id/select { pin? }  the device token's active profile
//   GET|PUT /households/profiles/active/settings
//
// Choosing a profile needs no new sign-in: the server ties the device token to it, so the next
// request already sees the new profile. Everything cached is refetched after a switch.

export const householdKeys = {
  all: ['households'] as const,
  profiles: () => ['households', 'profiles'] as const,
  settings: () => ['households', 'settings'] as const,
};

export const householdsApi = {
  profiles: () => request('/households/profiles', HouseholdProfilesResponse),
  create: (body: HouseholdProfileCreate) => request('/households/profiles', HouseholdProfile, { method: 'POST', json: body }),
  update: (id: number, body: HouseholdProfileUpdate) => request(`/households/profiles/${id}`, HouseholdProfile, { method: 'PATCH', json: body }),
  remove: (id: number) => request(`/households/profiles/${id}`, null, { method: 'DELETE' }),
  select: (id: number, pin?: string) => request(`/households/profiles/${id}/select`, SelectProfileResponse, { method: 'POST', json: pin ? { pin } : {} }),
  settings: () => request('/households/profiles/active/settings', ProfileSettings),
  saveSettings: (patch: ProfileSettingsPatch) => request('/households/profiles/active/settings', ProfileSettings, { method: 'PUT', json: patch }),
};

/** What a refused select means for the PIN pad. */
export type SelectFailure =
  | { kind: 'pin-required' }
  | { kind: 'pin-wrong' }
  | { kind: 'pin-locked'; retryAfterSeconds: number }
  // Back to an owner profile without a PIN on an older sign-in: the server wants the account password.
  | { kind: 'password-required' }
  | { kind: 'other'; message: string };

export function selectFailure(err: unknown): SelectFailure {
  const body = HouseholdError.safeParse(apiErrorBody(err));
  const code = body.success ? body.data.error : err instanceof ApiError ? err.message : null;
  if (code === 'pin-required') return { kind: 'pin-required' };
  if (code === 'pin-wrong') return { kind: 'pin-wrong' };
  if (code === 'password-required' || code === 'password-wrong' || code === 'reauth-required') return { kind: 'password-required' };
  if (code === 'pin-locked') return { kind: 'pin-locked', retryAfterSeconds: (body.success ? body.data.retryAfterSeconds : undefined) ?? 15 * 60 };
  return { kind: 'other', message: err instanceof Error ? err.message : String(err) };
}

export function useProfiles(enabled = true) {
  return useQuery({ queryKey: householdKeys.profiles(), queryFn: householdsApi.profiles, enabled, staleTime: 30_000, meta: { silent: true } });
}

/** The active profile (null until loaded, or on servers without households). */
export function useActiveProfile(): { profile: HouseholdProfile | null; profiles: HouseholdProfile[]; canManage: boolean; max: number } {
  const q = useProfiles();
  const data = q.data;
  const profile = data?.profiles.find((p) => p.id === data.activeProfileId) ?? null;
  const id = profile?.id ?? null;
  useEffect(() => setActiveProfileId(id), [id]);
  return { profile, profiles: data?.profiles ?? [], canManage: data?.canManage ?? false, max: data?.max ?? 0 };
}

/** The active profile's settings (defaults until loaded, or on servers without households). */
export function useProfileSettings(): ProfileSettings {
  const q = useQuery({ queryKey: householdKeys.settings(), queryFn: householdsApi.settings, staleTime: 60_000, retry: false, meta: { silent: true } });
  return q.data ?? DEFAULT_SETTINGS;
}

export const DEFAULT_SETTINGS: ProfileSettings = ProfileSettings.parse({});

export function useSaveProfileSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProfileSettingsPatch) => householdsApi.saveSettings(patch),
    onMutate: (patch) => {
      const prev = qc.getQueryData<ProfileSettings>(householdKeys.settings());
      qc.setQueryData(householdKeys.settings(), { ...(prev ?? DEFAULT_SETTINGS), ...patch });
      return { prev };
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(householdKeys.settings(), ctx.prev);
    },
    onSuccess: (saved) => {
      qc.setQueryData(householdKeys.settings(), saved);
      rememberReduceMotion(saved.reduceMotion);
      void qc.invalidateQueries({ queryKey: householdKeys.profiles() });
    },
  });
}

/**
 * Make `profile` the active one. Throws the select error (see `selectFailure`). On success the
 * picker is satisfied for this run and every cached page is refetched for the new profile.
 */
export async function selectProfile(qc: QueryClient, profile: HouseholdProfile, pin?: string): Promise<HouseholdProfile> {
  const res = await householdsApi.select(profile.id, pin);
  const s = getSession();
  if (s) markPicked(s.accountId);
  setActiveProfileId(res.activeProfile.id);
  rememberReduceMotion(res.activeProfile.settings.reduceMotion);
  qc.setQueryData(householdKeys.settings(), res.activeProfile.settings);
  // Everything cached belonged to the profile that left: drop it, so the next page never shows its
  // rows (a Kids profile would briefly see the owner's Continue Watching). Who is signed in and the
  // profile list are re-read; the new settings are already in.
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== householdKeys.all[0] && q.queryKey[0] !== 'auth' });
  await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'auth' || (q.queryKey[0] === householdKeys.all[0] && q.queryKey[1] === 'profiles') });
  return res.activeProfile;
}
