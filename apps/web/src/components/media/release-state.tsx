import type { ReactNode } from 'react';
import { dateReleaseMs, episodeReleaseMs, isDateReleased, isEpisodeReleased, movieReleaseMs, type Movie } from '@arclight/shared';
import { Banner, Button, Chip, Tooltip } from '../../arclight/index.js';
import { formatDate } from './format.js';
import { t } from '../../i18n/index.js';

// Whether a wanted item is out yet, with the shared rule of packages/shared release-dates.ts
// (the one the api's Wanted lists and searches use): episodes by air time, movies by the date
// that satisfies their minimum availability (the server's `isAvailable`), albums and books by
// release date. Unreleased items are never searched automatically or from a Search button;
// interactive search still may (with a warning).

export interface ReleaseState {
  released: boolean;
  /** The release moment as ISO, or null when unknown. */
  date: string | null;
}

const isoOf = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function episodeReleaseState(e: { airDate?: string | null | undefined; airDateUtc?: string | null | undefined }, now = Date.now()): ReleaseState {
  return { released: isEpisodeReleased(e, now), date: isoOf(episodeReleaseMs(e)) };
}

export function movieReleaseState(m: Pick<Movie, 'isAvailable' | 'status' | 'minimumAvailability' | 'inCinemas' | 'digitalRelease' | 'physicalRelease'>): ReleaseState {
  return { released: m.isAvailable, date: isoOf(movieReleaseMs(m)) };
}

/** Albums and books: their (possibly partial) release date. */
export function dateReleaseState(item: { releaseDate?: string | null | undefined }, now = Date.now()): ReleaseState {
  return { released: isDateReleased(item, now), date: isoOf(dateReleaseMs(item)) };
}

/** "8 Mar 2026" (the UTC day, like the filter's date bounds), or "date unknown". */
export function releaseDateText(date: string | null): string {
  return date ? formatDate(date, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : t('release.dateUnknown');
}

/** "Upcoming · 8 Mar 2026" (future date) or "Not released · date unknown". */
export function UpcomingChip({ date }: { date: string | null }) {
  return (
    <Chip tone="warn" dot="ring">
      {date ? t('release.upcomingOn', { date: releaseDateText(date) }) : t('release.notReleasedNoDate')}
    </Chip>
  );
}

/** Why a Search button is off: the item is not out yet. */
export function unreleasedReason(date: string | null): string {
  return date ? t('release.notReleasedUntil', { date: releaseDateText(date) }) : t('release.notReleasedNoDateHint');
}

/**
 * A row's Search button: disabled with a tooltip while the item is not released (the api would
 * skip it anyway). `allowUnreleased` = the `searchUnreleased` setting is on.
 */
export function ReleaseAwareSearchButton({
  state,
  allowUnreleased = false,
  label,
  onClick,
  children,
}: {
  state: ReleaseState;
  allowUnreleased?: boolean | undefined;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  if (state.released || allowUnreleased) {
    return (
      <Button size="sm" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    );
  }
  return (
    <Tooltip content={unreleasedReason(state.date)}>
      <Button size="sm" aria-label={label} disabled>
        {children}
      </Button>
    </Tooltip>
  );
}

/** Interactive search over an item that is not out yet: allowed, with this warning on top. */
export function UnreleasedSearchNotice({ state }: { state: ReleaseState | null | undefined }) {
  if (!state || state.released) return null;
  return <Banner tone="warn">{state.date ? t('release.interactiveWarning', { date: releaseDateText(state.date) }) : t('release.interactiveWarningNoDate')}</Banner>;
}
