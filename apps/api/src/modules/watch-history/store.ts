import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { WatchEventSource, WatchEventType, WatchItemType, WatchPlayMethod } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, movies, series, users } from '../../db/schema.js';
import { mediaServerSyncState, mediaServerUsers, watchEvents, watchState, type MediaServerUserRow, type WatchStateRow } from './schema.js';

// The write side of the watch history, shared by the catch-up sync and the plugin's events:
// server accounts, library matching, play-state upserts that synthesize played/unplayed events
// when Played flips, series/season roll-ups and the deduplicated timeline.

/** Jellyfin ids come with or without dashes (C# Guid vs the REST API); compare them bare. */
export function normaliseExternalId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, '');
}

export interface LinkedUser {
  id: number;
  username: string;
  displayName: string | null;
  localPassword: boolean;
}

/**
 * Arclight users linked to a Jellyfin/Emby account, by `kind:externalId` (normalised). The link
 * lives in users.settings.mediaServerLink; matching is by account id only, never by name.
 */
export function linkedUsers(db: Db): Map<string, LinkedUser> {
  const out = new Map<string, LinkedUser>();
  for (const row of db.select().from(users).all()) {
    const link = ((row.settings ?? {}) as Record<string, unknown>)['mediaServerLink'] as { kind?: unknown; externalId?: unknown } | undefined;
    if (!link || typeof link.kind !== 'string' || typeof link.externalId !== 'string') continue;
    if (link.kind !== 'jellyfin' && link.kind !== 'emby' && link.kind !== 'plex') continue;
    out.set(`${link.kind}:${normaliseExternalId(link.externalId)}`, {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      localPassword: row.localPassword ?? true,
    });
  }
  return out;
}

export interface Ids {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

export interface ResolvedMovie {
  id: number;
  tmdbId: number;
  title: string;
}
export interface ResolvedSeries {
  id: number;
  tmdbId: number;
  tvdbId: number | null;
  title: string;
}

/** Matches server items to the library by provider ids (memoised per instance: one sync run or one event batch). */
export class LibraryResolver {
  private readonly movieMemo = new Map<string, ResolvedMovie | null>();
  private readonly seriesMemo = new Map<string, ResolvedSeries | null>();
  private readonly episodeMemo = new Map<string, number | null>();

  constructor(private readonly db: Db) {}

  movie(ids: Ids): ResolvedMovie | null {
    const key = `${ids.tmdbId}|${ids.imdbId}`;
    if (this.movieMemo.has(key)) return this.movieMemo.get(key)!;
    const pick = { id: movies.id, tmdbId: movies.tmdbId, title: movies.title };
    let row = ids.tmdbId ? this.db.select(pick).from(movies).where(eq(movies.tmdbId, ids.tmdbId)).get() : undefined;
    if (!row && ids.imdbId) row = this.db.select(pick).from(movies).where(eq(movies.imdbId, ids.imdbId)).get();
    const found = row ?? null;
    this.movieMemo.set(key, found);
    return found;
  }

  series(ids: Ids): ResolvedSeries | null {
    const key = `${ids.tvdbId}|${ids.tmdbId}|${ids.imdbId}`;
    if (this.seriesMemo.has(key)) return this.seriesMemo.get(key)!;
    const pick = { id: series.id, tmdbId: series.tmdbId, tvdbId: series.tvdbId, title: series.title };
    let row = ids.tvdbId ? this.db.select(pick).from(series).where(eq(series.tvdbId, ids.tvdbId)).get() : undefined;
    if (!row && ids.tmdbId) row = this.db.select(pick).from(series).where(eq(series.tmdbId, ids.tmdbId)).get();
    if (!row && ids.imdbId) row = this.db.select(pick).from(series).where(eq(series.imdbId, ids.imdbId)).get();
    const found = row ?? null;
    this.seriesMemo.set(key, found);
    return found;
  }

  episode(seriesId: number, seasonNumber: number | null, episodeNumber: number | null): number | null {
    if (seasonNumber === null || episodeNumber === null) return null;
    const key = `${seriesId}:${seasonNumber}:${episodeNumber}`;
    if (this.episodeMemo.has(key)) return this.episodeMemo.get(key)!;
    const row = this.db
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, seasonNumber), eq(episodes.episodeNumber, episodeNumber)))
      .get();
    const found = row?.id ?? null;
    this.episodeMemo.set(key, found);
    return found;
  }
}

