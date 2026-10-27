import { Cron } from 'croner';
import type { ReleaseRejection, SearchOutcome } from '@arclight/shared';

// Pure helpers behind GET /release/searchstatus: the per-item back-off of the scheduled
// searches, a simulation of the upcoming runs (which run reaches which item, given the per-run
// limit), and what one search did for each item it covered.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Back-off grows by a day per automatic search without a grab, up to this many days. */
export const SEARCH_BACKOFF_MAX_DAYS = 7;
/** How far ahead next-search estimates look. */
export const SEARCH_PLAN_HORIZON_MS = 14 * DAY;
/** Upper bound on the runs simulated within the horizon (an every-minute cron stays cheap). */
const MAX_PLANNED_RUNS = 500;

export interface SearchStateLike {
  lastSearchedAt: string;
  searchCount: number;
}

/** Wait after `searchCount` automatic searches without a grab: one day each, at most a week. */
export function searchBackoffMs(searchCount: number): number {
  return Math.min(Math.max(searchCount, 1), SEARCH_BACKOFF_MAX_DAYS) * DAY;
}

/**
 * Earliest moment (epoch ms) the scheduled searches take the item again; -Infinity when it was
 * never searched (or a grab cleared its state). A minute of slack keeps a daily job from
 * skipping an item searched by the previous run a few seconds "too late".
 */
export function searchDueAt(state: SearchStateLike | undefined): number {
  if (!state) return Number.NEGATIVE_INFINITY;
  return Date.parse(state.lastSearchedAt) + searchBackoffMs(state.searchCount) - MINUTE;
}

export function isSearchDue(state: SearchStateLike | undefined, now: number): boolean {
  return now >= searchDueAt(state);
}

/** Run times of `cron` after `from` within the planning horizon. Invalid crons yield none. */
export function upcomingRuns(cron: string, from: Date, horizonMs = SEARCH_PLAN_HORIZON_MS): Date[] {
  let job: Cron | undefined;
  try {
    job = new Cron(cron, { paused: true });
    const end = from.getTime() + horizonMs;
    return job.nextRuns(MAX_PLANNED_RUNS, from).filter((d) => d.getTime() <= end);
  } catch {
    return [];
  } finally {
    job?.stop();
  }
}

export interface PlannedSearch {
  /** The run that reaches the item; null when none within the simulated runs. */
  at: Date | null;
  /** Runs at which the item was due but the per-run limit had been reached. */
  runsAhead: number;
}

/**
 * Which upcoming run searches each item. Mirrors the jobs: at every run, the items whose
 * back-off has passed are taken in list order, at most `limit` of them. Assumes nothing is
 * grabbed, added or changed meanwhile, so it is an estimate that gets better the closer it is.
 */
export function planSearchRuns(
  items: ReadonlyArray<{ id: number; dueAt: number }>,
  runs: readonly Date[],
  limit: number,
): Map<number, PlannedSearch> {
  const out = new Map<number, PlannedSearch>();
  let remaining = items.map((item) => ({ ...item, skipped: 0 }));
  for (const run of runs) {
    if (remaining.length === 0) break;
    const at = run.getTime();
    let taken = 0;
    const next: typeof remaining = [];
    for (const item of remaining) {
      if (item.dueAt > at) {
        next.push(item);
      } else if (taken < limit) {
        taken++;
        out.set(item.id, { at: run, runsAhead: item.skipped });
      } else {
        item.skipped++;
        next.push(item);
      }
    }
    remaining = next;
  }
  for (const item of remaining) out.set(item.id, { at: null, runsAhead: item.skipped });
  return out;
}

/** The parts of a release decision an outcome is computed from. */
export interface OutcomeDecision {
  title: string;
  approved: boolean;
  rejections: readonly Pick<ReleaseRejection, 'message'>[];
  movieId?: number | undefined;
  episodeIds?: readonly number[] | undefined;
  seriesId?: number | undefined;
}

export interface ItemOutcome {
  outcome: SearchOutcome;
  releases: number;
  approved: number;
  detail: string | null;
}

/**
 * What one search did for each searched item. A release counts for an item when it maps to
 * it; releases that mapped to nothing (unparseable, unknown title) count for every item, so
 * "all rejected: unknown series" shows instead of "nothing found".
 */
export function itemOutcomes<D extends OutcomeDecision>(
  kind: 'episode' | 'movie',
  itemIds: readonly number[],
  decisions: readonly D[],
  grabbed: ReadonlySet<D>,
  pending: ReadonlySet<D>,
): Map<number, ItemOutcome> {
  const unmatched = decisions.filter((d) => d.movieId === undefined && d.seriesId === undefined && !(d.episodeIds?.length ?? 0));
  const out = new Map<number, ItemOutcome>();
  for (const id of itemIds) {
    const own = decisions.filter((d) => (kind === 'movie' ? d.movieId === id : (d.episodeIds ?? []).includes(id)));
    const relevant = [...own, ...unmatched];
    const approved = relevant.filter((d) => d.approved).length;
    const base = { releases: relevant.length, approved };
    const hit = own.find((d) => grabbed.has(d));
    const held = own.find((d) => pending.has(d));
    if (hit) out.set(id, { ...base, outcome: 'grabbed', detail: hit.title });
    else if (held) out.set(id, { ...base, outcome: 'pending', detail: held.title });
    else if (approved > 0) out.set(id, { ...base, outcome: 'found', detail: null });
    else if (relevant.length > 0) out.set(id, { ...base, outcome: 'rejected', detail: topRejection(relevant) });
    else out.set(id, { ...base, outcome: 'noResults', detail: null });
  }
  return out;
}

/** The most common first rejection message (ties: the one seen first). */
export function topRejection(decisions: readonly Pick<OutcomeDecision, 'rejections'>[]): string | null {
  const counts = new Map<string, number>();
  for (const d of decisions) {
    const message = d.rejections[0]?.message;
    if (message) counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [message, n] of counts) {
    if (n > bestCount) {
      best = message;
      bestCount = n;
    }
  }
  return best;
}
