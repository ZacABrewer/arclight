import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { PLEX_OWNER_ACCOUNT_ID, PlexServerReadClient, type PlexLiveItem, type PlexSession, type PlexWebhookEvent, type ProviderIds } from '@arclight/media-servers';
import type { MediaServerConfig, WatchEventSource, WatchEventType, WatchPlayMethod } from '@arclight/shared';
import type { MediaServersService } from '../media-servers/index.js';
import { watchEvents } from './schema.js';
import { LibraryResolver, resolveItem, type ResolvedItem, type WatchStore } from './store.js';

// Live playback from Plex, fed into the same timeline as the Jellyfin plugin's events. Two
// sources: webhooks (Plex Pass; Plex posts media.play / pause / resume / stop / scrobble to
// /api/v1/plex/webhook) and a once-a-minute poll of /status/sessions, which works without Plex
// Pass and catches what a missed webhook would lose. Both name a playback by server, player and
// item, so they merge into one session: a second "start" for an open session becomes progress,
// a second "stop" is dropped, and a session the poll no longer sees is stopped.
//
// Plex marks an item played at 90% (the webhook's media.scrobble). The poll does the same when a
// session it stops had passed 90%, unless a scrobble already counted that play.

/** Progress events of one session closer together than this are not stored (the resume point still moves). */
const PROGRESS_EVERY_MS = 60_000;
/** A session with no event for this long is not open any more (its stop was lost). */
const OPEN_SESSION_MS = 6 * 60 * 60_000;
/** Share of the runtime after which a stopped play counts as watched (Plex's own threshold). */
const PLAYED_AT = 0.9;

/** Webhook event to timeline event. `played`: media.scrobble. */
const WEBHOOK_EVENTS: Record<string, WatchEventType | 'scrobble'> = {
  'media.play': 'start',
  'media.resume': 'progress',
  'media.pause': 'progress',
  'media.stop': 'stop',
  'media.scrobble': 'scrobble',
};

interface LiveInput {
  type: WatchEventType | 'scrobble';
  at: string;
  accountId: string | null;
  accountName: string | null;
  playerId: string | null;
  client: string | null;
  device: string | null;
  playMethod: WatchPlayMethod | null;
  item: PlexLiveItem;
  source: WatchEventSource;
}

export interface PlexWebhookResult {
  status: 'stored' | 'ignored';
  reason?: string;
}

export class PlexLive {
  /** Show ids by `serverId|ratingKey`, so episodes of one show ask Plex once. */
  private readonly showIds = new Map<string, ProviderIds | null>();

