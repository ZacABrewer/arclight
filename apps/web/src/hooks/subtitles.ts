import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { LanguageProfileInput, SubtitleMediaType, SubtitleSearchCommand, SubtitleSettings } from '@arclight/shared';
import { languageProfilesApi, subtitlesApi, type SubtitleHistoryFilter, type SubtitleScope, type SubtitleUploadInput } from '../api/subtitles.js';
import { subtitleKeys } from './query-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';

const ALL = subtitleKeys.all;

export function useLanguageProfiles() {
  return useQuery({ queryKey: subtitleKeys.languageProfiles, queryFn: languageProfilesApi.list, retry: false });
}

export function useSubtitleLanguages() {
  return useQuery({ queryKey: subtitleKeys.languages, queryFn: subtitlesApi.languages, staleTime: Infinity, retry: false });
}

export function useSaveLanguageProfile() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: LanguageProfileInput }) =>
      id === undefined ? languageProfilesApi.create(body) : languageProfilesApi.update(id, body),
    [subtitleKeys.languageProfiles, ALL],
    { silent: true },
  );
}

export function useDeleteLanguageProfile() {
  return useInvalidatingMutation((id: number) => languageProfilesApi.remove(id), [subtitleKeys.languageProfiles, ALL], { silent: true });
}

export function useSubtitleSettings() {
  return useQuery({ queryKey: subtitleKeys.settings, queryFn: subtitlesApi.settings, retry: false });
}

export function useSaveSubtitleSettings() {
  return useInvalidatingMutation((body: SubtitleSettings) => subtitlesApi.saveSettings(body), [subtitleKeys.settings, subtitleKeys.providers], {
    errorTitle: 'Could not save subtitle settings',
  });
}

export function useSubtitleProviders() {
  return useQuery({ queryKey: subtitleKeys.providers, queryFn: subtitlesApi.providers, retry: false });
}

export function useResetProviderThrottles() {
  return useInvalidatingMutation((onlyAuthOrConfig: boolean) => subtitlesApi.resetProviders(onlyAuthOrConfig), [subtitleKeys.providers], {
    errorTitle: 'Could not reset throttles',
  });
}

export function useWantedSubtitles(mediaType: SubtitleMediaType, page: number, pageSize: number) {
  return useQuery({
    queryKey: subtitleKeys.wanted(mediaType, page, pageSize),
    queryFn: () => subtitlesApi.wanted(mediaType, page, pageSize),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useSubtitleHistory(filter: SubtitleHistoryFilter) {
  return useQuery({
    queryKey: subtitleKeys.history(filter),
    queryFn: () => subtitlesApi.history(filter),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useSubtitleBlacklist(page: number, pageSize: number) {
  return useQuery({
    queryKey: subtitleKeys.blacklist(page, pageSize),
    queryFn: () => subtitlesApi.blacklist(page, pageSize),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRemoveFromSubtitleBlacklist() {
  return useInvalidatingMutation((id: number) => subtitlesApi.removeFromBlacklist(id), [ALL], { errorTitle: 'Could not remove from blacklist' });
}

export function useClearSubtitleBlacklist() {
  return useInvalidatingMutation(() => subtitlesApi.clearBlacklist(), [ALL], { silent: true });
}

export function useBlacklistSubtitle() {
  return useInvalidatingMutation((subtitleId: number) => subtitlesApi.addToBlacklist({ subtitleId, search: true }), [ALL], {
    errorTitle: 'Could not blacklist subtitle',
  });
}

export function useMediaFileSubtitles(scope: SubtitleScope | null) {
  return useQuery({
    queryKey: subtitleKeys.files(scope),
    queryFn: () => subtitlesApi.files(scope!),
    enabled: scope !== null,
    retry: false,
  });
}

export function useScanSubtitles() {
  return useInvalidatingMutation((scope: SubtitleScope) => subtitlesApi.scan(scope), [ALL], { errorTitle: 'Rescan failed' });
}

export function useSubtitleSearchCommand() {
  return useInvalidatingMutation((scope: SubtitleSearchCommand) => subtitlesApi.search(scope), [ALL], { errorTitle: 'Subtitle search failed' });
}

export function useManualSubtitleSearch(mediaFileId: number | null, language: string) {
  return useQuery({
    queryKey: subtitleKeys.manualSearch(mediaFileId ?? 0, language),
    queryFn: () => subtitlesApi.manualSearch(mediaFileId!, language || undefined),
    enabled: mediaFileId !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useDownloadSubtitle() {
  return useInvalidatingMutation(({ mediaFileId, key }: { mediaFileId: number; key: string }) => subtitlesApi.download(mediaFileId, key), [ALL], {
    errorTitle: 'Download failed',
  });
}

export function useUploadSubtitle() {
  return useInvalidatingMutation((input: SubtitleUploadInput) => subtitlesApi.upload(input), [ALL], { silent: true });
}

export function useDeleteSubtitle() {
  return useInvalidatingMutation((id: number) => subtitlesApi.remove(id), [ALL], { silent: true });
}

export function useSyncSubtitle() {
  return useInvalidatingMutation((id: number) => subtitlesApi.sync(id), [ALL], { errorTitle: 'Sync failed' });
}

export function useExtractSubtitle() {
  return useInvalidatingMutation((id: number) => subtitlesApi.extract(id), [ALL], { errorTitle: 'Extract failed' });
}
