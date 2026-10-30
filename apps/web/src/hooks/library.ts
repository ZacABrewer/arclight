import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  AddMovieRequest,
  AddSeriesRequest,
  BulkMovieUpdateRequest,
  BulkSeriesUpdateRequest,
  Episode,
  Movie,
  ReleaseGrabRequest,
  SearchCommandRequest,
  Series,
  UpdateMovieRequest,
  UpdateSeriesRequest,
  WantedEpisodesPage,
  WantedMoviesPage,
  WantedReleaseFilter,
} from '@arclight/shared';
import { ApiError } from '../api/client.js';
import { libraryApi, type DeleteMediaOptions } from '../api/library.js';
import { profilesApi } from '../api/profiles.js';
import { useToast as useToastStore } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { audiobookKeys } from './audiobook-keys.js';
import { libraryKeys } from './library-keys.js';
import { musicKeys } from './music-keys.js';
import { searchStatusKeys } from './search-status.js';
import { t } from '../i18n/index.js';

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

export function useSeriesList() {
  return useQuery({ queryKey: libraryKeys.series.list(), queryFn: () => libraryApi.series.list({ includeStatistics: true }) });
}

export function useSeries(id: number) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: libraryKeys.series.detail(id),
    queryFn: () => libraryApi.series.get(id),
    // Seed from the list so the header renders instantly when navigating from the index.
    initialData: () => qc.getQueryData<Series[]>(libraryKeys.series.list())?.find((s) => s.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(libraryKeys.series.list())?.dataUpdatedAt,
  });
}

export function useEpisodes(seriesId: number) {
  return useQuery({ queryKey: libraryKeys.series.episodes(seriesId), queryFn: () => libraryApi.episodes.list({ seriesId }) });
}

export function useSeriesFiles(seriesId: number) {
  return useQuery({ queryKey: libraryKeys.series.files(seriesId), queryFn: () => libraryApi.mediaFiles.list({ seriesId }) });
}

export function useMovieList() {
  return useQuery({ queryKey: libraryKeys.movie.list(), queryFn: () => libraryApi.movies.list() });
}

export function useMovie(id: number) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: libraryKeys.movie.detail(id),
    queryFn: () => libraryApi.movies.get(id),
    initialData: () => qc.getQueryData<Movie[]>(libraryKeys.movie.list())?.find((m) => m.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(libraryKeys.movie.list())?.dataUpdatedAt,
  });
}

export function useMovieFiles(movieId: number) {
  return useQuery({ queryKey: libraryKeys.movie.files(movieId), queryFn: () => libraryApi.mediaFiles.list({ movieId }) });
}

export function useRootFolders() {
  return useQuery({ queryKey: libraryKeys.library.rootFolders, queryFn: libraryApi.rootFolders.list });
}

export function useTags() {
  return useQuery({ queryKey: libraryKeys.library.tags, queryFn: libraryApi.tags.list, staleTime: 60_000 });
}

/** Series and movie profiles (the `video` domain): what the series/movie dialogs offer. */
export function useQualityProfiles() {
  return useQuery({ queryKey: libraryKeys.qualityProfiles, queryFn: () => profilesApi.quality.list('video'), staleTime: 60_000 });
}

export type WantedPage = WantedEpisodesPage | WantedMoviesPage;

/** `q`: the page's text search (blank = every row). */
export function useMissing(kind: 'episodes' | 'movies', page: number, pageSize = 50, enabled = true, q = '', release: WantedReleaseFilter = {}) {
  return useQuery({
    enabled,
    queryKey: libraryKeys.wanted.missing(kind, page, pageSize, q, release),
    queryFn: (): Promise<WantedPage> =>
      kind === 'episodes'
        ? libraryApi.wanted.missingEpisodes({ page, pageSize, q: q || undefined, ...release })
        : libraryApi.wanted.missingMovies({ page, pageSize, q: q || undefined, ...release }),
    placeholderData: keepPreviousData,
  });
}

