import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import { mediaBrowserProviderIds, ticksToMs } from '@arclight/media-servers';
import type { JellyfinEvent, MediaServerConfig, MediaServerLink, WatchEventType } from '@arclight/shared';
import { users } from '../../db/schema.js';
import { mediaServerUsers, watchEvents } from './schema.js';
import { LibraryResolver, linkedUsers, normaliseExternalId, resolveItem, type ResolvedItem, type WatchStore } from './store.js';
import type { AccountsPort } from './sync.js';

// POST /jellyfin/events: the plugin's real-time feed. Playback events go to the timeline and move
// the resume point; userDataSaved carries Played / PlayCount / IsFavorite changes as they happen
// (the catch-up sync only sees "mark unplayed" and favourites on its full reads); user events keep
// the account list current. Identical events (same session, type, time, user and item) are stored
// once, so the plugin may resend a batch after a timeout.

/** Progress events of one session closer together than this are not stored (the resume point still moves). */
const PROGRESS_EVERY_MS = 60_000;

const PLAYBACK: Partial<Record<JellyfinEvent['type'], WatchEventType>> = {
  playbackStart: 'start',
  playbackProgress: 'progress',
  playbackStop: 'stop',
};

export class EventIngest {
  constructor(
    private readonly store: WatchStore,
    private readonly accounts?: () => AccountsPort,
    private readonly log?: Logger,
  ) {}

  /** Stores a batch; returns how many events were valid (duplicates included, so the plugin does not resend them). */
  ingest(config: MediaServerConfig, events: readonly JellyfinEvent[]): number {
    const resolver = new LibraryResolver(this.store.db);
    let accepted = 0;
    for (const event of events) {
      const at = isoOf(event.at);
      if (!at) continue;
      try {
        this.one(config, { ...event, at }, resolver);
        accepted++;
      } catch (err) {
        this.log?.warn({ err, type: event.type }, 'jellyfin plugin event could not be stored');
      }
    }
    this.store.patchSyncState(config.id, { lastEventAt: this.store.iso() });
    return accepted;
  }

