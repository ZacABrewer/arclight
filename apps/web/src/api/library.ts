import {
  CalendarFeedInfo,
  CalendarItem,
  Episode,
  ImportExclusion,
  Job,
  LibraryStatistics,
  MediaFile,
  Movie,
  ReleaseGrabResponse,
  ReleaseSearchResponse,
  RootFolder,
  SearchCommandResponse,
  Series,
  Tag,
  WantedEpisodesPage,
  WantedMoviesPage,
  type AddMovieRequest,
  type AddRootFolderRequest,
  type AddSeriesRequest,
  type BulkMovieUpdateRequest,
  type BulkSeriesUpdateRequest,
  type EpisodeListQuery,
  type MovieListQuery,
  type PageQuery,
  type RefreshCommand,
  type ReleaseGrabRequest,
  type SearchCommandRequest,
  type SeriesListQuery,
  type UpdateMovieRequest,
  type UpdateSeriesRequest,
  type WantedEpisodesQuery,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Paths mirror apps/api/src/modules/library/routes.ts. Input types are the shared request
// schemas' inferred (output) types, so defaulted fields are written out by the caller.

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

export interface DeleteMediaOptions {
  deleteFiles?: boolean;
  addExclusion?: boolean;
}

/**
 * Routes that have no contract yet. The UI shows a disabled control with an explanatory
 * tooltip while a flag is false.
 */
export const PENDING_FEATURES = {
  /** POST /command/refresh (metadata module) is served. */
  refresh: true,
} as const;

export interface CalendarRange {
  start: string;
  end: string;
  unmonitored?: boolean;
  tags?: readonly number[];
}

export const libraryApi = {
  series: {
    list: (query?: Partial<SeriesListQuery>) => request('/series', Series.array(), { query: q(query) }),
    get: (id: number) => request(`/series/${id}`, Series),
    add: (body: AddSeriesRequest) => request('/series', Series, { method: 'POST', json: body }),
    update: (id: number, body: UpdateSeriesRequest) => request(`/series/${id}`, Series, { method: 'PUT', json: body }),
    bulk: (body: BulkSeriesUpdateRequest) => request('/series/bulk', Series.array(), { method: 'PUT', json: body }),
    setSeasonMonitored: (id: number, seasonNumber: number, monitored: boolean) =>
      request(`/series/${id}/seasons/${seasonNumber}/monitor`, Series, { method: 'PUT', json: { monitored } }),
    remove: (id: number, opts: DeleteMediaOptions = {}) =>
      request(`/series/${id}`, null, {
        method: 'DELETE',
        query: { deleteFiles: opts.deleteFiles ?? false, addExclusion: opts.addExclusion ?? false },
      }),
  },
  episodes: {
    list: (query: Partial<EpisodeListQuery> & { seriesId: number }) =>
      request('/episode', Episode.array(), { query: q(query) }),
    get: (id: number) => request(`/episode/${id}`, Episode),
    setMonitored: (id: number, monitored: boolean) =>
      request(`/episode/${id}`, Episode, { method: 'PUT', json: { monitored } }),
    setManyMonitored: (episodeIds: number[], monitored: boolean) =>
      request('/episode/monitor', Episode.array(), { method: 'PUT', json: { episodeIds, monitored } }),
  },
  movies: {
    list: (query?: Partial<MovieListQuery>) => request('/movie', Movie.array(), { query: q(query) }),
    get: (id: number) => request(`/movie/${id}`, Movie),
    add: (body: AddMovieRequest) => request('/movie', Movie, { method: 'POST', json: body }),
    update: (id: number, body: UpdateMovieRequest) => request(`/movie/${id}`, Movie, { method: 'PUT', json: body }),
    bulk: (body: BulkMovieUpdateRequest) => request('/movie/bulk', Movie.array(), { method: 'PUT', json: body }),
    remove: (id: number, opts: DeleteMediaOptions = {}) =>
      request(`/movie/${id}`, null, {
        method: 'DELETE',
        query: { deleteFiles: opts.deleteFiles ?? false, addExclusion: opts.addExclusion ?? false },
      }),
  },
  mediaFiles: {
    list: (query: { seriesId?: number; movieId?: number; seasonNumber?: number }) =>
      request('/mediafile', MediaFile.array(), { query: q(query) }),
    remove: (id: number, deleteFromDisk = true) =>
      request(`/mediafile/${id}`, null, { method: 'DELETE', query: { deleteFromDisk } }),
  },
  rootFolders: {
    list: () => request('/rootfolder', RootFolder.array()),
    add: (body: AddRootFolderRequest) => request('/rootfolder', RootFolder, { method: 'POST', json: body }),
    remove: (id: number) => request(`/rootfolder/${id}`, null, { method: 'DELETE' }),
  },
  tags: {
    list: () => request('/tag', Tag.array()),
    create: (label: string) => request('/tag', Tag, { method: 'POST', json: { label } }),
  },
  wanted: {
    missingEpisodes: (query?: Partial<WantedEpisodesQuery>) =>
      request('/wanted/missing/episodes', WantedEpisodesPage, { query: q(query) }),
    missingMovies: (query?: Partial<PageQuery>) => request('/wanted/missing/movies', WantedMoviesPage, { query: q(query) }),
    cutoffEpisodes: (query?: Partial<WantedEpisodesQuery>) =>
      request('/wanted/cutoff/episodes', WantedEpisodesPage, { query: q(query) }),
    cutoffMovies: (query?: Partial<PageQuery>) => request('/wanted/cutoff/movies', WantedMoviesPage, { query: q(query) }),
  },
  // Contract: packages/shared/src/calendar.ts (routes built by the calendar module).
  calendar: {
    list: (range: CalendarRange) =>
      request('/calendar', CalendarItem.array(), {
        query: {
          start: range.start,
          end: range.end,
          unmonitored: range.unmonitored ?? false,
          includeSeries: true,
          includeEpisodeFile: true,
          tags: range.tags?.length ? range.tags.join(',') : undefined,
        },
      }),
    feed: () => request('/calendar/feed', CalendarFeedInfo),
    /** Rotates the feed token (admin); the old feed URL stops working. */
    regenerateFeed: () => request('/calendar/feed/regenerate', CalendarFeedInfo, { method: 'POST' }),
  },
  // Contract: packages/shared/src/releases.ts (routes built by the releases module).
  releases: {
    search: (query: { seriesId?: number; seasonNumber?: number; episodeId?: number; movieId?: number }) =>
      request('/release', ReleaseSearchResponse, { query: q(query) }),
    grab: (body: ReleaseGrabRequest) => request('/release', ReleaseGrabResponse, { method: 'POST', json: body }),
  },
  command: {
    search: (body: SearchCommandRequest) =>
      request('/command/search', SearchCommandResponse, { method: 'POST', json: body }),
    /** Re-fetch metadata for one series or movie (`rescan` also re-reads its folder). 202 with the started Job. */
    refresh: (body: { seriesId: number; rescan?: boolean } | { movieId: number; rescan?: boolean }) =>
      request('/command/refresh', Job, { method: 'POST', json: body satisfies Partial<RefreshCommand> }),
  },
  exclusions: {
    list: () => request('/library/exclusions', ImportExclusion.array()),
    remove: (id: number) => request(`/library/exclusions/${id}`, null, { method: 'DELETE' }),
  },
  statistics: () => request('/library/statistics', LibraryStatistics),
};
