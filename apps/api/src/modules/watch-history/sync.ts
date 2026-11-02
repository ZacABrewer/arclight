import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { MediaBrowserServerClient, type MediaServerUser } from '@arclight/media-servers';
import {
  ContentRestrictions,
  isMediaBrowserKind,
  type MediaServerConfig,
  type MediaServerLink,
  type UserSyncResult,
  type UserSyncServerResult,
  type WatchHistorySettings,
  type WatchSyncResult,
  type WatchSyncServerResult,
} from '@arclight/shared';
import type { MediaServersService } from '../media-servers/index.js';
import { users } from '../../db/schema.js';
import { getSection } from '../settings/service.js';
import { parentalRatingToCaps } from './parental.js';
import { mediaServerUsers, type MediaServerUserRow } from './schema.js';
import { LibraryResolver, linkedUsers, normaliseExternalId, resolveItem, type SeriesMeta, type WatchStore } from './store.js';

// The two catch-up jobs. MediaServerWatchSync copies every account's play state from the
// Jellyfin/Emby servers with watch-history sync on into watch_state (full read on the first run
// and every `fullSyncHours`, otherwise only recently played items); MediaServerUserSync keeps
// media_server_users in step with the servers' accounts (new, renamed, disabled, deleted) and
// carries renames and deletions over to linked Arclight users. Each server is handled on its own:
// one unreachable server is reported and the others carry on.

const HOUR_MS = 60 * 60_000;
/** Incremental reads look this far behind the previous read (clock skew, plays in flight). */
const INCREMENTAL_MARGIN_MS = 10 * 60_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AccountsPort {
  /** Creates an Arclight user linked to a server account (requests module: MediaServerAccounts). */
  createLinkedUser(account: { id: string; username: string; isAdmin: boolean; isDisabled: boolean }, link: MediaServerLink): Promise<{ id: number }>;
  /** Merges a patch into users.settings (an undefined value removes the key). */
  patchUserSettings(userId: number, patch: Record<string, unknown>): void;
  /** Ends every session of a user (a disabled media-server-only account). */
  revokeSessions(userId: number): void;
}

export interface WatchSyncOptions {
  store: WatchStore;
  servers: MediaServersService;
  accounts?: () => AccountsPort;
  log?: Logger;
  now?: () => Date;
}

export class WatchSync {
  private readonly store: WatchStore;
  private readonly servers: MediaServersService;
  private readonly accounts: (() => AccountsPort) | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;