/** What an item resolved to in the library (all null and a `jf:` key when it is not there). */
export interface ResolvedItem {
  itemType: WatchItemType;
  itemKey: string;
  movieId: number | null;
  seriesId: number | null;
  episodeId: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  /** Library title of the series (episodes) for display. */
  seriesTitle: string | null;
}

export interface ServerItem {
  jellyfinItemId: string;
  /** Jellyfin type: Movie, Episode, Series, Season, anything else. */
  type: string;
  ids: Ids;
  seriesIds?: Ids | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

/** Resolves a Jellyfin item to its library key. */
export function resolveItem(resolver: LibraryResolver, item: ServerItem): ResolvedItem {
  const none = (itemType: WatchItemType): ResolvedItem => ({
    itemType,
    itemKey: `jf:${item.jellyfinItemId}`,
    movieId: null,
    seriesId: null,
    episodeId: null,
    tmdbId: item.ids.tmdbId,
    tvdbId: item.ids.tvdbId,
    imdbId: item.ids.imdbId,
    seriesTitle: null,
  });
  switch (item.type) {
    case 'Movie': {
      const movie = resolver.movie(item.ids);
      if (!movie) return none('movie');
      return { ...none('movie'), itemKey: `movie:${movie.id}`, movieId: movie.id, tmdbId: movie.tmdbId };
    }
    case 'Series': {
      const show = resolver.series(item.ids);
      if (!show) return none('series');
      return { ...none('series'), itemKey: `series:${show.id}`, seriesId: show.id, tmdbId: show.tmdbId, tvdbId: show.tvdbId, seriesTitle: show.title };
    }
    case 'Season':
    case 'Episode': {
      const type: WatchItemType = item.type === 'Season' ? 'season' : 'episode';
      const show = item.seriesIds ? resolver.series(item.seriesIds) : null;
      if (!show) return { ...none(type), tmdbId: item.seriesIds?.tmdbId ?? null, tvdbId: item.seriesIds?.tvdbId ?? null, imdbId: item.seriesIds?.imdbId ?? null };
      const base = { ...none(type), seriesId: show.id, tmdbId: show.tmdbId, tvdbId: show.tvdbId, imdbId: null, seriesTitle: show.title };
      if (type === 'season') return item.seasonNumber != null ? { ...base, itemKey: `season:${show.id}:${item.seasonNumber}` } : base;
      const episodeId = resolver.episode(show.id, item.seasonNumber ?? null, item.episodeNumber ?? null);
      return episodeId !== null ? { ...base, itemKey: `episode:${episodeId}`, episodeId } : base;
    }
    default:
      return none('other');
  }
}

/** A play-state observation. Absent fields keep the stored value (plugin events are partial). */
export interface StateInput {
  serverId: string;
  mediaServerUserId: number;
  jellyfinItemId: string;
  resolved: ResolvedItem;
  title: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  jellyfinSeriesId?: string | null;
  jellyfinSeasonId?: string | null;
  played?: boolean;
  playCount?: number;
  lastPlayedAt?: string | null;
  positionMs?: number;
  durationMs?: number | null;
  favorite?: boolean;
}

export interface EventInput {
  serverId: string;
  mediaServerUserId: number | null;
  type: WatchEventType;
  at: string;
  resolved: ResolvedItem;
  jellyfinItemId: string | null;
  title: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  positionMs?: number | null;
  durationMs?: number | null;
  client?: string | null;
  device?: string | null;
  playMethod?: WatchPlayMethod | null;
  sessionId?: string | null;
  source: WatchEventSource;
  /** Explicit dedupe key; default: server, user, item, type, time and session. */
  dedupeKey?: string;
}

export interface SeriesMeta {
  title: string;
  resolved: ResolvedItem;
  /** Full reads: episodes present for this account, overall and per season (by Jellyfin season id). */
  totals?: { total: number; seasons: Map<string, { seasonNumber: number | null; total: number }> };
}

/** Episodes worth a row: anything a user did with them. */
function remembered(s: { played: boolean; playCount: number; positionMs: number; favorite: boolean; lastPlayedAt: string | null }): boolean {
  return s.played || s.playCount > 0 || s.positionMs > 0 || s.favorite || s.lastPlayedAt !== null;
}

export class WatchStore {
  constructor(
    readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  iso(): string {
    return this.now().toISOString();
  }

  // ---- accounts --------------------------------------------------------------------------

  account(serverId: string, externalId: string): MediaServerUserRow | undefined {
    return this.db
      .select()
      .from(mediaServerUsers)
      .where(and(eq(mediaServerUsers.serverId, serverId), eq(mediaServerUsers.externalId, normaliseExternalId(externalId))))
      .get();
  }

  /** Plex: the account a server-local id (history, sessions, webhooks) belongs to. */
  accountByLocalId(serverId: string, localId: string): MediaServerUserRow | undefined {
    return (
      this.db
        .select()
        .from(mediaServerUsers)
        .where(and(eq(mediaServerUsers.serverId, serverId), eq(mediaServerUsers.localId, localId)))
        .get() ??
      // Everyone but the Plex owner uses the plex.tv id locally too.
      (localId === '1' ? undefined : this.account(serverId, localId))
    );
  }

  /** The account row, created on first sight (the name, and a Plex local id, are refreshed when given). */
  ensureAccount(serverId: string, externalId: string, name?: string | null, localId?: string): MediaServerUserRow {
    const found = this.account(serverId, externalId);
    const now = this.iso();
    if (found) {
      const patch = { ...(name && name !== found.name ? { name } : {}), ...(localId !== undefined && localId !== found.localId ? { localId } : {}) };
      if (Object.keys(patch).length > 0) {
        return this.db.update(mediaServerUsers).set({ ...patch, updatedAt: now }).where(eq(mediaServerUsers.id, found.id)).returning().get()!;
      }
      return found;
    }
    return this.db
      .insert(mediaServerUsers)
      .values({ serverId, externalId: normaliseExternalId(externalId), name: name || externalId, localId: localId ?? null, firstSeenAt: now, updatedAt: now })
      .returning()
      .get();
  }

  // ---- timeline --------------------------------------------------------------------------

  /** Appends an event; false when an identical one is already stored. */
  recordEvent(e: EventInput): boolean {
    const dedupeKey =
      e.dedupeKey ??
      createHash('sha256')
        .update([e.serverId, e.mediaServerUserId ?? '', e.jellyfinItemId ?? e.resolved.itemKey, e.type, e.at, e.sessionId ?? ''].join('|'))
        .digest('hex');
    const inserted = this.db
      .insert(watchEvents)
      .values({
        serverId: e.serverId,
        mediaServerUserId: e.mediaServerUserId,
        type: e.type,
        at: e.at,
        itemType: e.resolved.itemType,
        itemKey: e.resolved.itemKey,
        jellyfinItemId: e.jellyfinItemId,
        title: e.title,
        seriesTitle: e.resolved.seriesTitle,
        seasonNumber: e.seasonNumber ?? null,
        episodeNumber: e.episodeNumber ?? null,
        movieId: e.resolved.movieId,
        seriesId: e.resolved.seriesId,
        episodeId: e.resolved.episodeId,
        tmdbId: e.resolved.tmdbId,
        positionMs: e.positionMs ?? null,
        durationMs: e.durationMs ?? null,
        client: e.client ?? null,
        device: e.device ?? null,
        playMethod: e.playMethod ?? null,
        sessionId: e.sessionId ?? null,
        source: e.source,
        dedupeKey,
      })
      .onConflictDoNothing({ target: watchEvents.dedupeKey })
      .run();
    return inserted.changes > 0;
  }

  // ---- play state ------------------------------------------------------------------------

  stateRow(mediaServerUserId: number, jellyfinItemId: string): WatchStateRow | undefined {
    return this.db
      .select()
      .from(watchState)
      .where(and(eq(watchState.mediaServerUserId, mediaServerUserId), eq(watchState.jellyfinItemId, jellyfinItemId)))
      .get();
  }

  /**
   * Upserts one item's play state. Movies (and roll-ups) always keep a row; episodes and other
   * items only while there is something to remember. Synthesizes a `played` event when Played
   * turns on or the play count grows (a rewatch), and `unplayed` when it turns off. A first
   * sighting without a play date gets no event (no time to put it at).
   */
  applyState(input: StateInput, opts: { source: WatchEventSource; eventAt?: string; keepEmpty?: boolean }): { changed: boolean; events: number } {
    const prev = this.stateRow(input.mediaServerUserId, input.jellyfinItemId);
    const now = this.iso();
    const next = {
      played: input.played ?? prev?.played ?? false,
      playCount: input.playCount ?? prev?.playCount ?? 0,
      lastPlayedAt: input.lastPlayedAt !== undefined ? input.lastPlayedAt : (prev?.lastPlayedAt ?? null),
      positionMs: input.positionMs ?? prev?.positionMs ?? 0,
      durationMs: input.durationMs !== undefined ? input.durationMs : (prev?.durationMs ?? null),
      favorite: input.favorite ?? prev?.favorite ?? false,
    };
    // A server-side "mark played" has no play count; count it once.
    if (next.played && next.playCount === 0) next.playCount = 1;
    const r = input.resolved;
    let events = 0;
    const event = (type: WatchEventType, at: string) => {
      if (
        this.recordEvent({
          serverId: input.serverId,
          mediaServerUserId: input.mediaServerUserId,
          type,
          at,
          resolved: r,
          jellyfinItemId: input.jellyfinItemId,
          title: input.title,
          seasonNumber: input.seasonNumber ?? prev?.seasonNumber ?? null,
          episodeNumber: input.episodeNumber ?? prev?.episodeNumber ?? null,
          durationMs: next.durationMs,
          source: opts.source,
          dedupeKey: `${type}|${input.serverId}|${input.mediaServerUserId}|${input.jellyfinItemId}|${at}`,
        })
      )
        events++;
    };
    if (next.played && (!prev?.played || next.playCount > prev.playCount)) {
      const at = opts.eventAt ?? next.lastPlayedAt ?? (prev ? now : null);
      if (at) event('played', at);
    } else if (prev?.played && !next.played) {
      event('unplayed', opts.eventAt ?? now);
    }

    const keep = opts.keepEmpty ?? r.itemType === 'movie';
    if (!keep && !remembered(next)) {
      if (prev) this.db.delete(watchState).where(eq(watchState.id, prev.id)).run();
      return { changed: prev !== undefined, events };
    }
    const values = {
      serverId: input.serverId,
      mediaServerUserId: input.mediaServerUserId,
      jellyfinItemId: input.jellyfinItemId,
      itemType: r.itemType,
      itemKey: r.itemKey,
      movieId: r.movieId,
      seriesId: r.seriesId,
      episodeId: r.episodeId,
      seasonNumber: input.seasonNumber ?? prev?.seasonNumber ?? null,
      episodeNumber: input.episodeNumber ?? prev?.episodeNumber ?? null,
      tmdbId: r.tmdbId,
      tvdbId: r.tvdbId,
      imdbId: r.imdbId,
      jellyfinSeriesId: input.jellyfinSeriesId ?? prev?.jellyfinSeriesId ?? null,
      jellyfinSeasonId: input.jellyfinSeasonId ?? prev?.jellyfinSeasonId ?? null,
      title: input.title,
      ...next,
    };
    if (!prev) {
      this.db.insert(watchState).values({ ...values, updatedAt: now }).run();
      return { changed: true, events };
    }
    const differs = (Object.keys(values) as (keyof typeof values)[]).some((k) => values[k] !== prev[k]);
    if (differs) this.db.update(watchState).set({ ...values, updatedAt: now }).where(eq(watchState.id, prev.id)).run();
    return { changed: differs, events };
  }

  /** Removes rows of this account the latest full read no longer listed (items gone or out of reach). */
  dropUnseen(mediaServerUserId: number, seen: Set<string>, types: readonly WatchItemType[]): number {
    const stale = this.db
      .select({ id: watchState.id, jellyfinItemId: watchState.jellyfinItemId })
      .from(watchState)
      .where(and(eq(watchState.mediaServerUserId, mediaServerUserId), inArray(watchState.itemType, [...types])))
      .all()
      .filter((r) => !seen.has(r.jellyfinItemId))
      .map((r) => r.id);
    for (let i = 0; i < stale.length; i += 500) this.db.delete(watchState).where(inArray(watchState.id, stale.slice(i, i + 500))).run();
    return stale.length;
  }

  /**
   * Recomputes the series roll-up of one account (and its season roll-ups) from the stored
   * episode rows. Totals come from a full read when given, else from the existing roll-up (null
   * until a full read saw the series: such a series never counts as watched).
   */
  rebuildSeries(serverId: string, mediaServerUserId: number, jellyfinSeriesId: string, meta: SeriesMeta): void {
    const eps = this.db
      .select()
      .from(watchState)
      .where(and(eq(watchState.mediaServerUserId, mediaServerUserId), eq(watchState.jellyfinSeriesId, jellyfinSeriesId), eq(watchState.itemType, 'episode')))
      .all();
    const existingSeasons = this.db
      .select()
      .from(watchState)
      .where(and(eq(watchState.mediaServerUserId, mediaServerUserId), eq(watchState.jellyfinSeriesId, jellyfinSeriesId), eq(watchState.itemType, 'season')))
      .all();
    const existingSeries = this.stateRow(mediaServerUserId, jellyfinSeriesId);
    if (!meta.totals && eps.length === 0 && !existingSeries && existingSeasons.length === 0) return;

    const roll = (rows: WatchStateRow[], total: number | null) => {
      let played = 0;
      let playCount = 0;
      let lastPlayedAt: string | null = null;
      let positionMs = 0;
      for (const e of rows) {
        if (e.played) played++;
        playCount += e.playCount;
        if (e.lastPlayedAt && (!lastPlayedAt || e.lastPlayedAt > lastPlayedAt)) lastPlayedAt = e.lastPlayedAt;
        if (!e.played && e.positionMs > positionMs) positionMs = e.positionMs;
      }
      return { episodesTotal: total, episodesPlayed: played, played: total !== null && total > 0 && played >= total, playCount, lastPlayedAt, positionMs };
    };
    const now = this.iso();
    const upsert = (jellyfinItemId: string, values: Omit<typeof watchState.$inferInsert, 'updatedAt'>) => {
      const prev = this.stateRow(mediaServerUserId, jellyfinItemId);
      if (!prev) {
        this.db.insert(watchState).values({ ...values, updatedAt: now }).run();
        return;
      }
      const differs = (Object.keys(values) as (keyof typeof values)[]).some((k) => k !== 'favorite' && values[k] !== undefined && values[k] !== prev[k as keyof WatchStateRow]);
      if (differs) this.db.update(watchState).set({ ...values, favorite: prev.favorite, updatedAt: now }).where(eq(watchState.id, prev.id)).run();
    };
    const r = meta.resolved;
    upsert(jellyfinSeriesId, {
      serverId,
      mediaServerUserId,
      jellyfinItemId: jellyfinSeriesId,
      itemType: 'series',
      itemKey: r.seriesId !== null ? `series:${r.seriesId}` : `jf:${jellyfinSeriesId}`,
      movieId: null,
      seriesId: r.seriesId,
      episodeId: null,
      seasonNumber: null,
      episodeNumber: null,
      tmdbId: r.tmdbId,
      tvdbId: r.tvdbId,
      imdbId: r.imdbId,
      jellyfinSeriesId,
      jellyfinSeasonId: null,
      title: meta.title,
      favorite: existingSeries?.favorite ?? false,
      ...roll(eps, meta.totals ? meta.totals.total : (existingSeries?.episodesTotal ?? null)),
    });

    const seasons = new Map<string, number | null>();
    for (const s of existingSeasons) seasons.set(s.jellyfinItemId, s.seasonNumber);
    for (const e of eps) if (e.jellyfinSeasonId) seasons.set(e.jellyfinSeasonId, e.seasonNumber);
    for (const [id, t] of meta.totals?.seasons ?? []) seasons.set(id, t.seasonNumber);
    for (const [seasonId, seasonNumber] of seasons) {
      const prev = existingSeasons.find((s) => s.jellyfinItemId === seasonId);
      const total = meta.totals ? (meta.totals.seasons.get(seasonId)?.total ?? 0) : (prev?.episodesTotal ?? null);
      upsert(seasonId, {
        serverId,
        mediaServerUserId,
        jellyfinItemId: seasonId,
        itemType: 'season',
        itemKey: r.seriesId !== null && seasonNumber !== null ? `season:${r.seriesId}:${seasonNumber}` : `jf:${seasonId}`,
        movieId: null,
        seriesId: r.seriesId,
        episodeId: null,
        seasonNumber,
        episodeNumber: null,
        tmdbId: r.tmdbId,
        tvdbId: r.tvdbId,
        imdbId: r.imdbId,
        jellyfinSeriesId,
        jellyfinSeasonId: seasonId,
        title: seasonNumber !== null ? `${meta.title} - Season ${seasonNumber}` : meta.title,
        favorite: prev?.favorite ?? false,
        ...roll(
          eps.filter((e) => e.jellyfinSeasonId === seasonId),
          total,
        ),
      });
    }
  }

  // ---- sync bookkeeping ------------------------------------------------------------------

  patchSyncState(serverId: string, patch: Partial<typeof mediaServerSyncState.$inferInsert>): void {
    this.db
      .insert(mediaServerSyncState)
      .values({ serverId, ...patch })
      .onConflictDoUpdate({ target: mediaServerSyncState.serverId, set: patch })
      .run();
  }

  syncState(serverId: string) {
    return this.db.select().from(mediaServerSyncState).where(eq(mediaServerSyncState.serverId, serverId)).get();
  }
}
