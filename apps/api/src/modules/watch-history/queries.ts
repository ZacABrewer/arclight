import { and, count, desc, eq, gte, inArray, lt, ne, type SQL } from 'drizzle-orm';
import {
  watchSyncEnabled,
  WatchHistoryQuery,
  type MediaServerAccountRow,
  type MediaServerConfig,
  type MediaServerSyncStatus,
  type NowPlayingEntry,
  type WatchedByEntry,
  type WatchEvent,
  type WatchEventPage,
  type WatchHistorySettings,
  type WatchUserRef,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { mediaServerSyncState, mediaServerUsers, watchEvents, watchState, type MediaServerUserRow, type WatchEventRow } from './schema.js';
import { linkedUsers, type LinkedUser } from './store.js';

// The read side: history pages, "watched by", now playing, sync status, the account list and the
// stored play state retention evaluates. Accounts are mapped to Arclight users through the links
// at read time, so a link made today shows yesterday's history under the user.

const HOUR_MS = 60 * 60_000;
/** A session is "now playing" while its last start/progress event is younger than this. */
export const NOW_PLAYING_WINDOW_MS = 5 * 60_000;

export interface Viewer {
  isAdmin: boolean;
  /** Arclight user id (null for API-key callers, who see everything). */
  userId: number | null;
}

export class WatchQueries {
  constructor(
    private readonly db: Db,
    private readonly servers: () => MediaServerConfig[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Account id → Arclight user (null when unlinked). */
  owners(): Map<number, LinkedUser | null> {
    const kinds = new Map(this.servers().map((s) => [s.id, s.kind]));
    const links = linkedUsers(this.db);
    const out = new Map<number, LinkedUser | null>();
    for (const row of this.db.select({ id: mediaServerUsers.id, serverId: mediaServerUsers.serverId, externalId: mediaServerUsers.externalId }).from(mediaServerUsers).all()) {
      out.set(row.id, links.get(`${kinds.get(row.serverId) ?? ''}:${row.externalId}`) ?? null);
    }
    return out;
  }

  private accountRows(ids: Iterable<number>): Map<number, MediaServerUserRow> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    return new Map(this.db.select().from(mediaServerUsers).where(inArray(mediaServerUsers.id, wanted)).all().map((r) => [r.id, r]));
  }

  private userRef(id: number | null, rows: Map<number, MediaServerUserRow>, owners: Map<number, LinkedUser | null>): WatchUserRef | null {
    if (id === null) return null;
    const row = rows.get(id);
    const owner = owners.get(id) ?? null;
    return { mediaServerUserId: id, name: row?.name ?? `account ${id}`, arclightUserId: owner?.id ?? null, arclightUsername: owner?.username ?? null };
  }

  private serverName(id: string): string {
    return this.servers().find((s) => s.id === id)?.name ?? id;
  }

  // ---- history ---------------------------------------------------------------------------

  /** GET /watchhistory. Non-admin viewers only ever see their own accounts' events. */
  events(raw: WatchHistoryQuery, viewer: Viewer): WatchEventPage {
    const q = WatchHistoryQuery.parse(raw);
    const owners = this.owners();
    const where: SQL[] = [];
    const userId = viewer.isAdmin ? q.userId : (viewer.userId ?? -1);
    if (userId !== undefined) {
      const mine = [...owners].filter(([, o]) => o?.id === userId).map(([id]) => id);
      if (mine.length === 0) return { page: q.page, pageSize: q.pageSize, totalRecords: 0, records: [] };
      where.push(inArray(watchEvents.mediaServerUserId, mine));
    }
    if (q.mediaServerUserId !== undefined) where.push(eq(watchEvents.mediaServerUserId, q.mediaServerUserId));
    if (q.serverId) where.push(eq(watchEvents.serverId, q.serverId));
    if (q.movieId !== undefined) where.push(eq(watchEvents.movieId, q.movieId));
    if (q.seriesId !== undefined) where.push(eq(watchEvents.seriesId, q.seriesId));
    if (q.type) where.push(eq(watchEvents.type, q.type));
    else if (!q.includeProgress) where.push(ne(watchEvents.type, 'progress'));
    const filter = and(...where);
    const total = this.db.select({ n: count() }).from(watchEvents).where(filter).get()?.n ?? 0;
    const rows = this.db
      .select()
      .from(watchEvents)
      .where(filter)
      .orderBy(desc(watchEvents.at), desc(watchEvents.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .all();
    const accounts = this.accountRows(rows.flatMap((r) => (r.mediaServerUserId !== null ? [r.mediaServerUserId] : [])));
    return { page: q.page, pageSize: q.pageSize, totalRecords: total, records: rows.map((r) => this.toEvent(r, accounts, owners)) };
  }

  private toEvent(r: WatchEventRow, accounts: Map<number, MediaServerUserRow>, owners: Map<number, LinkedUser | null>): WatchEvent {
    return {
      id: r.id,
      serverId: r.serverId,
      serverName: this.serverName(r.serverId),
      user: this.userRef(r.mediaServerUserId, accounts, owners),
      type: r.type,
      at: r.at,
      itemType: r.itemType,
      title: r.title,
      seriesTitle: r.seriesTitle,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      movieId: r.movieId,
      seriesId: r.seriesId,
      episodeId: r.episodeId,
      positionMs: r.positionMs,
      durationMs: r.durationMs,
      client: r.client,
      device: r.device,
      playMethod: r.playMethod,
      sessionId: r.sessionId,
      source: r.source,
    };
  }

  /** GET /watchhistory/title/:mediaType/:id: every account's state for a library movie or series. */
  watchedBy(mediaType: 'movie' | 'series', id: number): WatchedByEntry[] {
    const rows = this.db
      .select()
      .from(watchState)
      .where(mediaType === 'movie' ? and(eq(watchState.itemType, 'movie'), eq(watchState.movieId, id)) : and(eq(watchState.itemType, 'series'), eq(watchState.seriesId, id)))
      .all()
      .filter((r) => r.played || r.playCount > 0 || r.positionMs > 0 || r.favorite || (r.episodesPlayed ?? 0) > 0);
    const owners = this.owners();
    const accounts = this.accountRows(rows.map((r) => r.mediaServerUserId));
    return rows
      .map((r) => ({
        user: this.userRef(r.mediaServerUserId, accounts, owners)!,
        serverId: r.serverId,
        serverName: this.serverName(r.serverId),
        played: r.played,
        playCount: r.playCount,
        lastPlayedAt: r.lastPlayedAt,
        positionMs: r.positionMs,
        durationMs: r.durationMs,
        favorite: r.favorite,
        episodes: r.itemType === 'series' ? { total: r.episodesTotal ?? 0, played: r.episodesPlayed ?? 0 } : null,
      }))
      .sort((a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''));
  }

  /** GET /watchhistory/nowplaying: sessions whose last event is a start/progress younger than the window. */
  nowPlaying(): NowPlayingEntry[] {
    const since = new Date(this.now().getTime() - NOW_PLAYING_WINDOW_MS).toISOString();
    const recent = this.db
      .select()
      .from(watchEvents)
      .where(and(gte(watchEvents.at, since), inArray(watchEvents.type, ['start', 'progress', 'stop'])))
      .orderBy(desc(watchEvents.at), desc(watchEvents.id))
      .all();
    const latest = new Map<string, WatchEventRow>();
    for (const e of recent) if (e.sessionId && !latest.has(`${e.sessionId}|${e.jellyfinItemId}`)) latest.set(`${e.sessionId}|${e.jellyfinItemId}`, e);
    const playing = [...latest.values()].filter((e) => e.type !== 'stop');
    const owners = this.owners();
    const accounts = this.accountRows(playing.flatMap((e) => (e.mediaServerUserId !== null ? [e.mediaServerUserId] : [])));
    const dayAgo = new Date(this.now().getTime() - 24 * HOUR_MS).toISOString();
    return playing.map((e) => {
      const start = this.db
        .select({ at: watchEvents.at })
        .from(watchEvents)
        .where(and(eq(watchEvents.sessionId, e.sessionId!), eq(watchEvents.type, 'start'), gte(watchEvents.at, dayAgo)))
        .orderBy(desc(watchEvents.at))
        .limit(1)
        .get();
      return {
        sessionId: e.sessionId!,
        serverId: e.serverId,
        serverName: this.serverName(e.serverId),
        user: this.userRef(e.mediaServerUserId, accounts, owners),
        itemType: e.itemType,
        title: e.title,
        seriesTitle: e.seriesTitle,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        movieId: e.movieId,
        seriesId: e.seriesId,
        positionMs: e.positionMs,
        durationMs: e.durationMs,
        client: e.client,
        device: e.device,
        playMethod: e.playMethod,
        startedAt: start?.at ?? e.at,
        updatedAt: e.at,
      };
    });
  }

  // ---- servers ---------------------------------------------------------------------------

  syncStatus(config: MediaServerConfig): MediaServerSyncStatus {
    const st = this.db.select().from(mediaServerSyncState).where(eq(mediaServerSyncState.serverId, config.id)).get();
    const accounts = this.db.select().from(mediaServerUsers).where(and(eq(mediaServerUsers.serverId, config.id), eq(mediaServerUsers.deleted, false))).all();
    const owners = this.owners();
    return {
      serverId: config.id,
      watchSyncEnabled: watchSyncEnabled(config),
      lastSyncAt: st?.lastSyncAt ?? null,
      lastFullSyncAt: st?.lastFullSyncAt ?? null,
      lastStatus: st?.lastStatus ?? null,
      lastError: st?.lastError ?? null,
      itemsTracked: this.db.select({ n: count() }).from(watchState).where(eq(watchState.serverId, config.id)).get()?.n ?? 0,
      lastUserSyncAt: st?.lastUserSyncAt ?? null,
      lastUserSyncStatus: st?.lastUserSyncStatus ?? null,
      lastUserSyncError: st?.lastUserSyncError ?? null,
      lastEventAt: st?.lastEventAt ?? null,
      users: accounts.length,
      linkedUsers: accounts.filter((a) => owners.get(a.id)).length,
    };
  }

  accounts(serverId: string): MediaServerAccountRow[] {
    const owners = this.owners();
    return this.db
      .select()
      .from(mediaServerUsers)
      .where(eq(mediaServerUsers.serverId, serverId))
      .orderBy(mediaServerUsers.name)
      .all()
      .map((r) => ({
        id: r.id,
        serverId: r.serverId,
        externalId: r.externalId,
        name: r.name,
        isAdmin: r.isAdmin,
        disabled: r.disabled,
        deleted: r.deleted,
        lastActivityAt: r.lastActivityAt,
        firstSeenAt: r.firstSeenAt,
        arclightUserId: owners.get(r.id)?.id ?? null,
        arclightUsername: owners.get(r.id)?.username ?? null,
        lastWatchSyncAt: r.lastWatchSyncAt,
      }));
  }

  /** Last plugin event per server. */
  lastEvents(): Map<string, string | null> {
    return new Map(this.db.select().from(mediaServerSyncState).all().map((r) => [r.serverId, r.lastEventAt]));
  }

  // ---- retention -------------------------------------------------------------------------

  /**
   * Servers whose stored play state retention may use instead of a live read: watch-history
   * sync on, every account had a full read, and the last successful sync is not older than twice
   * the full-read interval (a sync that keeps failing falls back to the live read, which then
   * fails loudly instead of evaluating stale data).
   */
  coveredServers(settings: WatchHistorySettings): Set<string> {
    const nowMs = this.now().getTime();
    const out = new Set<string>();
    for (const config of this.servers()) {
      if (!watchSyncEnabled(config)) continue;
      const st = this.db.select().from(mediaServerSyncState).where(eq(mediaServerSyncState.serverId, config.id)).get();
      if (!st?.lastFullSyncAt || !st.lastSyncAt) continue;
      if (nowMs - Date.parse(st.lastSyncAt) > Math.max(2 * settings.fullSyncHours, 6) * HOUR_MS) continue;
      out.add(config.id);
    }
    return out;
  }

  /**
   * Stored play state of library movies or series on `serverIds`, per library id and account:
   * movies from their own rows, series from the roll-ups (played = every present episode played).
   * Accounts of disabled or deleted server users are left out, as the live read leaves out
   * disabled users.
   */
  retentionRows(
    mediaType: 'movie' | 'series',
    serverIds: ReadonlySet<string>,
  ): Array<{ libraryId: number; account: MediaServerUserRow; owner: LinkedUser | null; played: boolean; lastPlayedAt: string | null }> {
    if (serverIds.size === 0) return [];
    const rows = this.db
      .select()
      .from(watchState)
      .where(and(eq(watchState.itemType, mediaType), inArray(watchState.serverId, [...serverIds])))
      .all();
    const accounts = this.accountRows(rows.map((r) => r.mediaServerUserId));
    const owners = this.owners();
    return rows.flatMap((r) => {
      const libraryId = mediaType === 'movie' ? r.movieId : r.seriesId;
      const account = accounts.get(r.mediaServerUserId);
      if (libraryId === null || !account || account.disabled || account.deleted) return [];
      return [{ libraryId, account, owner: owners.get(account.id) ?? null, played: r.played, lastPlayedAt: r.lastPlayedAt }];
    });
  }

  /** WatchHistoryCleanup: drops timeline events older than the retention window. */
  pruneEvents(retentionDays: number): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 24 * HOUR_MS).toISOString();
    return this.db.delete(watchEvents).where(lt(watchEvents.at, cutoff)).run().changes;
  }
}