  constructor(
    private readonly store: WatchStore,
    private readonly servers: MediaServersService,
    private readonly log?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One webhook. Events of other servers (a token copied to another server) and non-playback events are ignored. */
  async webhook(config: MediaServerConfig, event: PlexWebhookEvent): Promise<PlexWebhookResult> {
    if (config.remoteId && event.serverUuid && event.serverUuid !== config.remoteId) return { status: 'ignored', reason: 'another server' };
    const type = WEBHOOK_EVENTS[event.event];
    if (!type) return { status: 'ignored', reason: 'not a playback event' };
    if (!event.item) return { status: 'ignored', reason: 'no item' };
    this.store.patchSyncState(config.id, { lastEventAt: this.store.iso() });
    const stored = await this.apply(config, new LibraryResolver(this.store.db), {
      type,
      at: this.now().toISOString(),
      accountId: event.accountId,
      accountName: event.accountName,
      playerId: event.playerId,
      client: event.client,
      device: event.device,
      playMethod: null,
      item: event.item,
      source: 'webhook',
    });
    return stored ? { status: 'stored' } : { status: 'ignored', reason: 'unknown account or item type' };
  }

  /** PlexSessionPoll: every Plex server with watch-history sync on. Returns a one-line summary. */
  async poll(): Promise<string> {
    const parts: string[] = [];
    for (const config of this.servers.watchSyncServers()) {
      if (config.kind !== 'plex') continue;
      try {
        const n = await this.pollServer(config);
        parts.push(`${config.name}: ${n.playing} playing, ${n.stopped} stopped`);
      } catch (err) {
        this.log?.warn({ err, server: config.name }, 'plex session poll failed');
        parts.push(`${config.name}: failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return parts.length > 0 ? parts.join('; ') : 'no Plex server has watch-history sync on';
  }

  async pollServer(config: MediaServerConfig): Promise<{ playing: number; stopped: number }> {
    const client = this.servers.clientFor(config);
    if (!(client instanceof PlexServerReadClient)) throw new Error(`${config.name} is not a Plex server`);
    const sessions = await client.sessions();
    const at = this.now().toISOString();
    const resolver = new LibraryResolver(this.store.db);
    const seen = new Set<string>();
    let playing = 0;
    for (const s of sessions) {
      if (s.item.type !== 'movie' && s.item.type !== 'episode') continue;
      seen.add(this.sessionId(config, s.playerId, s.item.ratingKey));
      const open = this.openSession(this.sessionId(config, s.playerId, s.item.ratingKey));
      if (await this.apply(config, resolver, this.fromSession(s, open ? 'progress' : 'start', at), client)) playing++;
    }
    // Open sessions of this server that Plex no longer lists have ended.
    let stopped = 0;
    for (const last of this.openSessions(config.id)) {
      if (seen.has(last.sessionId)) continue;
      const account = last.mediaServerUserId;
      if (account === null || !last.jellyfinItemId) continue;
      this.store.recordEvent({
        serverId: config.id,
        mediaServerUserId: account,
        type: 'stop',
        at,
        resolved: resolvedOf(last),
        jellyfinItemId: last.jellyfinItemId,
        title: last.title,
        seasonNumber: last.seasonNumber,
        episodeNumber: last.episodeNumber,
        positionMs: last.positionMs,
        durationMs: last.durationMs,
        client: last.client,
        device: last.device,
        playMethod: last.playMethod,
        sessionId: last.sessionId,
        source: 'poll',
      });
      stopped++;
      if (last.positionMs !== null && last.durationMs && last.positionMs >= last.durationMs * PLAYED_AT) {
        const resolved = resolvedOf(last);
        this.markPlayed(config.id, account, last.jellyfinItemId, resolved, { title: last.title, seasonNumber: last.seasonNumber, episodeNumber: last.episodeNumber, durationMs: last.durationMs }, at, last.sessionId, 'poll');
        const showKey = this.store.stateRow(account, last.jellyfinItemId)?.jellyfinSeriesId;
        if (showKey) this.rollUp(config.id, account, showKey, last.seriesTitle, resolved);
      }
    }
    return { playing, stopped };
  }

  private fromSession(s: PlexSession, type: WatchEventType, at: string): LiveInput {
    return { type, at, accountId: s.accountId, accountName: s.accountName, playerId: s.playerId, client: s.client, device: s.device, playMethod: s.playMethod, item: s.item, source: 'poll' };
  }

  private sessionId(config: MediaServerConfig, playerId: string | null, ratingKey: string): string {
    return `plex:${config.id}:${playerId ?? 'unknown'}:${ratingKey}`;
  }

  /** The last event of a session when it is start/progress (still open), else null. */
  private openSession(sessionId: string): typeof watchEvents.$inferSelect | null {
    const since = new Date(this.now().getTime() - OPEN_SESSION_MS).toISOString();
    const last = this.store.db
      .select()
      .from(watchEvents)
      .where(and(eq(watchEvents.sessionId, sessionId), gte(watchEvents.at, since), inArray(watchEvents.type, ['start', 'progress', 'stop'])))
      .orderBy(desc(watchEvents.at), desc(watchEvents.id))
      .limit(1)
      .get();
    return last && last.type !== 'stop' ? last : null;
  }

  /** The last event of every open Plex session of a server. */
  private openSessions(serverId: string): Array<typeof watchEvents.$inferSelect & { sessionId: string }> {
    const since = new Date(this.now().getTime() - OPEN_SESSION_MS).toISOString();
    const rows = this.store.db
      .select()
      .from(watchEvents)
      .where(and(eq(watchEvents.serverId, serverId), gte(watchEvents.at, since), inArray(watchEvents.type, ['start', 'progress', 'stop'])))
      .orderBy(desc(watchEvents.at), desc(watchEvents.id))
      .all();
    const latest = new Map<string, typeof watchEvents.$inferSelect & { sessionId: string }>();
    for (const r of rows) {
      if (!r.sessionId || !r.sessionId.startsWith('plex:') || latest.has(r.sessionId)) continue;
      latest.set(r.sessionId, r as typeof r & { sessionId: string });
    }
    return [...latest.values()].filter((r) => r.type !== 'stop');
  }

  /** Stores one live event; false when the account or item cannot be placed. */
  private async apply(config: MediaServerConfig, resolver: LibraryResolver, input: LiveInput, client?: PlexServerReadClient): Promise<boolean> {
    const { item } = input;
    if (item.type !== 'movie' && item.type !== 'episode') return false;
    const account = this.account(config, input.accountId, input.accountName);
    if (!account) return false;
    const episode = item.type === 'episode';
    const seriesIds = episode && item.grandparentRatingKey ? await this.seriesIds(config, account, item.grandparentRatingKey, client) : null;
    const resolved = resolveItem(resolver, {
      jellyfinItemId: item.ratingKey,
      type: episode ? 'Episode' : 'Movie',
      ids: item.ids,
      seriesIds,
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
    });
    const sessionId = this.sessionId(config, input.playerId, item.ratingKey);
    const meta = { title: item.title, seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber, durationMs: item.durationMs };

    if (input.type === 'scrobble') {
      this.markPlayed(config.id, account, item.ratingKey, resolved, meta, input.at, sessionId, input.source, item);
      if (item.grandparentRatingKey) this.rollUp(config.id, account, item.grandparentRatingKey, item.grandparentTitle, resolved);
      return true;
    }

    let type = input.type;
    const open = this.openSession(sessionId);
    if (type === 'start' && open) type = 'progress';
    if (type === 'stop' && !open) return true; // already stopped (poll and webhook both saw it)
    if (type === 'progress' && !open) type = 'start'; // a resume after the stop was recorded, or a missed play
    const recent = type === 'progress' && open !== null && Date.parse(input.at) - Date.parse(open.at) < PROGRESS_EVERY_MS;
    if (!recent) {
      this.store.recordEvent({
        serverId: config.id,
        mediaServerUserId: account,
        type,
        at: input.at,
        resolved,
        jellyfinItemId: item.ratingKey,
        title: item.title,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        positionMs: item.positionMs,
        durationMs: item.durationMs,
        client: input.client,
        device: input.device,
        playMethod: input.playMethod ?? open?.playMethod ?? null,
        sessionId,
        source: input.source,
      });
    }
    if (item.positionMs !== null) {
      const prev = this.store.stateRow(account, item.ratingKey);
      if (!prev?.lastPlayedAt || prev.lastPlayedAt <= input.at) {
        this.store.applyState(
          {
            ...this.stateBase(config.id, account, item, resolved),
            positionMs: item.positionMs,
            lastPlayedAt: input.at,
            ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
          },
          { source: input.source, eventAt: input.at },
        );
      }
    }
    if (item.grandparentRatingKey) this.rollUp(config.id, account, item.grandparentRatingKey, item.grandparentTitle, resolved);
    return true;
  }

  private stateBase(serverId: string, mediaServerUserId: number, item: PlexLiveItem, resolved: ResolvedItem) {
    return {
      serverId,
      mediaServerUserId,
      jellyfinItemId: item.ratingKey,
      resolved,
      title: item.title,
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
      jellyfinSeriesId: item.grandparentRatingKey,
      jellyfinSeasonId: item.parentRatingKey,
    };
  }

  /** Counts one play, once per session (a scrobble and the poll's 90% rule may both report it). */
  private markPlayed(
    serverId: string,
    mediaServerUserId: number,
    ratingKey: string,
    resolved: ResolvedItem,
    meta: { title: string; seasonNumber: number | null; episodeNumber: number | null; durationMs: number | null },
    at: string,
    sessionId: string,
    source: WatchEventSource,
    item?: PlexLiveItem,
  ): void {
    const start = this.store.db
      .select({ at: watchEvents.at })
      .from(watchEvents)
      .where(and(eq(watchEvents.sessionId, sessionId), eq(watchEvents.type, 'start')))
      .orderBy(desc(watchEvents.at))
      .limit(1)
      .get();
    const since = start?.at ?? new Date(Date.parse(at) - OPEN_SESSION_MS).toISOString();
    const counted = this.store.db
      .select({ id: watchEvents.id })
      .from(watchEvents)
      .where(and(eq(watchEvents.mediaServerUserId, mediaServerUserId), eq(watchEvents.jellyfinItemId, ratingKey), eq(watchEvents.type, 'played'), gte(watchEvents.at, since)))
      .get();
    if (counted) return;
    const prev = this.store.stateRow(mediaServerUserId, ratingKey);
    // Events do not keep every id; the stored row does.
    const r = prev ? { ...resolved, tvdbId: resolved.tvdbId ?? prev.tvdbId, imdbId: resolved.imdbId ?? prev.imdbId } : resolved;
    this.store.applyState(
      {
        serverId,
        mediaServerUserId,
        jellyfinItemId: ratingKey,
        resolved: r,
        title: meta.title,
        seasonNumber: meta.seasonNumber,
        episodeNumber: meta.episodeNumber,
        ...(item ? { jellyfinSeriesId: item.grandparentRatingKey, jellyfinSeasonId: item.parentRatingKey } : {}),
        played: true,
        playCount: (prev?.played ? prev.playCount : (prev?.playCount ?? 0)) + 1,
        lastPlayedAt: at,
        positionMs: 0,
        ...(meta.durationMs !== null ? { durationMs: meta.durationMs } : {}),
      },
      { source, eventAt: at },
    );
  }

  /** The account row of a server-local Plex account id; null for the owner before the first sync. */
  private account(config: MediaServerConfig, localId: string | null, name: string | null): number | null {
    if (!localId || localId === '0') return null;
    const found = this.store.accountByLocalId(config.id, localId);
    if (found) return found.id;
    // Everyone but the owner uses the plex.tv id locally; the owner's plex.tv id comes from the sync.
    if (localId === PLEX_OWNER_ACCOUNT_ID) {
      this.log?.debug({ server: config.name }, 'plex owner not synced yet; live event skipped');
      return null;
    }
    return this.store.ensureAccount(config.id, localId, name, localId).id;
  }

  /** The show's provider ids: from its stored roll-up row, else from Plex. */
  private async seriesIds(config: MediaServerConfig, mediaServerUserId: number, showKey: string, client?: PlexServerReadClient): Promise<ProviderIds | null> {
    const row = this.store.stateRow(mediaServerUserId, showKey);
    if (row && (row.tvdbId !== null || row.tmdbId !== null || row.imdbId !== null)) {
      return { ...emptyProviderIds(), tvdbId: row.tvdbId, tmdbId: row.tmdbId, imdbId: row.imdbId };
    }
    const key = `${config.id}|${showKey}`;
    if (this.showIds.has(key)) return this.showIds.get(key) ?? null;
    let ids: ProviderIds | null = null;
    try {
      const c = client ?? this.servers.clientFor(config);
      if (c instanceof PlexServerReadClient) ids = (await c.itemIds(showKey))?.ids ?? null;
    } catch (err) {
      this.log?.debug({ err, server: config.name }, 'could not read the show of a plex episode');
      return null;
    }
    if (this.showIds.size > 2000) this.showIds.clear();
    this.showIds.set(key, ids);
    return ids;
  }

  /** Refreshes the show's roll-up after an episode changed. */
  private rollUp(serverId: string, mediaServerUserId: number, showKey: string, showTitle: string | null, resolved: ResolvedItem): void {
    if (resolved.itemType !== 'episode') return;
    const existing = this.store.stateRow(mediaServerUserId, showKey);
    this.store.rebuildSeries(serverId, mediaServerUserId, showKey, {
      title: existing?.title ?? showTitle ?? resolved.seriesTitle ?? showKey,
      resolved: {
        ...resolved,
        itemType: 'series',
        itemKey: resolved.seriesId !== null ? `series:${resolved.seriesId}` : `jf:${showKey}`,
        episodeId: null,
        imdbId: existing?.imdbId ?? null,
      },
    });
  }
}

function emptyProviderIds(): ProviderIds {
  return { tmdbId: null, tvdbId: null, imdbId: null };
}

/** The resolved item an earlier event was stored with. */
function resolvedOf(e: typeof watchEvents.$inferSelect): ResolvedItem {
  return {
    itemType: e.itemType,
    itemKey: e.itemKey,
    movieId: e.movieId,
    seriesId: e.seriesId,
    episodeId: e.episodeId,
    tmdbId: e.tmdbId,
    tvdbId: null,
    imdbId: null,
    seriesTitle: e.seriesTitle,
  };
}
