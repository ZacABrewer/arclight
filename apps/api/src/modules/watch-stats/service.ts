import { and, asc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  PlaybackStatsQuery,
  type LibraryGrowth,
  type PlaybackBucket,
  type PlaybackStats,
  type PlaybackTitle,
  type PlaybackUser,
  type Wrapped,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, mediaServerUsers, movies, series, statsSnapshots, users, watchEvents } from '../../db/schema.js';
import { buildPlays, localDay, type Play, type TimelineRow } from './plays.js';

// Playback statistics and Year in review, computed at read time from the watch-history tables
// (read only: other feeds, such as a Plex sync, write the same rows). Accounts map to Arclight
// users through the media-server links, so stats follow a user across servers.

const DAY_MS = 24 * 60 * 60_000;
/** Rows this far before a window still belong to plays that started inside it. */
const LOOKBACK_MS = 6 * 60 * 60_000;
const TOP = 10;

export interface Owner {
  id: number;
  username: string;
  displayName: string | null;
}

export interface WatchStatsServiceOptions {
  db: Db;
  /** Account id -> linked Arclight user (null when unlinked); watch-history's WatchQueries.owners. */
  owners: () => Map<number, Owner | null>;
  now?: () => Date;
}

export class WatchStatsError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'DISABLED' | 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'WatchStatsError';
  }
}

interface Scope {
  /** Accounts to include; null = all. */
  accounts: number[] | null;
  serverId?: string | undefined;
}

interface TitleMeta {
  title: string;
  year: number | null;
  genres: string[];
  tmdbId: number;
}

export class WatchStatsService {
  readonly db: Db;
  private readonly owners: () => Map<number, Owner | null>;
  private readonly now: () => Date;

  constructor(opts: WatchStatsServiceOptions) {
    this.db = opts.db;
    this.owners = opts.owners;
    this.now = opts.now ?? (() => new Date());
  }

  clock(): Date {
    return this.now();
  }

  /** The accounts linked to an Arclight user (any server). */
  accountsOf(userId: number): number[] {
    return [...this.owners()].filter(([, o]) => o?.id === userId).map(([id]) => id);
  }

  /** Plays that started in [fromMs, toMs). */
  plays(fromMs: number, toMs: number, scope: Scope): Play[] {
    if (scope.accounts && scope.accounts.length === 0) return [];
    const where: SQL[] = [
      gte(watchEvents.at, new Date(fromMs - LOOKBACK_MS).toISOString()),
      lt(watchEvents.at, new Date(toMs).toISOString()),
      inArray(watchEvents.type, ['start', 'progress', 'stop', 'played']),
    ];
    if (scope.accounts) where.push(inArray(watchEvents.mediaServerUserId, scope.accounts));
    if (scope.serverId) where.push(eq(watchEvents.serverId, scope.serverId));
    const rows: TimelineRow[] = this.db
      .select({
        id: watchEvents.id,
        serverId: watchEvents.serverId,
        mediaServerUserId: watchEvents.mediaServerUserId,
        type: watchEvents.type,
        at: watchEvents.at,
        itemType: watchEvents.itemType,
        itemKey: watchEvents.itemKey,
        title: watchEvents.title,
        seriesTitle: watchEvents.seriesTitle,
        movieId: watchEvents.movieId,
        seriesId: watchEvents.seriesId,
        episodeId: watchEvents.episodeId,
        tmdbId: watchEvents.tmdbId,
        positionMs: watchEvents.positionMs,
        durationMs: watchEvents.durationMs,
        client: watchEvents.client,
        device: watchEvents.device,
        playMethod: watchEvents.playMethod,
        sessionId: watchEvents.sessionId,
      })
      .from(watchEvents)
      .where(and(...where))
      .orderBy(asc(watchEvents.at), asc(watchEvents.id))
      .all();
    const from = new Date(fromMs).toISOString();
    return buildPlays(rows).filter((p) => p.at >= from);
  }