/** Cutoff-unmet lists: items with a file below their profile's cutoff (GET /wanted/cutoff/*). */
export function useCutoffUnmet(kind: 'episodes' | 'movies', page: number, pageSize = 50, enabled = true, q = '', release: WantedReleaseFilter = {}) {
  return useQuery({
    enabled,
    queryKey: libraryKeys.wanted.cutoff(kind, page, pageSize, q, release),
    queryFn: (): Promise<WantedPage> =>
      kind === 'episodes'
        ? libraryApi.wanted.cutoffEpisodes({ page, pageSize, q: q || undefined, ...release })
        : libraryApi.wanted.cutoffMovies({ page, pageSize, q: q || undefined, ...release }),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------------------
// Optimistic helpers
// ---------------------------------------------------------------------------------------

type Snapshot = Array<[QueryKey, unknown]>;

/**
 * Apply `update` to the cached query at `key` (or, with `exact: false`, every query under it),
 * returning a snapshot for rollback. Exact by default: detail keys prefix their episode keys.
 */
export async function patchQueries<T>(qc: QueryClient, key: QueryKey, update: (data: T) => T, exact = true): Promise<Snapshot> {
  await qc.cancelQueries({ queryKey: key, exact });
  const snapshot = qc.getQueriesData<T>({ queryKey: key, exact });
  for (const [key, data] of snapshot) {
    if (data !== undefined) qc.setQueryData<T>(key, update(data));
  }
  return snapshot;
}

function rollback(qc: QueryClient, snapshot: Snapshot | undefined) {
  for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
}

function replaceIn<T extends { id: number }>(items: T[] | undefined, next: T): T[] | undefined {
  return items?.map((x) => (x.id === next.id ? next : x));
}

function storeSeries(qc: QueryClient, series: Series) {
  qc.setQueryData(libraryKeys.series.detail(series.id), series);
  qc.setQueryData<Series[]>(libraryKeys.series.list(), (prev) => replaceIn(prev, series));
}

function storeMovie(qc: QueryClient, movie: Movie) {
  qc.setQueryData(libraryKeys.movie.detail(movie.id), movie);
  qc.setQueryData<Movie[]>(libraryKeys.movie.list(), (prev) => replaceIn(prev, movie));
}

/** Pure helper for the optimistic season toggle (exported for tests). */
export function withSeasonMonitored(series: Series, seasonNumber: number, monitored: boolean): Series {
  return { ...series, seasons: series.seasons.map((s) => (s.seasonNumber === seasonNumber ? { ...s, monitored } : s)) };
}

// ---------------------------------------------------------------------------------------
// Series mutations
// ---------------------------------------------------------------------------------------

export function useSetSeriesMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, monitored }: { id: number; monitored: boolean }) => libraryApi.series.update(id, { monitored }),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onMutate: async ({ id, monitored }) => {
      const a = await patchQueries<Series>(qc, libraryKeys.series.detail(id), (s) => ({ ...s, monitored }));
      const b = await patchQueries<Series[]>(qc, libraryKeys.series.list(), (list) =>
        list.map((s) => (s.id === id ? { ...s, monitored } : s)),
      );
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => rollback(qc, snapshot),
    onSuccess: (series) => storeSeries(qc, series),
  });
}

export function useSetSeasonMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ seriesId, seasonNumber, monitored }: { seriesId: number; seasonNumber: number; monitored: boolean }) =>
      libraryApi.series.setSeasonMonitored(seriesId, seasonNumber, monitored),
    meta: { errorTitle: t('hooks.library.couldNotChangeSeasonMonitoring') },
    onMutate: async ({ seriesId, seasonNumber, monitored }) => {
      const a = await patchQueries<Series>(qc, libraryKeys.series.detail(seriesId), (s) =>
        withSeasonMonitored(s, seasonNumber, monitored),
      );
      const b = await patchQueries<Episode[]>(qc, libraryKeys.series.episodes(seriesId), (eps) =>
        eps.map((e) => (e.seasonNumber === seasonNumber ? { ...e, monitored } : e)),
      );
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => rollback(qc, snapshot),
    onSuccess: (series) => {
      storeSeries(qc, series);
      void qc.invalidateQueries({ queryKey: libraryKeys.series.episodes(series.id) });
    },
  });
}

export function useSetEpisodeMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ episodeId, monitored }: { seriesId: number; episodeId: number; monitored: boolean }) =>
      libraryApi.episodes.setMonitored(episodeId, monitored),
    meta: { errorTitle: t('hooks.library.couldNotChangeEpisodeMonitoring') },
    onMutate: ({ seriesId, episodeId, monitored }) =>
      patchQueries<Episode[]>(qc, libraryKeys.series.episodes(seriesId), (eps) =>
        eps.map((e) => (e.id === episodeId ? { ...e, monitored } : e)),
      ),
    onError: (_e, _v, snapshot) => rollback(qc, snapshot),
    onSuccess: (episode) => {
      qc.setQueryData<Episode[]>(libraryKeys.series.episodes(episode.seriesId), (prev) => replaceIn(prev, episode));
      void qc.invalidateQueries({ queryKey: libraryKeys.series.detail(episode.seriesId), exact: true });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

export function useAddSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddSeriesRequest) => libraryApi.series.add(body),
    meta: { silent: true },
    onSuccess: (series) => {
      qc.setQueryData(libraryKeys.series.detail(series.id), series);
      void qc.invalidateQueries({ queryKey: libraryKeys.series.lists });
    },
  });
}

