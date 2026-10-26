import { hasAnyPermission, type DiscoverSliderType, type IssueType, type MediaStatus, type RequestStatus } from '@media-tron/shared';
import type { BadgeTone } from '../../components/badge.js';
import { useAuth } from '../../auth/auth-context.js';

// Labels and tones for request/availability states, shared by every requests page.

export interface StatusMeta {
  label: string;
  tone: BadgeTone;
}

export const MEDIA_STATUS_META: Record<MediaStatus, StatusMeta> = {
  unknown: { label: 'Not requested', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'warning' },
  processing: { label: 'Processing', tone: 'info' },
  partiallyAvailable: { label: 'Partially available', tone: 'info' },
  available: { label: 'Available', tone: 'ok' },
};

export const REQUEST_STATUS_META: Record<RequestStatus, StatusMeta> = {
  pending: { label: 'Pending approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  declined: { label: 'Declined', tone: 'error' },
  failed: { label: 'Failed', tone: 'error' },
  completed: { label: 'Completed', tone: 'ok' },
};

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  video: 'Video',
  audio: 'Audio',
  subtitles: 'Subtitles',
  other: 'Other',
};

/**
 * The badge a poster card shows: library availability wins; otherwise a pending request
 * shows as "Requested". null when there is nothing to say.
 */
export function availabilityBadge(mediaStatus: MediaStatus, requestStatus?: RequestStatus | null): StatusMeta | null {
  if (mediaStatus !== 'unknown') return mediaStatus === 'pending' ? { label: 'Requested', tone: 'warning' } : MEDIA_STATUS_META[mediaStatus];
  if (requestStatus === 'pending') return { label: 'Requested', tone: 'warning' };
  if (requestStatus === 'approved') return { label: 'Processing', tone: 'info' };
  return null;
}

/** Titles for built-in sliders (the api stores null titles for them). */
export const SLIDER_LABELS: Record<DiscoverSliderType, string> = {
  recentlyAdded: 'Recently added',
  recentRequests: 'Recent requests',
  watchlist: 'Your watchlist',
  trending: 'Trending',
  popularMovies: 'Popular movies',
  movieGenres: 'Movie genres',
  upcomingMovies: 'Upcoming movies',
  studios: 'Studios',
  popularTv: 'Popular series',
  tvGenres: 'Series genres',
  upcomingTv: 'Upcoming series',
  networks: 'Networks',
  tmdbMovieKeyword: 'Movies by keyword',
  tmdbMovieGenre: 'Movies by genre',
  tmdbTvKeyword: 'Series by keyword',
  tmdbTvGenre: 'Series by genre',
  tmdbSearch: 'Search results',
  tmdbStudio: 'Studio',
  tmdbNetwork: 'Network',
};

/** Custom slider types an admin can add, with what their `data` holds. */
export const CUSTOM_SLIDER_TYPES: ReadonlyArray<{ type: DiscoverSliderType; dataLabel: string }> = [
  { type: 'tmdbMovieKeyword', dataLabel: 'TMDB keyword ids (comma separated)' },
  { type: 'tmdbTvKeyword', dataLabel: 'TMDB keyword ids (comma separated)' },
  { type: 'tmdbMovieGenre', dataLabel: 'TMDB movie genre id' },
  { type: 'tmdbTvGenre', dataLabel: 'TMDB series genre id' },
  { type: 'tmdbStudio', dataLabel: 'TMDB studio id' },
  { type: 'tmdbNetwork', dataLabel: 'TMDB network id' },
  { type: 'tmdbSearch', dataLabel: 'Search text' },
];

/** Permission check against the signed-in user (admins and unavailable auth pass). */
export function usePermissions(): { userId: number | null; can: (...wanted: number[]) => boolean } {
  const { user, isAdmin } = useAuth();
  return {
    userId: user?.id ?? null,
    can: (...wanted) => isAdmin || hasAnyPermission(user?.permissions ?? 0, wanted),
  };
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function seasonsLabel(seasons: ReadonlyArray<{ seasonNumber: number }>): string {
  if (seasons.length === 0) return '';
  const nums = seasons.map((s) => s.seasonNumber).sort((a, b) => a - b);
  return nums.map((n) => (n === 0 ? 'Specials' : `S${n}`)).join(', ');
}
