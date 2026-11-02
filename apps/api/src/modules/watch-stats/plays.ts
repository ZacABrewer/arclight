import type { WatchItemType, WatchPlayMethod } from '@arclight/shared';

// Turns the raw play timeline (watch_events) into plays. The timeline has two kinds of rows:
//
// - session rows (start / progress / stop with a session id) from the Jellyfin plugin: one
//   play per session and item, its watch time from how far the position moved, bounded by the
//   wall-clock time between the first and last row (pausing does not count, skipping ahead is
//   capped by the time that passed);
// - `played` rows from either feed (the sync, a "mark played", a finished plugin session).
//   A played row that falls inside or just after a session of the same account and item only
//   marks that session finished; any other played row is a play of its own whose watch time
//   is the item's runtime (all the sync knows).
//
// Pure functions over plain rows, so the stats, Wrapped and the tests share one definition.

export interface TimelineRow {
  id: number;
  serverId: string;
  mediaServerUserId: number | null;
  type: string;
  at: string;
  itemType: WatchItemType;
  itemKey: string;
  title: string;
  seriesTitle: string | null;
  movieId: number | null;
  seriesId: number | null;
  episodeId: number | null;
  tmdbId: number | null;
  positionMs: number | null;
  durationMs: number | null;
  client: string | null;
  device: string | null;
  playMethod: WatchPlayMethod | null;
  sessionId: string | null;
}

export interface Play {
  serverId: string;
  accountId: number | null;
  itemType: WatchItemType;
  itemKey: string;
  title: string;
  seriesTitle: string | null;
  movieId: number | null;
  seriesId: number | null;
  episodeId: number | null;
  tmdbId: number | null;
  /** When the play started (ISO). */
  at: string;
  watchMs: number;
  client: string | null;
  device: string | null;
  playMethod: WatchPlayMethod | null;
  /** Reached "played" (a played row matched it, or it is a played row). */
  completed: boolean;
  fromSession: boolean;
}

/** A session play shorter than this (and never finished) is a peek, not a play. */
export const MIN_PLAY_MS = 60_000;
/** A gap this long inside one session id starts a new play (a session id reused later). */
const SESSION_GAP_MS = 4 * 60 * 60_000;
/** A played row this long after a session's last row still belongs to it. */
const PLAYED_AFTER_MS = 6 * 60 * 60_000;
const PLAYED_BEFORE_MS = 60 * 60_000;

const SESSION_TYPES = new Set(['start', 'progress', 'stop']);

interface Building {
  rows: TimelineRow[];
  firstMs: number;
  lastMs: number;
}

function sessionPlay(b: Building): Play & { firstMs: number; lastMs: number } {
  const first = b.rows[0]!;
  const positions = b.rows.flatMap((r) => (r.positionMs !== null && r.positionMs >= 0 ? [r.positionMs] : []));
  const posDelta = positions.length > 0 ? Math.max(...positions) - Math.min(...positions) : 0;
  const wall = b.lastMs - b.firstMs;
  let watch = posDelta > 0 && wall > 0 ? Math.min(posDelta, wall) : posDelta > 0 ? posDelta : wall;
  const duration = b.rows.find((r) => r.durationMs !== null && r.durationMs > 0)?.durationMs ?? null;
  if (duration !== null) watch = Math.min(watch, duration);
  const pick = <K extends 'client' | 'device' | 'playMethod'>(k: K): TimelineRow[K] => b.rows.find((r) => r[k] !== null)?.[k] ?? null;
  const known = <K extends 'movieId' | 'seriesId' | 'episodeId' | 'tmdbId' | 'seriesTitle'>(k: K): TimelineRow[K] =>
    b.rows.find((r) => r[k] !== null)?.[k] ?? null;
  return {
    serverId: first.serverId,
    accountId: first.mediaServerUserId,
    itemType: first.itemType,
    itemKey: first.itemKey,
    title: first.title,
    seriesTitle: known('seriesTitle'),
    movieId: known('movieId'),
    seriesId: known('seriesId'),
    episodeId: known('episodeId'),
    tmdbId: known('tmdbId'),
    at: first.at,
    watchMs: Math.max(0, Math.round(watch)),
    client: pick('client'),
    device: pick('device'),
    playMethod: pick('playMethod'),
    completed: false,
    fromSession: true,
    firstMs: b.firstMs,
    lastMs: b.lastMs,
  };
}

/** Plays from timeline rows (any order). Rows of other types (`unplayed`) are ignored. */
export function buildPlays(rows: readonly TimelineRow[]): Play[] {
  const sorted = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
  const open = new Map<string, Building>();
  const sessions: Building[] = [];
  const played: TimelineRow[] = [];
  for (const r of sorted) {
    if (r.type === 'played') {
      played.push(r);
      continue;
    }
    if (!SESSION_TYPES.has(r.type) || !r.sessionId) continue;
    const key = `${r.mediaServerUserId ?? ''}|${r.sessionId}|${r.itemKey}`;
    const ms = Date.parse(r.at);
    let b = open.get(key);
    if (b && (ms - b.lastMs > SESSION_GAP_MS || (r.type === 'start' && b.rows.some((x) => x.type === 'stop')))) {
      b = undefined;
    }
    if (!b) {
      b = { rows: [], firstMs: ms, lastMs: ms };
      open.set(key, b);
      sessions.push(b);
    }
    b.rows.push(r);
    b.lastMs = ms;
  }

  const built = sessions.map(sessionPlay);
  // Index session plays by account + item for the played-row match.
  const byItem = new Map<string, (typeof built)[number][]>();
  for (const p of built) {
    const k = `${p.accountId ?? ''}|${p.itemKey}`;
    const list = byItem.get(k) ?? [];
    list.push(p);
    byItem.set(k, list);
  }
  const out: Play[] = [];
  for (const r of played) {
    const ms = Date.parse(r.at);
    const match = (byItem.get(`${r.mediaServerUserId ?? ''}|${r.itemKey}`) ?? []).find(
      (p) => !p.completed && ms >= p.firstMs - PLAYED_BEFORE_MS && ms <= p.lastMs + PLAYED_AFTER_MS,
    );
    if (match) {
      match.completed = true;
      // A finished session whose position rows were sparse still watched the whole item.
      if (r.durationMs && match.watchMs < r.durationMs * 0.5 && match.lastMs - match.firstMs >= r.durationMs * 0.8) match.watchMs = r.durationMs;
      continue;
    }
    out.push({
      serverId: r.serverId,
      accountId: r.mediaServerUserId,
      itemType: r.itemType,
      itemKey: r.itemKey,
      title: r.title,
      seriesTitle: r.seriesTitle,
      movieId: r.movieId,
      seriesId: r.seriesId,
      episodeId: r.episodeId,
      tmdbId: r.tmdbId,
      at: r.at,
      watchMs: r.durationMs && r.durationMs > 0 ? r.durationMs : 0,
      client: r.client,
      device: r.device,
      playMethod: r.playMethod,
      completed: true,
      fromSession: false,
    });
  }
  for (const p of built) {
    if (!p.completed && p.watchMs < MIN_PLAY_MS) continue;
    const { firstMs: _f, lastMs: _l, ...play } = p;
    out.push(play);
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Local calendar date (YYYY-MM-DD) of an ISO instant, in the process time zone. */
export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
