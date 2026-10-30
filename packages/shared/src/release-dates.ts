import { z } from 'zod';

// When a wanted item counts as released, one rule per media type, shared by the Wanted lists
// (GET /wanted/*: `released`, `releasedAfter`, `releasedBefore`), the searches that must not
// look for unreleased items, and the web (the "Upcoming" badge and disabled Search buttons).
//
// The release moment ("release date") per type:
//   episode  the air time (`airDateUtc`), else the start of its `airDate` (UTC)
//   movie    the date that satisfies its minimum availability: `announced` → the earliest known
//            of in cinemas / digital / physical (always released); `inCinemas` → in cinemas;
//            `released` → the earlier of digital / physical, else in cinemas + 90 days
//   album    its release date (MusicBrainz; `YYYY` / `YYYY-MM` count from the period's start)
//   book     its release / publish date (likewise)
// An item without a known release moment is unreleased, except a movie whose coarse status
// already says so (see isMovieReleased).

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** A movie seen only in cinemas counts as released (home release) this long after. */
export const CINEMA_TO_HOME_MS = 90 * DAY_MS;

/** Which rows a Wanted list shows: out now (default), not out yet ("upcoming"), or both. */
export const WantedReleased = z.enum(['released', 'unreleased', 'all']);
export type WantedReleased = z.infer<typeof WantedReleased>;

const ReleaseBound = z
  .string()
  .trim()
  .refine((s) => releaseBoundMs(s, 'after') !== null, { message: 'expected an ISO-8601 date (YYYY-MM-DD) or timestamp' })
  .optional();

/** The release filter every Wanted list query takes (missing and cutoff unmet, every media type). */
export const WantedReleaseFilter = z.object({
  /** `released` (default): out now. `unreleased`: release moment in the future or unknown. `all`: both. */
  released: WantedReleased.optional(),
  /** Only items released on or after this date (a date-only value starts at 00:00 UTC). */
  releasedAfter: ReleaseBound,
  /** Only items released on or before this date (a date-only value covers that whole UTC day). */
  releasedBefore: ReleaseBound,
});
export type WantedReleaseFilter = z.infer<typeof WantedReleaseFilter>;

/**
 * A (possibly partial) calendar date or timestamp in ms: `YYYY`, `YYYY-MM` and `YYYY-MM-DD`
 * count from the start of their period (UTC); anything longer is parsed as an instant.
 */
export function calendarDateMs(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(date);
  if (m) {
    const ms = Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A `releasedAfter` / `releasedBefore` bound in ms. Date-only values are whole UTC days: after
 * = from 00:00, before = up to the end of that day.
 */
export function releaseBoundMs(value: string | null | undefined, edge: 'after' | 'before'): number | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = calendarDateMs(value);
  if (ms === null) return null;
  return dateOnly && edge === 'before' ? ms + DAY_MS - 1 : ms;
}

/**
 * Whether a row passes a Wanted release filter. `releaseMs` is the item's release moment (null =
 * unknown), `released` whether it counts as out now. A date range leaves out undated rows.
 */
export function matchesReleaseFilter(releaseMs: number | null, released: boolean, f: WantedReleaseFilter): boolean {
  const mode = f.released ?? 'released';
  if (mode === 'released' && !released) return false;
  if (mode === 'unreleased' && released) return false;
  const after = releaseBoundMs(f.releasedAfter, 'after');
  const before = releaseBoundMs(f.releasedBefore, 'before');
  if (after === null && before === null) return true;
  if (releaseMs === null) return false;
  return (after === null || releaseMs >= after) && (before === null || releaseMs <= before);
}

/** Whether a release moment has passed, `graceHours` after the fact (automatic searches wait that long). */
export function isReleasedAt(releaseMs: number | null, nowMs: number, graceHours = 0): boolean {
  return releaseMs !== null && releaseMs + graceHours * HOUR_MS <= nowMs;
}

// ---- episodes -------------------------------------------------------------------------

/** An episode's release moment: when it aired (library.ts's episodeAiredMs is this). */
export function episodeReleaseMs(ep: { airDate?: string | null | undefined; airDateUtc?: string | null | undefined }): number | null {
  if (ep.airDateUtc) {
    const ms = Date.parse(ep.airDateUtc);
    if (!Number.isNaN(ms)) return ms;
  }
  if (ep.airDate && /^\d{4}-\d{2}-\d{2}$/.test(ep.airDate)) return calendarDateMs(ep.airDate);
  return null;
}

export function isEpisodeReleased(ep: { airDate?: string | null | undefined; airDateUtc?: string | null | undefined }, nowMs: number, graceHours = 0): boolean {
  return isReleasedAt(episodeReleaseMs(ep), nowMs, graceHours);
}

// ---- movies ---------------------------------------------------------------------------

export interface MovieReleaseFields {
  status: string;
  minimumAvailability: 'announced' | 'inCinemas' | 'released';
  inCinemas?: string | null | undefined;
  digitalRelease?: string | null | undefined;
  physicalRelease?: string | null | undefined;
}

function earliest(...dates: Array<string | null | undefined>): number | null {
  const values = dates.map(calendarDateMs).filter((ms): ms is number => ms !== null);
  return values.length ? Math.min(...values) : null;
}

/** The date that satisfies the movie's minimum availability (see the table at the top); null when unknown. */
export function movieReleaseMs(m: MovieReleaseFields): number | null {
  switch (m.minimumAvailability) {
    case 'announced':
      return earliest(m.inCinemas, m.digitalRelease, m.physicalRelease);
    case 'inCinemas':
      return earliest(m.inCinemas);
    case 'released': {
      const home = earliest(m.digitalRelease, m.physicalRelease);
      if (home !== null) return home;
      const cinema = earliest(m.inCinemas);
      return cinema === null ? null : cinema + CINEMA_TO_HOME_MS;
    }
  }
}

/**
 * Whether a movie is out under its minimum availability. Dates win over the coarse status when
 * known; without dates the status decides (`inCinemas` / `released`). `announced` is always out.
 */
export function isMovieReleased(m: MovieReleaseFields, nowMs: number, graceHours = 0): boolean {
  if (m.status === 'deleted') return false;
  if (m.minimumAvailability === 'announced') return true;
  const ms = movieReleaseMs(m);
  if (ms !== null) return isReleasedAt(ms, nowMs, graceHours);
  return m.minimumAvailability === 'inCinemas' ? m.status === 'inCinemas' || m.status === 'released' : m.status === 'released';
}

// ---- albums and books -----------------------------------------------------------------

/** An album's or book's release moment: its (possibly partial) release date. */
export function dateReleaseMs(item: { releaseDate?: string | null | undefined }): number | null {
  return calendarDateMs(item.releaseDate);
}

/** Album / book: released once its release date has begun. Undated items are not known to be out. */
export function isDateReleased(item: { releaseDate?: string | null | undefined }, nowMs: number, graceHours = 0): boolean {
  return isReleasedAt(dateReleaseMs(item), nowMs, graceHours);
}