  // ---- playback stats ------------------------------------------------------------------

  /**
   * GET /watchstats. `userId` null = server-wide. `withUsers` false leaves the most-active list
   * empty (callers that must not see other users' names).
   */
  stats(raw: PlaybackStatsQuery, userId: number | null, opts: { withUsers?: boolean } = {}): PlaybackStats {
    const q = PlaybackStatsQuery.parse(raw);
    const toMs = this.now().getTime();
    // Whole local days: the window starts at local midnight `days - 1` days ago.
    const start = new Date(toMs);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (q.days - 1));
    const fromMs = start.getTime();
    const plays = this.plays(fromMs, toMs, { accounts: userId === null ? null : this.accountsOf(userId), serverId: q.serverId });
    const meta = this.titleMeta(plays);
    const owners = this.owners();

    const perDay = new Map<string, { plays: number; watchMs: number }>();
    for (let d = new Date(fromMs); d.getTime() <= toMs; d.setDate(d.getDate() + 1)) perDay.set(localDay(d), { plays: 0, watchMs: 0 });
    const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const methods = { directPlay: 0, directStream: 0, transcode: 0, unknown: 0 };
    const viewers = new Set<string>();
    for (const p of plays) {
      const d = new Date(p.at);
      const day = perDay.get(localDay(d));
      if (day) {
        day.plays++;
        day.watchMs += p.watchMs;
      }
      heatmap[d.getDay()]![d.getHours()]!++;
      if (p.playMethod === 'DirectPlay') methods.directPlay++;
      else if (p.playMethod === 'DirectStream') methods.directStream++;
      else if (p.playMethod === 'Transcode') methods.transcode++;
      else methods.unknown++;
      viewers.add(viewerKey(p.accountId, owners));
    }
    const titles = groupTitles(plays, meta, owners);
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      userId,
      totals: {
        plays: plays.length,
        watchMs: sum(plays.map((p) => p.watchMs)),
        titles: titles.length,
        users: viewers.size,
        movies: plays.filter((p) => p.itemType === 'movie').length,
        episodes: plays.filter((p) => p.itemType === 'episode').length,
      },
      playMethods: methods,
      topMovies: titles.filter((t) => t.mediaType === 'movie').slice(0, TOP),
      topSeries: titles.filter((t) => t.mediaType === 'series').slice(0, TOP),
      topGenres: genreBuckets(plays, meta).slice(0, TOP),
      clients: buckets(plays, (p) => p.client).slice(0, TOP),
      devices: buckets(plays, (p) => p.device).slice(0, TOP),
      users: opts.withUsers === false ? [] : this.userList(plays, owners).slice(0, 25),
      perDay: [...perDay].map(([date, v]) => ({ date, ...v })),
      heatmap,
    };
  }

  private userList(plays: readonly Play[], owners: Map<number, Owner | null>): PlaybackUser[] {
    const names = this.accountNames(plays.flatMap((p) => (p.accountId !== null ? [p.accountId] : [])));
    const out = new Map<string, PlaybackUser>();
    for (const p of plays) {
      const key = viewerKey(p.accountId, owners);
      let u = out.get(key);
      if (!u) {
        const owner = p.accountId !== null ? (owners.get(p.accountId) ?? null) : null;
        u = {
          key,
          arclightUserId: owner?.id ?? null,
          name: owner ? (owner.displayName ?? owner.username) : p.accountId !== null ? (names.get(p.accountId) ?? `account ${p.accountId}`) : 'unknown',
          plays: 0,
          watchMs: 0,
          lastPlayedAt: null,
        };
        out.set(key, u);
      }
      u.plays++;
      u.watchMs += p.watchMs;
      if (!u.lastPlayedAt || p.at > u.lastPlayedAt) u.lastPlayedAt = p.at;
    }
    return [...out.values()].sort((a, b) => b.watchMs - a.watchMs || b.plays - a.plays);
  }

  private accountNames(ids: number[]): Map<number, string> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    return new Map(
      this.db.select({ id: mediaServerUsers.id, name: mediaServerUsers.name }).from(mediaServerUsers).where(inArray(mediaServerUsers.id, wanted)).all().map((r) => [r.id, r.name]),
    );
  }

  /** Title, year and genres of the movies and series the plays point at. */
  private titleMeta(plays: readonly Play[]): Map<string, TitleMeta> {
    const movieIds = [...new Set(plays.flatMap((p) => (p.movieId !== null ? [p.movieId] : [])))];
    const seriesIds = [...new Set(plays.flatMap((p) => (p.seriesId !== null ? [p.seriesId] : [])))];
    const out = new Map<string, TitleMeta>();
    for (let i = 0; i < movieIds.length; i += 500) {
      for (const m of this.db
        .select({ id: movies.id, title: movies.title, year: movies.year, genres: movies.genres, tmdbId: movies.tmdbId })
        .from(movies)
        .where(inArray(movies.id, movieIds.slice(i, i + 500)))
        .all()) {
        out.set(`movie:${m.id}`, { title: m.title, year: m.year || null, genres: m.genres ?? [], tmdbId: m.tmdbId });
      }
    }
    for (let i = 0; i < seriesIds.length; i += 500) {
      for (const s of this.db
        .select({ id: series.id, title: series.title, year: series.year, genres: series.genres, tmdbId: series.tmdbId })
        .from(series)
        .where(inArray(series.id, seriesIds.slice(i, i + 500)))
        .all()) {
        out.set(`series:${s.id}`, { title: s.title, year: s.year || null, genres: s.genres ?? [], tmdbId: s.tmdbId });
      }
    }
    return out;
  }

  // ---- library growth ------------------------------------------------------------------

  /** Daily storage totals (all root folders) and titles / episode files added per month. */
  growth(days: number): LibraryGrowth {
    const since = new Date(this.now().getTime() - days * DAY_MS);
    const sinceDate = since.toISOString().slice(0, 10);
    const snapshots = this.db
      .select({
        date: statsSnapshots.date,
        usedBytes: sql<number>`sum(${statsSnapshots.usedBytes})`,
        fileCount: sql<number>`sum(${statsSnapshots.fileCount})`,
      })
      .from(statsSnapshots)
      .where(gte(statsSnapshots.date, sinceDate))
      .groupBy(statsSnapshots.date)
      .orderBy(asc(statsSnapshots.date))
      .all()
      .map((r) => ({ date: r.date, usedBytes: Number(r.usedBytes) || 0, fileCount: Number(r.fileCount) || 0 }));

    const sinceIso = since.toISOString();
    const month = (iso: string) => iso.slice(0, 7);
    const added = new Map<string, { movies: number; series: number; episodes: number }>();
    const bump = (iso: string, k: 'movies' | 'series' | 'episodes') => {
      const m = month(iso);
      const row = added.get(m) ?? { movies: 0, series: 0, episodes: 0 };
      row[k]++;
      added.set(m, row);
    };
    for (const r of this.db.select({ added: movies.added }).from(movies).where(gte(movies.added, sinceIso)).all()) bump(r.added, 'movies');
    for (const r of this.db.select({ added: series.added }).from(series).where(gte(series.added, sinceIso)).all()) bump(r.added, 'series');
    for (const r of this.db
      .select({ dateAdded: mediaFiles.dateAdded })
      .from(episodes)
      .innerJoin(mediaFiles, eq(episodes.episodeFileId, mediaFiles.id))
      .where(gte(mediaFiles.dateAdded, sinceIso))
      .all()) {
      bump(r.dateAdded, 'episodes');
    }
    return {
      snapshots,
      added: [...added].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ month: m, ...v })),
    };
  }

  // ---- Year in review ------------------------------------------------------------------

  /** Years (newest first) with any plays for the user. */
  years(userId: number): number[] {
    const accounts = this.accountsOf(userId);
    if (accounts.length === 0) return [];
    return this.db
      .selectDistinct({ y: sql<string>`substr(${watchEvents.at}, 1, 4)` })
      .from(watchEvents)
      .where(and(inArray(watchEvents.mediaServerUserId, accounts), inArray(watchEvents.type, ['start', 'played'])))
      .all()
      .map((r) => Number(r.y))
      .filter((y) => Number.isInteger(y) && y > 1999)
      .sort((a, b) => b - a);
  }

  /** The user's Year in review; `year` defaults to the current year. */
  wrapped(userId: number, year?: number): Wrapped {
    const user = this.db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, userId)).get();
    if (!user) throw new WatchStatsError('NOT_FOUND', `user ${userId} not found`);
    const y = year ?? this.now().getFullYear();
    const fromMs = new Date(y, 0, 1).getTime();
    const toMs = Math.min(new Date(y + 1, 0, 1).getTime(), Math.max(this.now().getTime(), fromMs));
    const owners = this.owners();
    // Everyone's plays: the percentile compares the user with the other viewers.
    const all = this.plays(fromMs, toMs, { accounts: null });
    const mineSet = new Set(this.accountsOf(userId));
    const plays = all.filter((p) => p.accountId !== null && mineSet.has(p.accountId));
    const meta = this.titleMeta(plays);
    const titles = groupTitles(plays, meta, owners);

    const monthly = new Array<number>(12).fill(0);
    const weekday = new Array<number>(7).fill(0);
    const hours = new Array<number>(24).fill(0);
    const days = new Map<string, number>();
    const devices = new Map<string, number>();
    for (const p of plays) {
      const d = new Date(p.at);
      monthly[d.getMonth()]! += p.watchMs;
      weekday[d.getDay()]!++;
      hours[d.getHours()]!++;
      const day = localDay(d);
      days.set(day, (days.get(day) ?? 0) + p.watchMs);
      const device = p.device ?? p.client;
      if (device) devices.set(device, (devices.get(device) ?? 0) + p.watchMs);
    }
    const watchMs = sum(plays.map((p) => p.watchMs));
    const longest = [...days].sort((a, b) => b[1] - a[1])[0];

    const perViewer = new Map<string, number>();
    for (const p of all) {
      const k = viewerKey(p.accountId, owners);
      perViewer.set(k, (perViewer.get(k) ?? 0) + p.watchMs);
    }
    const mineKey = `user:${userId}`;
    const others = [...perViewer].filter(([k]) => k !== mineKey).map(([, v]) => v);
    const percentile = others.length === 0 || plays.length === 0 ? null : Math.round((100 * others.filter((v) => v < watchMs).length) / others.length);

    return {
      year: y,
      userId,
      name: user.displayName ?? user.username,
      plays: plays.length,
      watchMs,
      movies: new Set(plays.filter((p) => p.itemType === 'movie').map((p) => p.itemKey)).size,
      episodes: new Set(plays.filter((p) => p.itemType === 'episode').map((p) => p.itemKey)).size,
      series: titles.filter((t) => t.mediaType === 'series').length,
      activeDays: days.size,
      topMovies: titles.filter((t) => t.mediaType === 'movie').slice(0, 5),
      topSeries: titles.filter((t) => t.mediaType === 'series').slice(0, 5),
      topGenres: genreBuckets(plays, meta).slice(0, 5),
      topDevice: [...devices].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      busiestMonth: watchMs > 0 ? argmax(monthly) + 1 : null,
      favouriteWeekday: plays.length > 0 ? argmax(weekday) : null,
      favouriteHour: plays.length > 0 ? argmax(hours) : null,
      longestDay: longest && longest[1] > 0 ? { date: longest[0], watchMs: longest[1] } : null,
      firstPlay: plays[0] ? { title: displayTitle(plays[0], meta), at: plays[0].at } : null,
      monthly,
      percentile,
      years: [...new Set([y, ...this.years(userId)])].sort((a, b) => b - a),
    };
  }
}