  private one(config: MediaServerConfig, event: JellyfinEvent, resolver: LibraryResolver): void {
    const kind = config.kind as 'jellyfin' | 'emby';
    switch (event.type) {
      case 'userCreated':
      case 'userUpdated': {
        if (!event.jellyfinUserId) return;
        const before = this.store.account(config.id, event.jellyfinUserId);
        const row = this.store.ensureAccount(config.id, event.jellyfinUserId, event.userName);
        if (row.deleted) this.store.db.update(mediaServerUsers).set({ deleted: false, updatedAt: this.store.iso() }).where(eq(mediaServerUsers.id, row.id)).run();
        if (before && event.userName && before.name !== event.userName) this.renameLink(kind, row.externalId, event.userName);
        return;
      }
      case 'userDeleted': {
        if (!event.jellyfinUserId) return;
        const row = this.store.account(config.id, event.jellyfinUserId);
        if (row && !row.deleted) this.store.db.update(mediaServerUsers).set({ deleted: true, updatedAt: this.store.iso() }).where(eq(mediaServerUsers.id, row.id)).run();
        const link = linkedUsers(this.store.db).get(`${kind}:${normaliseExternalId(event.jellyfinUserId)}`);
        if (link) this.accounts?.().patchUserSettings(link.id, { mediaServerLink: undefined });
        return;
      }
      case 'itemAdded':
        // Library changes reach Arclight through its own imports; nothing to record.
        return;
      default:
        break;
    }
    const item = event.item;
    if (!item || !event.jellyfinUserId) return;
    const account = this.store.ensureAccount(config.id, event.jellyfinUserId, event.userName);
    const ids = mediaBrowserProviderIds(item.providerIds);
    const seriesIds = item.seriesProviderIds ? mediaBrowserProviderIds(item.seriesProviderIds) : null;
    const resolved = resolveItem(resolver, {
      jellyfinItemId: item.id,
      type: item.type,
      ids,
      seriesIds,
      seasonNumber: item.seasonNumber ?? null,
      episodeNumber: item.episodeNumber ?? null,
    });
    const durationMs = item.runTimeTicks ? ticksToMs(item.runTimeTicks) || null : undefined;
    const positionMs = event.positionTicks !== undefined ? ticksToMs(event.positionTicks) : undefined;
    const base = {
      serverId: config.id,
      mediaServerUserId: account.id,
      jellyfinItemId: item.id,
      resolved,
      title: item.name,
      seasonNumber: item.seasonNumber ?? null,
      episodeNumber: item.episodeNumber ?? null,
    };
    const tracked = item.type === 'Movie' || item.type === 'Episode';

    const playback = PLAYBACK[event.type];
    if (playback) {
      let fresh = true;
      if (playback !== 'progress' || !this.recentProgress(event.sessionId, event.at)) {
        fresh = this.store.recordEvent({
          ...base,
          type: playback,
          at: event.at,
          positionMs: positionMs ?? null,
          durationMs: durationMs ?? null,
          client: event.client ?? null,
          device: event.deviceName ?? null,
          playMethod: event.playMethod ?? null,
          sessionId: event.sessionId ?? null,
          source: 'plugin',
        });
      }
      if (!tracked) return;
      // A resent stop must not count the play twice.
      if (playback === 'stop' && event.played === true && fresh) {
        const prev = this.store.stateRow(account.id, item.id);
        this.store.applyState(
          { ...base, played: true, playCount: event.playCount ?? (prev?.played ? prev.playCount + 1 : Math.max(1, (prev?.playCount ?? 0) + 1)), lastPlayedAt: event.at, positionMs: 0, ...(durationMs !== undefined ? { durationMs } : {}) },
          { source: 'plugin', eventAt: event.at },
        );
      } else if (positionMs !== undefined && fresh && !this.isStale(account.id, item.id, event.at)) {
        this.store.applyState({ ...base, positionMs, lastPlayedAt: event.at, ...(durationMs !== undefined ? { durationMs } : {}) }, { source: 'plugin', eventAt: event.at });
      }
      this.rollUp(config.id, account.id, item.id, resolved, seriesIds);
      return;
    }

    // userDataSaved
    if (item.type === 'Series' || item.type === 'Season') {
      // Roll-ups are computed from episodes; only the favourite flag is the series' own.
      if (event.isFavorite !== undefined && this.store.stateRow(account.id, item.id)) {
        this.store.applyState({ ...base, favorite: event.isFavorite }, { source: 'plugin', keepEmpty: true });
      }
      return;
    }
    this.store.applyState(
      {
        ...base,
        ...(event.played !== undefined ? { played: event.played } : {}),
        ...(event.playCount !== undefined ? { playCount: event.playCount } : {}),
        ...(event.isFavorite !== undefined ? { favorite: event.isFavorite } : {}),
        ...(positionMs !== undefined ? { positionMs } : {}),
        ...(event.played === true ? { lastPlayedAt: event.at } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
      { source: 'plugin', eventAt: event.at },
    );
    if (tracked) this.rollUp(config.id, account.id, item.id, resolved, seriesIds);
  }

  /** An event older than the last play already stored (a resent or late batch) must not move the resume point back. */
  private isStale(mediaServerUserId: number, jellyfinItemId: string, at: string): boolean {
    const last = this.store.stateRow(mediaServerUserId, jellyfinItemId)?.lastPlayedAt;
    return last !== null && last !== undefined && last > at;
  }

  /** True when the session already has a start/progress event within PROGRESS_EVERY_MS before `at`. */
  private recentProgress(sessionId: string | undefined, at: string): boolean {
    if (!sessionId) return false;
    const since = new Date(Date.parse(at) - PROGRESS_EVERY_MS).toISOString();
    const last = this.store.db
      .select({ at: watchEvents.at })
      .from(watchEvents)
      .where(and(eq(watchEvents.sessionId, sessionId), inArray(watchEvents.type, ['start', 'progress']), gte(watchEvents.at, since), lte(watchEvents.at, at)))
      .orderBy(desc(watchEvents.at))
      .limit(1)
      .get();
    return last !== undefined;
  }

  /** Episodes: refresh the series roll-up when the episode row knows its Jellyfin series (set by the sync). */
  private rollUp(serverId: string, mediaServerUserId: number, jellyfinItemId: string, resolved: ResolvedItem, seriesIds: ReturnType<typeof mediaBrowserProviderIds> | null): void {
    if (resolved.itemType !== 'episode') return;
    const row = this.store.stateRow(mediaServerUserId, jellyfinItemId);
    const jellyfinSeriesId = row?.jellyfinSeriesId;
    if (!jellyfinSeriesId) return;
    const existing = this.store.stateRow(mediaServerUserId, jellyfinSeriesId);
    this.store.rebuildSeries(serverId, mediaServerUserId, jellyfinSeriesId, {
      title: existing?.title ?? resolved.seriesTitle ?? jellyfinSeriesId,
      resolved: {
        ...resolved,
        itemType: 'series',
        itemKey: resolved.seriesId !== null ? `series:${resolved.seriesId}` : `jf:${jellyfinSeriesId}`,
        episodeId: null,
        imdbId: seriesIds?.imdbId ?? null,
      },
    });
  }

  private renameLink(kind: 'jellyfin' | 'emby', externalId: string, name: string): void {
    const link = linkedUsers(this.store.db).get(`${kind}:${externalId}`);
    const accounts = this.accounts?.();
    if (!link || !accounts) return;
    const row = this.store.db.select({ settings: users.settings }).from(users).where(eq(users.id, link.id)).get();
    const current = ((row?.settings ?? {}) as Record<string, unknown>)['mediaServerLink'] as MediaServerLink | undefined;
    if (current) accounts.patchUserSettings(link.id, { mediaServerLink: { ...current, username: name } });
  }
}

function isoOf(value: string): string | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