export function useUpdateSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateSeriesRequest }) => libraryApi.series.update(id, body),
    meta: { errorTitle: t('hooks.library.couldNotSaveSeries') },
    onSuccess: (series) => storeSeries(qc, series),
  });
}

export function useBulkUpdateSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkSeriesUpdateRequest) => libraryApi.series.bulk(body),
    meta: { errorTitle: t('hooks.library.couldNotUpdateSeries') },
    onSuccess: (list) => {
      for (const s of list) storeSeries(qc, s);
      void qc.invalidateQueries({ queryKey: libraryKeys.series.all });
    },
  });
}

export function useDeleteSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, ...opts }: { ids: number[] } & DeleteMediaOptions) => {
      // No bulk delete route: delete one by one so a failure stops the batch.
      for (const id of ids) await libraryApi.series.remove(id, opts);
    },
    meta: { errorTitle: t('hooks.library.couldNotDeleteSeries') },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: libraryKeys.series.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Movie mutations
// ---------------------------------------------------------------------------------------

export function useSetMovieMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, monitored }: { id: number; monitored: boolean }) => libraryApi.movies.update(id, { monitored }),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onMutate: async ({ id, monitored }) => {
      const a = await patchQueries<Movie>(qc, libraryKeys.movie.detail(id), (m) => ({ ...m, monitored }));
      const b = await patchQueries<Movie[]>(qc, libraryKeys.movie.list(), (list) =>
        list.map((m) => (m.id === id ? { ...m, monitored } : m)),
      );
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => rollback(qc, snapshot),
    onSuccess: (movie) => storeMovie(qc, movie),
  });
}

export function useAddMovie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddMovieRequest) => libraryApi.movies.add(body),
    meta: { silent: true },
    onSuccess: (movie) => {
      qc.setQueryData(libraryKeys.movie.detail(movie.id), movie);
      void qc.invalidateQueries({ queryKey: libraryKeys.movie.lists });
    },
  });
}

export function useUpdateMovie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateMovieRequest }) => libraryApi.movies.update(id, body),
    meta: { errorTitle: t('hooks.library.couldNotSaveMovie') },
    onSuccess: (movie) => storeMovie(qc, movie),
  });
}

export function useBulkUpdateMovies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkMovieUpdateRequest) => libraryApi.movies.bulk(body),
    meta: { errorTitle: t('hooks.library.couldNotUpdateMovies') },
    onSuccess: (list) => {
      for (const m of list) storeMovie(qc, m);
      void qc.invalidateQueries({ queryKey: libraryKeys.movie.all });
    },
  });
}

export function useDeleteMovies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, ...opts }: { ids: number[] } & DeleteMediaOptions) => {
      for (const id of ids) await libraryApi.movies.remove(id, opts);
    },
    meta: { errorTitle: t('hooks.library.couldNotDeleteMovie') },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: libraryKeys.movie.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Files and tags
// ---------------------------------------------------------------------------------------

export function useDeleteMediaFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId }: { fileId: number; mediaType: 'series' | 'movie'; ownerId: number }) =>
      libraryApi.mediaFiles.remove(fileId, true),
    meta: { errorTitle: t('hooks.library.couldNotDeleteFile') },
    onSettled: (_r, _e, { mediaType, ownerId }) => {
      void qc.invalidateQueries({
        queryKey: mediaType === 'series' ? libraryKeys.series.detail(ownerId) : libraryKeys.movie.detail(ownerId),
      });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/**
 * "Allow upgrades again" on a file kept by choice ("Grab anyway"): video files by id, audio files
 * by id (the server clears the whole album / book). Refetches the owner, the wanted lists and the
 * audio pages.
 */
export function useAllowUpgrades() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: 'video'; fileId: number; mediaType: 'series' | 'movie'; ownerId: number } | { kind: 'audio'; fileId: number }): Promise<void> => {
      if (input.kind === 'video') await libraryApi.mediaFiles.clearGrabOverride(input.fileId);
      else await libraryApi.audioFiles.clearGrabOverride(input.fileId);
    },
    meta: { errorTitle: t('hooks.library.couldNotAllowUpgrades') },
    onSettled: (_r, _e, input) => {
      if (input.kind === 'video') {
        void qc.invalidateQueries({ queryKey: input.mediaType === 'series' ? libraryKeys.series.detail(input.ownerId) : libraryKeys.movie.detail(input.ownerId) });
      } else {
        void qc.invalidateQueries({ queryKey: musicKeys.all });
        void qc.invalidateQueries({ queryKey: audiobookKeys.all });
      }
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => libraryApi.tags.create(label),
    meta: { errorTitle: t('hooks.library.couldNotCreateTag') },
    onSuccess: () => void qc.invalidateQueries({ queryKey: libraryKeys.library.tags }),
  });
}

