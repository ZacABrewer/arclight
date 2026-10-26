import { useQuery } from '@tanstack/react-query';
import type { HygieneMapRequestInput } from '@arclight/shared';
import { hygieneApi } from '../api/hygiene.js';
import { libraryApi } from '../api/library.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const hygieneKeys = {
  all: ['hygiene'] as const,
  list: ['hygiene', 'list'] as const,
  episodes: (seriesId: number) => ['hygiene', 'episodes', seriesId] as const,
};

export function useHygieneFindings() {
  return useQuery({ queryKey: hygieneKeys.list, queryFn: () => hygieneApi.list(), retry: false });
}

/** Episodes of the series picked in the Map dialog (nothing until one is picked). */
export function useMapEpisodes(seriesId: number | null) {
  return useQuery({
    queryKey: hygieneKeys.episodes(seriesId ?? 0),
    queryFn: () => libraryApi.episodes.list({ seriesId: seriesId ?? 0 }),
    enabled: seriesId !== null,
  });
}

export function useHygieneScan() {
  return useInvalidatingMutation(() => hygieneApi.scan(), [hygieneKeys.list], { errorTitle: t('hooks.hygiene.couldNotStartTheScan') });
}

export function useHygieneMap() {
  return useInvalidatingMutation(({ id, body }: { id: number; body: HygieneMapRequestInput }) => hygieneApi.map(id, body), [hygieneKeys.list, ['series'], ['movie']], {
    silent: true,
  });
}

export function useHygieneDelete() {
  return useInvalidatingMutation((id: number) => hygieneApi.remove(id), [hygieneKeys.list], { errorTitle: t('hooks.hygiene.couldNotDelete') });
}
