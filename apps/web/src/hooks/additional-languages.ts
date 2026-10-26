import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AdditionalLanguageRequestInput, ItemLanguagesQuery } from '@arclight/shared';
import { additionalLanguagesApi } from '../api/additional-languages.js';
import { libraryKeys } from './library-keys.js';
import { subtitleKeys } from './query-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const additionalLanguageKeys = {
  all: ['additionalLanguages'] as const,
  item: (query: ItemLanguagesQuery) => ['additionalLanguages', 'item', query] as const,
  /** Previews are snapshots of a draft: their own family, never invalidated. */
  preview: (body: AdditionalLanguageRequestInput | null) => ['additionalLanguagePreview', body] as const,
};

/** What a saved additional language can change: the item chips, subtitles, the item and Activity. */
const AFFECTED = [additionalLanguageKeys.all, subtitleKeys.all, libraryKeys.series.all, libraryKeys.movie.all, libraryKeys.wanted.all, ['history'], ['jobs']] as const;

export function useItemLanguages(query: ItemLanguagesQuery, enabled = true) {
  return useQuery({ queryKey: additionalLanguageKeys.item(query), queryFn: () => additionalLanguagesApi.item(query), enabled, retry: false });
}

/** Plan for a draft; null skips the call (nothing to preview yet). */
export function useAdditionalLanguagePreview(body: AdditionalLanguageRequestInput | null) {
  return useQuery({
    queryKey: additionalLanguageKeys.preview(body),
    queryFn: () => additionalLanguagesApi.preview(body!),
    enabled: body !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useApplyAdditionalLanguage() {
  return useInvalidatingMutation((body: AdditionalLanguageRequestInput) => additionalLanguagesApi.apply(body), AFFECTED, { silent: true });
}

export function useRemoveAdditionalLanguage() {
  return useInvalidatingMutation((id: number) => additionalLanguagesApi.remove(id), AFFECTED, {
    errorTitle: t('hooks.additionalLanguages.couldNotRemove'),
  });
}

