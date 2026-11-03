import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppDeviceCodeApproveResponse,
  PlayerMovieDetails,
  PlayerMoviePage,
  PlayerSeriesDetails,
  PlayerSeriesPage,
  VideoHlsHealth,
  VideoHome,
  VideoSession,
  VideoWatchedResponse,
  type VideoSessionRequest,
  type VideoWatchedRequest,
} from '@arclight/shared';
import { request, type QueryParams } from '../../../api/client.js';
import { t } from '../../../i18n/index.js';
import { browseKeys } from '../browse/api.js';
import { playerKeys } from '../api.js';

// Movies & TV calls (packages/shared/src/playback.ts, "Video" sections):
//   GET  /playback/video/home
//   GET  /playback/movies   | /playback/movies/:id
//   GET  /playback/series   | /playback/series/:id
//   POST /playback/watched              mark played / unplayed
//   POST /playback/video/session        what and how to stream (call again to seek a live stream)
//   DELETE /playback/video/session/:id  end an HLS session now (encoder and slot freed)
//   GET  <session.hls.healthUrl>        encoder speed and advice (signed, no cookie needed)
//   POST /app/device-codes/approve      "Sign in a TV"

export type VideoSort = 'title' | 'added' | 'year' | 'rating';
export type WatchedFilter = 'all' | 'unwatched' | 'watched';

export interface VideoFilters {
  search?: string | undefined;
  sort?: VideoSort | undefined;
  order?: 'asc' | 'desc' | undefined;
  genre?: string | undefined;
  letter?: string | undefined;
  watched?: WatchedFilter | undefined;
}

export const VIDEO_PAGE_SIZE = 60;

function filterQuery(f: VideoFilters, page: number): QueryParams {
  return {
    search: f.search?.trim() || undefined,
    sort: f.sort,
    order: f.order,
    genre: f.genre || undefined,
    letter: f.letter || undefined,
    watched: f.watched && f.watched !== 'all' ? f.watched : undefined,
    page,
    pageSize: VIDEO_PAGE_SIZE,
  };
}

export const videoApi = {
  home: () => request('/playback/video/home', VideoHome),
  movies: (f: VideoFilters, page: number) => request('/playback/movies', PlayerMoviePage, { query: filterQuery(f, page) }),
  movie: (id: number) => request(`/playback/movies/${id}`, PlayerMovieDetails),
  series: (f: VideoFilters, page: number) => request('/playback/series', PlayerSeriesPage, { query: filterQuery(f, page) }),
  show: (id: number) => request(`/playback/series/${id}`, PlayerSeriesDetails),
  watched: (body: VideoWatchedRequest) => request('/playback/watched', VideoWatchedResponse, { method: 'POST', json: body }),
  session: (body: VideoSessionRequest) => request('/playback/video/session', VideoSession, { method: 'POST', json: body }),
  /** Fire and forget; `keepalive` so it still goes out when the tab closes. */
  endSession: (sessionId: string) =>
    void request(`/playback/video/session/${encodeURIComponent(sessionId)}`, null, { method: 'DELETE', keepalive: true }).catch(() => undefined),
  health: async (url: string): Promise<VideoHlsHealth> => {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`health ${res.status}`), { status: res.status });
    return VideoHlsHealth.parse(await res.json());
  },
  approveDeviceCode: (userCode: string) => request('/app/device-codes/approve', AppDeviceCodeApproveResponse, { method: 'POST', json: { userCode } }),
};

// Under the browse prefix, so marking something played refreshes every browse page at once.
export const videoKeys = {
  all: [...browseKeys.all, 'video'] as const,
  home: () => [...browseKeys.all, 'video', 'home'] as const,
  movies: (f: VideoFilters) => [...browseKeys.all, 'video', 'movies', f] as const,
  movie: (id: number) => [...browseKeys.all, 'video', 'movie', id] as const,
  series: (f: VideoFilters) => [...browseKeys.all, 'video', 'series', f] as const,
  show: (id: number) => [...browseKeys.all, 'video', 'show', id] as const,
};

const nextPage = (last: { page: number; pageSize: number; total: number }) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined);

export function useVideoHome() {
  return useQuery({ queryKey: videoKeys.home(), queryFn: videoApi.home });
}

export function useMovies(filters: VideoFilters) {
  return useInfiniteQuery({
    queryKey: videoKeys.movies(filters),
    queryFn: ({ pageParam }) => videoApi.movies(filters, pageParam),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export function useMovie(id: number) {
  return useQuery({ queryKey: videoKeys.movie(id), queryFn: () => videoApi.movie(id), enabled: Number.isFinite(id) && id > 0 });
}

export function useSeriesList(filters: VideoFilters) {
  return useInfiniteQuery({
    queryKey: videoKeys.series(filters),
    queryFn: ({ pageParam }) => videoApi.series(filters, pageParam),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export function useShow(id: number | null | undefined) {
  const ok = typeof id === 'number' && Number.isFinite(id) && id > 0;
  return useQuery({ queryKey: videoKeys.show(ok ? id : 0), queryFn: () => videoApi.show(id ?? 0), enabled: ok });
}

/** Mark items, a season or a whole show played / unplayed, then refresh the pages. */
export function useMarkWatched() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VideoWatchedRequest) => videoApi.watched(body),
    meta: { errorTitle: t('player.video.couldNotMark') },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: browseKeys.all });
      await qc.invalidateQueries({ queryKey: ['playback', 'progress'] });
      await qc.invalidateQueries({ queryKey: playerKeys.continue });
    },
  });
}

export function useApproveDeviceCode() {
  return useMutation({ mutationFn: (userCode: string) => videoApi.approveDeviceCode(userCode), meta: { silent: true } });
}
