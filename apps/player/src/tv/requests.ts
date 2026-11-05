import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { CreateRequest, DiscoverItem, DiscoverPage, MediaRequest, MediaStatus, RequestStatus } from '@arclight/shared';
import { discoverApi, kindOf, requestsApi, type CreateRequestOutcome, type DiscoverKind } from '@web/api/requests';
import { requestKeys } from '@web/hooks/request-keys';
import { usePlaybackCapabilities } from '@web/features/player/api';
import { ApiError, errorMessage } from '../core/api';
import type { Translate } from './format';

// Discover and Requests on the TV (the request portal's discover rows, title page and My
// requests, at stage size). Everything goes through the web's discover / request clients, so the
// app's Bearer token and the server's own permission checks apply; this file holds what the
// screens share: who may request, the rows, the badge a tile shows, and the request calls.

export const DISCOVER_PATH = '/player/discover';
export const REQUESTS_PATH = '/player/requests';
/** Tiles per discover row (one page of results is 20). */
export const DISCOVER_ROW_MAX = 20;

/** The title page of a discover result: /player/discover/movie/603, /player/discover/tv/1399. */
export const discoverTitlePath = (mediaType: 'movie' | 'series', tmdbId: number) => `${DISCOVER_PATH}/${kindOf(mediaType)}/${tmdbId}`;

/**
 * May this account request (GET /playback/me `canRequest`: any request permission, or admin;
 * the web's canRequest). The server already says no for a profile that is not the owner.
 */
export function useCanRequest(): boolean {
  const caps = usePlaybackCapabilities();
  return caps.data?.canRequest === true;
}

/** The Discover screen's rows, in the portal's order. */
export type DiscoverRowId = 'trending' | 'popularMovies' | 'popularTv' | 'upcomingMovies' | 'upcomingTv';
export const DISCOVER_ROWS: readonly DiscoverRowId[] = ['trending', 'popularMovies', 'popularTv', 'upcomingMovies', 'upcomingTv'];

const ROW_FETCH: Record<DiscoverRowId, () => Promise<DiscoverPage>> = {
  trending: () => discoverApi.trending({ mediaType: 'all', timeWindow: 'week' }),
  popularMovies: () => discoverApi.movies(),
  popularTv: () => discoverApi.tv(),
  upcomingMovies: () => discoverApi.upcoming({ mediaType: 'movie' }),
  upcomingTv: () => discoverApi.upcoming({ mediaType: 'tv' }),
};

/** One row's query (the screen runs them side by side with useQueries). */
export function discoverRowQuery(row: DiscoverRowId) {
  return { queryKey: requestKeys.discover.list(`tv:${row}`, null), queryFn: ROW_FETCH[row], staleTime: 10 * 60_000, retry: false } as const;
}

/** Discover search (TV search's "Request it" row when the library has no match). */
export function useDiscoverSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: requestKeys.discover.list('tv:search', q),
    queryFn: () => discoverApi.search(q),
    enabled: enabled && q.length > 0,
    staleTime: 60_000,
    retry: false,
  });
}

export function useDiscoverTitle(kind: DiscoverKind, tmdbId: number) {
  return useQuery({ queryKey: requestKeys.discover.title(kind, tmdbId), queryFn: () => discoverApi.title(kind, tmdbId), enabled: tmdbId > 0, retry: false });
}

/** The signed-in account's own requests, newest first (admins see everyone's without `requestedBy`). */
export function useMyRequests(userId: number | null | undefined) {
  const query = { take: 50, requestedBy: userId ?? undefined, sort: 'added', sortDirection: 'desc' } as const;
  return useQuery({ queryKey: requestKeys.requests.list(query), queryFn: () => requestsApi.list(query), enabled: userId != null, retry: false });
}

/** What a new request asks for: a movie, or every season of a show the library does not have yet. */
export function requestBody(mediaType: 'movie' | 'series', tmdbId: number): CreateRequest {
  return mediaType === 'movie' ? { mediaType, tmdbId } : { mediaType, tmdbId, seasons: 'all' };
}

/** A request changes badges everywhere: the discover rows, the title page, My requests. */
function useRefreshRequests() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: requestKeys.discover.all });
    void qc.invalidateQueries({ queryKey: requestKeys.requests.all });
  }, [qc]);
}

export function useCreateRequest() {
  const refresh = useRefreshRequests();
  return useMutation<CreateRequestOutcome, unknown, { mediaType: 'movie' | 'series'; tmdbId: number }>({
    mutationFn: ({ mediaType, tmdbId }) => requestsApi.create(requestBody(mediaType, tmdbId)),
    onSettled: refresh,
  });
}