  constructor(opts: WatchSyncOptions) {
    this.store = opts.store;
    this.servers = opts.servers;
    this.accounts = opts.accounts;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  private settings(): WatchHistorySettings {
    return getSection(this.store.db, 'watchHistory');
  }

  private client(config: MediaServerConfig): MediaBrowserServerClient {
    const client = this.servers.clientFor(config);
    if (!(client instanceof MediaBrowserServerClient)) throw new Error(`${config.name} is not a Jellyfin/Emby server`);
    return client;
  }

  // ---- watch history -------------------------------------------------------------------

  /** MediaServerWatchSync: every server with watch-history sync on (or just `serverId`). `full` forces full reads. */
  async syncWatch(opts: { serverId?: string; full?: boolean; signal?: AbortSignal } = {}): Promise<WatchSyncResult> {
    const result: WatchSyncResult = { servers: [] };
    for (const config of this.servers.watchSyncServers()) {
      if (opts.serverId && config.id !== opts.serverId) continue;
      if (opts.signal?.aborted) throw new Error('cancelled');
      result.servers.push(await this.syncServerWatch(config, opts.full ?? false, opts.signal));
    }
    return result;
  }

  private async syncServerWatch(config: MediaServerConfig, forceFull: boolean, signal?: AbortSignal): Promise<WatchSyncServerResult> {
    const out: WatchSyncServerResult = { serverId: config.id, name: config.name, status: 'ok', users: 0, changed: 0, events: 0 };
    this.store.patchSyncState(config.id, { lastStatus: 'running' });
    try {
      const client = this.client(config);
      const info = await client.info();
      this.servers.rememberRemoteId(config.id, info.id);
      const accounts = await client.users();
      const seriesIndex = new Map((await client.listItems('series')).map((s) => [s.id, s]));
      const resolver = new LibraryResolver(this.store.db);
      const fullAfterMs = this.settings().fullSyncHours * HOUR_MS;
      for (const account of accounts) {
        if (signal?.aborted) throw new Error('cancelled');
        const row = this.upsertAccount(config.id, account);
        if (account.isDisabled) continue;
        const started = this.now();
        const full = forceFull || !row.lastFullSyncAt || started.getTime() - Date.parse(row.lastFullSyncAt) >= fullAfterMs;
        const since = !full && row.lastWatchSyncAt ? new Date(Date.parse(row.lastWatchSyncAt) - INCREMENTAL_MARGIN_MS).toISOString() : null;
        const items = await client.watchItems(account.id, { playedSince: full ? null : since });
        const seen = new Set<string>();
        const seriesSeen = new Map<string, SeriesMeta>();
        for (const item of items) {
          seen.add(item.id);
          const seriesItem = item.seriesId ? seriesIndex.get(item.seriesId) : undefined;
          const resolved = resolveItem(resolver, {
            jellyfinItemId: item.id,
            type: item.type,
            ids: item.ids,
            seriesIds: seriesItem?.ids ?? null,
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
          });
          const applied = this.store.applyState(
            {
              serverId: config.id,
              mediaServerUserId: row.id,
              jellyfinItemId: item.id,
              resolved,
              title: item.name,
              seasonNumber: item.seasonNumber,
              episodeNumber: item.episodeNumber,
              jellyfinSeriesId: item.seriesId,
              jellyfinSeasonId: item.seasonId,
              played: item.played,
              playCount: item.playCount,
              lastPlayedAt: item.lastPlayedAt,
              positionMs: item.positionMs,
              durationMs: item.durationMs,
              favorite: item.favorite,
            },
            { source: 'sync' },
          );
          if (applied.changed) out.changed++;
          out.events += applied.events;
          if (item.type !== 'Episode' || !item.seriesId) continue;
          let meta = seriesSeen.get(item.seriesId);
          if (!meta) {
            meta = {
              title: seriesItem?.title ?? resolved.seriesTitle ?? item.seriesId,
              resolved: resolveItem(resolver, { jellyfinItemId: item.seriesId, type: 'Series', ids: seriesItem?.ids ?? { tmdbId: null, tvdbId: null, imdbId: null } }),
              ...(full ? { totals: { total: 0, seasons: new Map() } } : {}),
            };
            seriesSeen.set(item.seriesId, meta);
          }
          if (meta.totals) {
            meta.totals.total++;
            const seasonKey = item.seasonId ?? `${item.seriesId}:${item.seasonNumber ?? 'x'}`;
            const season = meta.totals.seasons.get(seasonKey) ?? { seasonNumber: item.seasonNumber, total: 0 };
            season.total++;
            meta.totals.seasons.set(seasonKey, season);
          }
        }
        if (full) {
          out.changed += this.store.dropUnseen(row.id, seen, ['movie', 'episode']);
          const rollups = new Set<string>();
          for (const [seriesId, meta] of seriesSeen) {
            rollups.add(seriesId);
            for (const seasonId of meta.totals?.seasons.keys() ?? []) rollups.add(seasonId);
          }
          this.store.dropUnseen(row.id, rollups, ['series', 'season']);
        }
        for (const [seriesId, meta] of seriesSeen) this.store.rebuildSeries(config.id, row.id, seriesId, meta);
        this.store.db
          .update(mediaServerUsers)
          .set({ lastWatchSyncAt: started.toISOString(), ...(full ? { lastFullSyncAt: started.toISOString() } : {}) })
          .where(eq(mediaServerUsers.id, row.id))
          .run();
        out.users++;
      }
      // Retention trusts stored state once every active account had a full read.
      const active = this.store.db
        .select()
        .from(mediaServerUsers)
        .where(and(eq(mediaServerUsers.serverId, config.id), eq(mediaServerUsers.disabled, false), eq(mediaServerUsers.deleted, false)))
        .all();
      const fullTimes = active.map((a) => a.lastFullSyncAt);
      const lastFullSyncAt = fullTimes.length > 0 && fullTimes.every((t) => t !== null) ? fullTimes.reduce((a, b) => (a! < b! ? a : b)) : null;
      this.store.patchSyncState(config.id, { lastStatus: 'ok', lastError: null, lastSyncAt: this.now().toISOString(), lastFullSyncAt });
    } catch (err) {
      out.status = 'failed';
      out.message = messageOf(err);
      this.store.patchSyncState(config.id, { lastStatus: 'failed', lastError: out.message });
      this.log?.warn({ err, server: config.name }, 'watch history sync failed');
    }
    return out;
  }

  /** Inserts or refreshes an account row from the server's user list (no rename/link handling). */
  private upsertAccount(serverId: string, account: MediaServerUser): MediaServerUserRow {
    const row = this.store.ensureAccount(serverId, account.id, account.name);
    const patch = { isAdmin: account.isAdmin, disabled: account.isDisabled, deleted: false, lastActivityAt: account.lastActivityAt };
    if (row.isAdmin === patch.isAdmin && row.disabled === patch.disabled && !row.deleted && row.lastActivityAt === patch.lastActivityAt) return row;
    return this.store.db.update(mediaServerUsers).set({ ...patch, updatedAt: this.store.iso() }).where(eq(mediaServerUsers.id, row.id)).returning().get()!;
  }

  // ---- accounts --------------------------------------------------------------------------

  /** MediaServerUserSync: every enabled Jellyfin/Emby server (or just `serverId`). */
  async syncUsers(opts: { serverId?: string } = {}): Promise<UserSyncResult> {
    const result: UserSyncResult = { servers: [] };
    for (const config of this.servers.stored()) {
      if (!config.enabled || !isMediaBrowserKind(config.kind)) continue;
      if (opts.serverId && config.id !== opts.serverId) continue;
      result.servers.push(await this.syncServerUsers(config));
    }
    return result;
  }

  private async syncServerUsers(config: MediaServerConfig): Promise<UserSyncServerResult> {
    const out: UserSyncServerResult = { serverId: config.id, name: config.name, status: 'ok', added: 0, renamed: 0, disabled: 0, deleted: 0, created: 0 };
    const kind = config.kind as 'jellyfin' | 'emby';
    this.store.patchSyncState(config.id, { lastUserSyncStatus: 'running' });
    try {
      const client = this.client(config);
      const listed = await client.users();
      const linked = linkedUsers(this.store.db);
      const accounts = this.accounts?.();
      const policy = getSection(this.store.db, 'signIn');
      const autoCreate = config.loginEnabled && config.createUsersOnLogin && policy[kind] && policy.newUsers === 'automatic';
      const existing = new Map(
        this.store.db
          .select()
          .from(mediaServerUsers)
          .where(eq(mediaServerUsers.serverId, config.id))
          .all()
          .map((r) => [r.externalId, r]),
      );
      const now = this.store.iso();
      for (const account of listed) {
        const key = normaliseExternalId(account.id);
        const row = existing.get(key);
        existing.delete(key);
        const link = linked.get(`${kind}:${key}`);
        if (!row) {
          this.store.ensureAccount(config.id, account.id, account.name);
          this.upsertAccount(config.id, account);
          out.added++;
          if (autoCreate && accounts && !link && !account.isDisabled) {
            try {
              await accounts.createLinkedUser(
                { id: account.id, username: account.name, isAdmin: account.isAdmin, isDisabled: account.isDisabled },
                { kind, externalId: account.id, username: account.name, linkedAt: now },
              );
              out.created++;
            } catch (err) {
              this.log?.warn({ err, server: config.name }, 'could not create a user for a new media server account');
            }
          }
          continue;
        }
        if (row.name !== account.name) {
          out.renamed++;
          if (link) this.patchLink(link.id, { username: account.name });
        }
        if (account.isDisabled && !row.disabled) {
          out.disabled++;
          // Media-server-only accounts cannot sign in while disabled; end their open sessions too.
          if (link && !link.localPassword) accounts?.revokeSessions(link.id);
        }
        this.store.db
          .update(mediaServerUsers)
          .set({ name: account.name, isAdmin: account.isAdmin, disabled: account.isDisabled, deleted: false, lastActivityAt: account.lastActivityAt, updatedAt: now })
          .where(eq(mediaServerUsers.id, row.id))
          .run();
      }
      if (config.mirrorParentalControls && accounts) out.mirrored = this.mirrorParental(kind, listed);
      // A server always lists at least its admin; an empty list is a broken answer, not "everyone left".
      if (listed.length > 0) {
        for (const row of existing.values()) {
          if (row.deleted) continue;
          out.deleted++;
          this.store.db.update(mediaServerUsers).set({ deleted: true, updatedAt: now }).where(eq(mediaServerUsers.id, row.id)).run();
          // The account is gone: unlink it (the history stays with the account row).
          const link = linked.get(`${kind}:${row.externalId}`);
          if (link) accounts?.patchUserSettings(link.id, { mediaServerLink: undefined });
        }
      }
      this.store.patchSyncState(config.id, { lastUserSyncStatus: 'ok', lastUserSyncError: null, lastUserSyncAt: now });
    } catch (err) {
      out.status = 'failed';
      out.message = messageOf(err);
      this.store.patchSyncState(config.id, { lastUserSyncStatus: 'failed', lastUserSyncError: out.message });
      this.log?.warn({ err, server: config.name }, 'media server user sync failed');
    }
    return out;
  }

  /**
   * "Mirror Jellyfin parental controls": linked accounts' MaxParentalRating becomes the Arclight
   * user's content caps (overwriting manual edits). Returns how many users changed.
   */
  private mirrorParental(kind: 'jellyfin' | 'emby', listed: MediaServerUser[]): number {
    const accounts = this.accounts?.();
    if (!accounts) return 0;
    const linked = linkedUsers(this.store.db); // re-read: this sync may have created links
    let changed = 0;
    for (const account of listed) {
      if (!account.parental) continue;
      const link = linked.get(`${kind}:${normaliseExternalId(account.id)}`);
      if (!link) continue;
      const row = this.store.db.select({ settings: users.settings }).from(users).where(eq(users.id, link.id)).get();
      const current = ((row?.settings ?? {}) as Record<string, unknown>)['contentRestrictions'];
      const next = parentalRatingToCaps(account.parental.maxRating, current);
      const parsed = ContentRestrictions.safeParse(current ?? {});
      const before = parsed.success ? parsed.data.maxCertification : { movie: null, tv: null };
      if (before.movie === next.maxCertification.movie && before.tv === next.maxCertification.tv && current !== undefined) continue;
      if (current === undefined && next.maxCertification.movie === null && next.maxCertification.tv === null) continue;
      accounts.patchUserSettings(link.id, { contentRestrictions: next });
      changed++;
    }
    return changed;
  }

  private patchLink(userId: number, patch: Partial<MediaServerLink>): void {
    const accounts = this.accounts?.();
    if (!accounts) return;
    const row = this.store.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get();
    const link = ((row?.settings ?? {}) as Record<string, unknown>)['mediaServerLink'];
    if (!link || typeof link !== 'object') return;
    accounts.patchUserSettings(userId, { mediaServerLink: { ...(link as MediaServerLink), ...patch } });
  }
}
