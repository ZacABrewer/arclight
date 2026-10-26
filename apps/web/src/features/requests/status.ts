import { hasAnyPermission, type DiscoverSliderType, type IssueType, type MediaStatus, type RequestStatus } from '@arclight/shared';
import type { ChipTone } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { formatDateTime as formatPreferredDateTime } from '../../lib/ui-preferences.js';
import { t } from '../../i18n/index.js';

// Labels and tones for request/availability states, shared by every requests page.

export interface StatusMeta {
  label: string;
  tone: ChipTone;
}

export const MEDIA_STATUS_META: Record<MediaStatus, StatusMeta> = {
  unknown: { get label() { return t('features.requests.status.notRequested'); }, tone: 'neutral' },
  pending: { get label() { return t('common.pending'); }, tone: 'warn' },
  processing: { get label() { return t('features.requests.status.processing'); }, tone: 'default' },
  partiallyAvailable: { get label() { return t('features.requests.status.partiallyAvailable'); }, tone: 'default' },
  available: { get label() { return t('common.available'); }, tone: 'accent' },
};

export const REQUEST_STATUS_META: Record<RequestStatus, StatusMeta> = {
  pending: { get label() { return t('features.requests.status.pendingApproval'); }, tone: 'warn' },
  approved: { get label() { return t('common.approved'); }, tone: 'default' },
  declined: { get label() { return t('common.declined'); }, tone: 'danger' },
  failed: { get label() { return t('status.failed'); }, tone: 'danger' },
  completed: { get label() { return t('common.completed'); }, tone: 'accent' },
};

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  get video() {
    return t('features.requests.status.video');
  },
  get audio() {
    return t('features.requests.status.audio');
  },
  get subtitles() {
    return t('common.subtitles');
  },
  get other() {
    return t('features.requests.status.other');
  },
};

/**
 * The badge a poster card shows: library availability wins; otherwise a pending request
 * shows as "Requested". null when there is nothing to say.
 */
export function availabilityBadge(mediaStatus: MediaStatus, requestStatus?: RequestStatus | null): StatusMeta | null {
  if (mediaStatus !== 'unknown') return mediaStatus === 'pending' ? { label: t('common.requested'), tone: 'warn' } : MEDIA_STATUS_META[mediaStatus];
  if (requestStatus === 'pending') return { label: t('common.requested'), tone: 'warn' };
  if (requestStatus === 'approved') return { label: t('features.requests.status.processing'), tone: 'default' };
  if (requestStatus === 'declined') return { label: t('common.declined'), tone: 'danger' };
  return null;
}

/** Titles for built-in sliders (the api stores null titles for them). */
export const SLIDER_LABELS: Record<DiscoverSliderType, string> = {
  get recentlyAdded() {
    return t('features.requests.status.recentlyAdded');
  },
  get recentRequests() {
    return t('features.requests.status.recentRequests');
  },
  get watchlist() {
    return t('features.requests.status.yourWatchlist');
  },
  get trending() {
    return t('common.trending');
  },
  get popularMovies() {
    return t('features.requests.status.popularMovies');
  },
  get movieGenres() {
    return t('features.requests.status.movieGenres');
  },
  get upcomingMovies() {
    return t('features.requests.status.upcomingMovies');
  },
  get studios() {
    return t('features.requests.status.studios');
  },
  get popularTv() {
    return t('features.requests.status.popularSeries');
  },
  get tvGenres() {
    return t('features.requests.status.seriesGenres');
  },
  get upcomingTv() {
    return t('features.requests.status.upcomingSeries');
  },
  get networks() {
    return t('features.requests.status.networks');
  },
  get tmdbMovieKeyword() {
    return t('features.requests.status.moviesByKeyword');
  },
  get tmdbMovieGenre() {
    return t('features.requests.status.moviesByGenre');
  },
  get tmdbTvKeyword() {
    return t('features.requests.status.seriesByKeyword');
  },
  get tmdbTvGenre() {
    return t('features.requests.status.seriesByGenre');
  },
  get tmdbSearch() {
    return t('common.searchResults');
  },
  get tmdbStudio() {
    return t('common.studio');
  },
  get tmdbNetwork() {
    return t('common.network');
  },
  get nowPlaying() {
    return t('features.requests.status.nowPlaying');
  },
  get topRatedMovies() {
    return t('features.requests.status.topRatedMovies');
  },
  get airingTv() {
    return t('features.requests.status.airingSeries');
  },
  get topRatedTv() {
    return t('features.requests.status.topRatedSeries');
  },
  get providers() {
    return t('features.requests.status.streamingServices');
  },
};

/** Custom slider types an admin can add, with what their `data` holds. */
export const CUSTOM_SLIDER_TYPES: ReadonlyArray<{ type: DiscoverSliderType; dataLabel: string }> = [
  { type: 'tmdbMovieKeyword', get dataLabel() { return t('features.requests.status.tmdbKeywordIdsCommaSeparated'); } },
  { type: 'tmdbTvKeyword', get dataLabel() { return t('features.requests.status.tmdbKeywordIdsCommaSeparated'); } },
  { type: 'tmdbMovieGenre', get dataLabel() { return t('features.requests.status.tmdbMovieGenreId'); } },
  { type: 'tmdbTvGenre', get dataLabel() { return t('features.requests.status.tmdbSeriesGenreId'); } },
  { type: 'tmdbStudio', get dataLabel() { return t('features.requests.status.tmdbStudioId'); } },
  { type: 'tmdbNetwork', get dataLabel() { return t('features.requests.status.tmdbNetworkId'); } },
  { type: 'tmdbSearch', get dataLabel() { return t('features.requests.status.searchText'); } },
];

/** Permission check against the signed-in user (admins and unavailable auth pass). */
export function usePermissions(): { userId: number | null; can: (...wanted: number[]) => boolean } {
  const { user, isAdmin } = useAuth();
  return {
    userId: user?.id ?? null,
    can: (...wanted) => isAdmin || hasAnyPermission(user?.permissions ?? 0, wanted),
  };
}

/** Date and time in the signed-in user's preferred format (Settings → General → UI). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatPreferredDateTime(d);
}

export function seasonsLabel(seasons: ReadonlyArray<{ seasonNumber: number }>): string {
  if (seasons.length === 0) return '';
  const nums = seasons.map((s) => s.seasonNumber).sort((a, b) => a - b);
  return nums.map((n) => (n === 0 ? t('common.specials') : `S${n}`)).join(', ');
}