// ---------------------------------------------------------------------------------------
// Searches and grabs (releases module)
// ---------------------------------------------------------------------------------------

/** Turns a 404 from a route still being built into a readable message. */
function notYet(feature: string) {
  return (err: unknown): never => {
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(t('hooks.library.notAvailableYet', { feature, path: err.path }));
    }
    throw err;
  };
}

export type ReleaseSearchTarget = { episodeId: number } | { seriesId: number; seasonNumber?: number } | { movieId: number };

/** Automatic search: POST /command/search. Reports the outcome as a toast. */
export function useAutomaticSearch() {
  const toast = useToastStore();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SearchCommandRequest) => libraryApi.command.search(body).catch(notYet(t('hooks.library.automaticSearch'))),
    meta: { errorTitle: t('common.searchFailed') },
    // "Last searched" lines change even when nothing was grabbed (no release event then).
    onSettled: () => void qc.invalidateQueries({ queryKey: searchStatusKeys.all }),
    onSuccess: (r) =>
      toast.push({
        tone: r.grabbed.length > 0 ? 'ok' : 'info',
        title: r.grabbed.length > 0 ? t('hooks.library.grabbedReleases', { grabbedCount: r.grabbed.length }) : t('hooks.library.searchFinished'),
        message: [
          t('hooks.library.releasesFoundApprovedApprovedValue', { releases: r.releases, approved: r.approved, value: r.pending ? ` · ${r.pending} pending` : '' }),
          // Items of the search that are not out yet were left out by the server.
          ...(r.skippedUnreleased ? [t('bulk.toast.skippedUnreleased', { count: r.skippedUnreleased })] : []),
        ].join(' · '),
      }),
  });
}

export type RefreshTarget = { seriesId: number } | { movieId: number };

/**
 * Metadata refresh of one item: POST /command/refresh. Raises a "started" toast for the job
 * (its outcome arrives as a `job` event) and refetches the item.
 */
export function useRefreshMedia() {
  const qc = useQueryClient();
  const toast = useToastStore();
  return useMutation({
    mutationFn: ({ target, rescan = false }: { target: RefreshTarget; rescan?: boolean }) => libraryApi.command.refresh({ ...target, rescan }),
    meta: { errorTitle: t('hooks.library.couldNotStartRefresh') },
    onSuccess: (job, { target, rescan }) => {
      toast.push({
        tone: 'ok',
        title: rescan ? t('hooks.library.refreshAndScanStarted') : t('hooks.library.refreshStarted'),
        message: t('hooks.library.runIdIsStatus', { id: job.id, status: job.status }),
        durationMs: 4_000,
      });
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: 'seriesId' in target ? libraryKeys.series.detail(target.seriesId) : libraryKeys.movie.detail(target.movieId) });
    },
  });
}

/** Interactive search: GET /release for one target. Only runs while `target` is set. */
export function useInteractiveSearch(target: ReleaseSearchTarget | null) {
  return useQuery({
    queryKey: libraryKeys.releases(target),
    queryFn: () => libraryApi.releases.search(target ?? {}).catch(notYet(t('hooks.library.interactiveSearch'))),
    enabled: target !== null,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnMount: 'always',
  });
}

export function useGrabRelease() {
  const qc = useQueryClient();
  const toast = useToastStore();
  return useMutation({
    mutationFn: (body: ReleaseGrabRequest) => libraryApi.releases.grab(body).catch(notYet(t('hooks.library.grabbing'))),
    meta: { errorTitle: t('hooks.library.grabFailed') },
    onSuccess: (r) => {
      toast.push({ tone: 'ok', title: t('common.grabbed'), message: r.title });
      void qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}