export function useCancelRequest() {
  const refresh = useRefreshRequests();
  return useMutation<void, unknown, number>({ mutationFn: (id) => requestsApi.remove(id), onSettled: refresh });
}

/** What a discover tile or title says about a title: in the library, on its way, asked for, or nothing. */
export type DiscoverState = 'available' | 'partial' | 'processing' | 'requested' | 'declined' | null;

/** The portal's poster badge (availabilityBadge): availability wins, then the newest request. */
export function discoverState(item: { mediaStatus: MediaStatus; requestStatus?: RequestStatus | null | undefined }): DiscoverState {
  switch (item.mediaStatus) {
    case 'available':
      return 'available';
    case 'partiallyAvailable':
      return 'partial';
    case 'processing':
      return 'processing';
    case 'pending':
      return 'requested';
    default:
      break;
  }
  if (item.requestStatus === 'pending') return 'requested';
  if (item.requestStatus === 'approved') return 'processing';
  if (item.requestStatus === 'declined') return 'declined';
  return null;
}

export const STATE_KEYS: Record<NonNullable<DiscoverState>, string> = {
  available: 'app.tv.discover.state.available',
  partial: 'app.tv.discover.state.partial',
  processing: 'app.tv.discover.state.processing',
  requested: 'app.tv.discover.state.requested',
  declined: 'app.tv.discover.state.declined',
};

/** The badge's colour: the accent for what you can watch, warm for waiting, red for declined. */
export function stateTone(state: DiscoverState): 'accent' | 'warn' | 'danger' | null {
  if (state === 'available' || state === 'partial') return 'accent';
  if (state === 'requested' || state === 'processing') return 'warn';
  if (state === 'declined') return 'danger';
  return null;
}

/** The library title a discover result is (to open it there), when the server has it. */
export function libraryTarget(item: Pick<DiscoverItem, 'mediaType' | 'mediaStatus' | 'libraryId'>): { kind: 'movie' | 'series'; id: number } | null {
  if (item.mediaStatus !== 'available' && item.mediaStatus !== 'partiallyAvailable') return null;
  // 0: found on the media server only (no Arclight library entry to open).
  if (!item.libraryId || item.libraryId <= 0) return null;
  return { kind: item.mediaType, id: item.libraryId };
}

/** Whether there is still something to ask for: a show only partly in the library can get the rest. */
export function requestable(item: Pick<DiscoverItem, 'mediaStatus' | 'requestStatus'>): boolean {
  const state = discoverState(item);
  return state === null || state === 'declined' || state === 'partial';
}

/** A request's status line on My requests: what the request is waiting for, or where it ended. */
export function requestStateKey(r: Pick<MediaRequest, 'status' | 'mediaStatus'>): string {
  if (r.status === 'declined') return 'app.tv.requests.status.declined';
  if (r.status === 'failed') return 'app.tv.requests.status.failed';
  if (r.mediaStatus === 'available' || r.status === 'completed') return 'app.tv.requests.status.available';
  if (r.mediaStatus === 'partiallyAvailable') return 'app.tv.requests.status.partial';
  if (r.status === 'pending') return 'app.tv.requests.status.pending';
  return 'app.tv.requests.status.processing';
}

export function requestTone(r: Pick<MediaRequest, 'status' | 'mediaStatus'>): 'accent' | 'warn' | 'danger' {
  if (r.status === 'declined' || r.status === 'failed') return 'danger';
  if (r.mediaStatus === 'available' || r.mediaStatus === 'partiallyAvailable' || r.status === 'completed') return 'accent';
  return 'warn';
}

/**
 * A failed request in words: the quota and "not allowed" answers get the TV's own sentence;
 * anything else (already requested, excluded, the server down) shows the server's message.
 */
export function requestErrorText(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && /quota/i.test(err.message)) return t('app.tv.request.quota');
    if (err.status === 403 && /not allowed|permission/i.test(err.message)) return t('app.tv.request.notAllowed');
    if (err.status === 403 && err.message === 'profile-forbidden') return t('app.tv.request.notAllowed');
  }
  const msg = errorMessage(err);
  return msg ? t('app.tv.request.failed', { message: msg }) : t('app.tv.request.failedPlain');
}

/** Opens a discover result's title page. */
export function useOpenDiscover() {
  const navigate = useNavigate();
  return useCallback((item: Pick<DiscoverItem, 'mediaType' | 'tmdbId'>) => void navigate({ to: discoverTitlePath(item.mediaType, item.tmdbId) }), [navigate]);
}
