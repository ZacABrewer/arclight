import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddPodcastRequest,
  CreatePodcastSuggestion,
  PodcastEpisodeBulkAction,
  PodcastEpisodeQuery,
  PodcastOpmlImportRequest,
  PodcastSearchSource,
  PodcastSettingsInput,
  PodcastSuggestionListQuery,
  UpdatePodcastRequest,
} from '@arclight/shared';
import { podcastsApi } from '../api/podcasts.js';
import { podcastKeys } from './podcast-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Podcast subscriptions, episodes and suggestions. The feature flag lives in hooks/music.ts
// (useFeatures); every mutation refetches ['podcast'] (plus the calendar for episode changes).

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

export function usePodcastList(enabled = true) {
  return useQuery({ queryKey: podcastKeys.list(), queryFn: podcastsApi.list, enabled });
}

export function usePodcast(id: number) {
  return useQuery({ queryKey: podcastKeys.detail(id), queryFn: () => podcastsApi.get(id), enabled: Number.isInteger(id) && id > 0 });
}

export function usePodcastEpisodes(query: PodcastEpisodeQuery, enabled = true) {
  return useQuery({
    queryKey: podcastKeys.episodes(query),
    queryFn: () => podcastsApi.episodes.list(query),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Admin directory search; empty terms do not search. */
export function usePodcastLookup(term: string, source?: PodcastSearchSource) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: podcastKeys.lookup(trimmed, source),
    queryFn: () => podcastsApi.lookup(trimmed, source),
    enabled: trimmed.length > 0,
    staleTime: 5 * 60_000,
  });
}

/** Portal directory search (any signed-in user). */
export function usePodcastSearch(term: string) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: podcastKeys.search(trimmed),
    queryFn: () => podcastsApi.search(trimmed),
    enabled: trimmed.length > 0,
    staleTime: 5 * 60_000,
  });
}

export function usePodcastSuggestions(query: PodcastSuggestionListQuery = {}, enabled = true) {
  return useQuery({ queryKey: podcastKeys.suggestions(query), queryFn: () => podcastsApi.suggestions.list(query), enabled });
}

export function usePodcastSettings(enabled = true) {
  return useQuery({ queryKey: podcastKeys.settings, queryFn: podcastsApi.settings.get, enabled });
}

// ---------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------

/** Refetch every podcast query (and the calendar, which lists episodes). */
function usePodcastMutation<TVars, TData>(mutationFn: (vars: TVars) => Promise<TData>, errorTitle: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    meta: { errorTitle },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: podcastKeys.all });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

export function useAddPodcast() {
  return usePodcastMutation((body: AddPodcastRequest) => podcastsApi.add(body), t('podcasts.hooks.couldNotAdd'));
}

export function useUpdatePodcast() {
  return usePodcastMutation(({ id, ...body }: UpdatePodcastRequest & { id: number }) => podcastsApi.update(id, body), t('podcasts.hooks.couldNotSave'));
}

export function useDeletePodcast() {
  return usePodcastMutation(({ id, deleteFiles }: { id: number; deleteFiles: boolean }) => podcastsApi.remove(id, deleteFiles), t('podcasts.hooks.couldNotDelete'));
}

export function useRefreshPodcast() {
  return usePodcastMutation((id: number) => podcastsApi.refresh(id), t('podcasts.hooks.couldNotRefresh'));
}

export function useRefreshAllPodcasts() {
  return usePodcastMutation(() => podcastsApi.refreshAll(), t('podcasts.hooks.couldNotRefresh'));
}

export function useSetEpisodePlayed() {
  return usePodcastMutation(({ id, played }: { id: number; played: boolean }) => podcastsApi.episodes.setPlayed(id, played), t('podcasts.hooks.couldNotUpdateEpisode'));
}

export function useDownloadEpisode() {
  return usePodcastMutation((id: number) => podcastsApi.episodes.download(id), t('podcasts.hooks.couldNotDownload'));
}

export function useDeleteEpisodeFile() {
  return usePodcastMutation((id: number) => podcastsApi.episodes.deleteFile(id), t('podcasts.hooks.couldNotDeleteFile'));
}

export function useBulkEpisodes() {
  return usePodcastMutation(
    ({ ids, action }: { ids: number[]; action: PodcastEpisodeBulkAction }) => podcastsApi.episodes.bulk(ids, action),
    t('podcasts.hooks.couldNotUpdateEpisode'),
  );
}

export function usePodcastPreview() {
  return useMutation({ mutationFn: (feedUrl: string) => podcastsApi.preview(feedUrl), meta: { silent: true } });
}

export function useImportOpml() {
  return usePodcastMutation((body: PodcastOpmlImportRequest) => podcastsApi.importOpml(body), t('podcasts.hooks.couldNotImport'));
}

export function useSavePodcastSettings() {
  return useInvalidatingMutation((body: PodcastSettingsInput) => podcastsApi.settings.save(body), [podcastKeys.settings], {
    errorTitle: t('podcasts.hooks.couldNotSaveSettings'),
  });
}

export function useCreateSuggestion() {
  return usePodcastMutation((body: CreatePodcastSuggestion) => podcastsApi.suggestions.create(body), t('podcasts.hooks.couldNotSuggest'));
}

export function useApproveSuggestion() {
  return usePodcastMutation((id: number) => podcastsApi.suggestions.approve(id), t('podcasts.hooks.couldNotApprove'));
}

export function useDeclineSuggestion() {
  return usePodcastMutation(({ id, reason }: { id: number; reason?: string | undefined }) => podcastsApi.suggestions.decline(id, reason), t('podcasts.hooks.couldNotDecline'));
}

export function useDeleteSuggestion() {
  return usePodcastMutation((id: number) => podcastsApi.suggestions.remove(id), t('podcasts.hooks.couldNotDeleteSuggestion'));
}