// ---- helpers ---------------------------------------------------------------------------

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
}

export function viewerKey(accountId: number | null, owners: Map<number, Owner | null>): string {
  if (accountId === null) return 'unknown';
  const owner = owners.get(accountId);
  return owner ? `user:${owner.id}` : `account:${accountId}`;
}

/** The movie or series a play counts towards (episodes roll up into their series). */
function titleKey(p: Play): { key: string; mediaType: PlaybackTitle['mediaType'] } {
  if (p.itemType === 'movie') return { key: p.movieId !== null ? `movie:${p.movieId}` : p.itemKey, mediaType: 'movie' };
  if (p.itemType === 'episode' || p.itemType === 'series' || p.itemType === 'season') {
    if (p.seriesId !== null) return { key: `series:${p.seriesId}`, mediaType: 'series' };
    if (p.seriesTitle) return { key: `seriesTitle:${p.seriesTitle.toLowerCase()}`, mediaType: 'series' };
  }
  return { key: p.itemKey, mediaType: 'other' };
}

function displayTitle(p: Play, meta: Map<string, TitleMeta>): string {
  const { key, mediaType } = titleKey(p);
  return meta.get(key)?.title ?? (mediaType === 'series' ? (p.seriesTitle ?? p.title) : p.title);
}

function groupTitles(plays: readonly Play[], meta: Map<string, TitleMeta>, owners: Map<number, Owner | null>): PlaybackTitle[] {
  const out = new Map<string, PlaybackTitle & { viewers: Set<string> }>();
  for (const p of plays) {
    const { key, mediaType } = titleKey(p);
    let t = out.get(key);
    if (!t) {
      const m = meta.get(key);
      t = {
        key,
        mediaType,
        title: displayTitle(p, meta),
        year: m?.year ?? null,
        movieId: mediaType === 'movie' ? p.movieId : null,
        seriesId: mediaType === 'series' ? p.seriesId : null,
        tmdbId: m?.tmdbId ?? (mediaType === 'movie' ? p.tmdbId : null),
        plays: 0,
        watchMs: 0,
        users: 0,
        lastPlayedAt: null,
        viewers: new Set(),
      };
      out.set(key, t);
    }
    t.plays++;
    t.watchMs += p.watchMs;
    t.viewers.add(viewerKey(p.accountId, owners));
    if (!t.lastPlayedAt || p.at > t.lastPlayedAt) t.lastPlayedAt = p.at;
  }
  return [...out.values()]
    .map(({ viewers, ...t }) => ({ ...t, users: viewers.size }))
    .sort((a, b) => b.plays - a.plays || b.watchMs - a.watchMs || a.title.localeCompare(b.title));
}

function genreBuckets(plays: readonly Play[], meta: Map<string, TitleMeta>): PlaybackBucket[] {
  const out = new Map<string, PlaybackBucket>();
  for (const p of plays) {
    for (const g of meta.get(titleKey(p).key)?.genres ?? []) {
      const b = out.get(g) ?? { name: g, plays: 0, watchMs: 0 };
      b.plays++;
      b.watchMs += p.watchMs;
      out.set(g, b);
    }
  }
  return [...out.values()].sort((a, b) => b.watchMs - a.watchMs || b.plays - a.plays);
}

function buckets(plays: readonly Play[], pick: (p: Play) => string | null): PlaybackBucket[] {
  const out = new Map<string, PlaybackBucket>();
  for (const p of plays) {
    const name = pick(p);
    if (!name) continue;
    const b = out.get(name) ?? { name, plays: 0, watchMs: 0 };
    b.plays++;
    b.watchMs += p.watchMs;
    out.set(name, b);
  }
  return [...out.values()].sort((a, b) => b.plays - a.plays || b.watchMs - a.watchMs);
}
