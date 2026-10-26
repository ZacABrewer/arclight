import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CrossSeedSearchRequest, CrossSeedSettings, CrossSeedState } from '@arclight/shared';
import { crossSeedApi } from '../api/cross-seed.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Settings sit under ['settings'] so a settings event refetches them; the list under ['crossseed'].
export const crossSeedKeys = {
  all: ['crossseed'] as const,
  settings: ['settings', 'crossseed'] as const,
  list: (state: CrossSeedState | undefined) => ['crossseed', 'list', state ?? 'all'] as const,
};

export function useCrossSeedSettings() {
  return useQuery({ queryKey: crossSeedKeys.settings, queryFn: crossSeedApi.settings.get, retry: false });
}

export function useSaveCrossSeedSettings() {
  return useInvalidatingMutation((body: CrossSeedSettings) => crossSeedApi.settings.update(body), [crossSeedKeys.settings], {
    errorTitle: t('hooks.crossSeed.couldNotSaveSettings'),
  });
}

export function useCrossSeeds(state: CrossSeedState | undefined) {
  return useQuery({ queryKey: crossSeedKeys.list(state), queryFn: () => crossSeedApi.list(state ? { state } : {}), retry: false });
}

/** POST /crossseed/search; the caller shows the report. */
export function useCrossSeedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CrossSeedSearchRequest) => crossSeedApi.search(body),
    meta: { errorTitle: t('hooks.crossSeed.searchFailed') },
    onSuccess: () => void qc.invalidateQueries({ queryKey: crossSeedKeys.all }),
  });
}
