import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { LanguageProfileInput, SubtitleMediaType, SubtitleSearchCommand, SubtitleSettings } from '@arclight/shared';
import { languageProfilesApi, subtitlesApi, type SubtitleHistoryFilter, type SubtitleScope, type SubtitleUploadInput } from '../api/subtitles.js';
import { subtitleKeys } from './query-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

const ALL = subtitleKeys.all;
/** Under the subtitles family, so settings saves and subtitle events refresh it too. */
const WHISPER_STATUS = ['subtitles', 'whisperStatus'] as const;

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
    errorTitle: t('hooks.subtitles.couldNotSaveSubtitleSettings'),
  });
}

export function useSubtitleProviders() {
  return useQuery({ queryKey: subtitleKeys.providers, queryFn: subtitlesApi.providers, retry: false });
}

export function useResetProviderThrottles() {
  return useInvalidatingMutation((onlyAuthOrConfig: boolean) => subtitlesApi.resetProviders(onlyAuthOrConfig), [subtitleKeys.providers], {
    errorTitle: t('hooks.subtitles.couldNotResetThrottles'),
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
  return useInvalidatingMutation((id: number) => subtitlesApi.removeFromBlacklist(id), [ALL], { errorTitle: t('hooks.subtitles.couldNotRemoveFromBlacklist') });
}

export function useClearSubtitleBlacklist() {
  return useInvalidatingMutation(() => subtitlesApi.clearBlacklist(), [ALL], { silent: true });
}

export function useBlacklistSubtitle() {
  return useInvalidatingMutation((subtitleId: number) => subtitlesApi.addToBlacklist({ subtitleId, search: true }), [ALL], {
    errorTitle: t('hooks.subtitles.couldNotBlacklistSubtitle'),
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
  return useInvalidatingMutation((scope: SubtitleScope) => subtitlesApi.scan(scope), [ALL], { errorTitle: t('hooks.subtitles.rescanFailed') });
}

export function useSubtitleSearchCommand() {
  return useInvalidatingMutation((scope: SubtitleSearchCommand) => subtitlesApi.search(scope), [ALL], { errorTitle: t('hooks.subtitles.subtitleSearchFailed') });
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
    errorTitle: t('hooks.subtitles.downloadFailed'),
  });
}

export function useUploadSubtitle() {
  return useInvalidatingMutation((input: SubtitleUploadInput) => subtitlesApi.upload(input), [ALL], { silent: true });
}

export function useDeleteSubtitle() {
  return useInvalidatingMutation((id: number) => subtitlesApi.remove(id), [ALL], { silent: true });
}

export function useSyncSubtitle() {
  return useInvalidatingMutation((id: number) => subtitlesApi.sync(id), [ALL], { errorTitle: t('common.syncFailed') });
}

export function useExtractSubtitle() {
  return useInvalidatingMutation((id: number) => subtitlesApi.extract(id), [ALL], { errorTitle: t('hooks.subtitles.extractFailed') });
}

export function useCheckSubtitleSync() {
  return useInvalidatingMutation((id: number) => subtitlesApi.syncCheck(id), [ALL], { errorTitle: t('hooks.subtitles.syncCheckFailed') });
}

export function useWhisperStatus() {
  return useQuery({ queryKey: WHISPER_STATUS, queryFn: subtitlesApi.whisperStatus, retry: false });
}
