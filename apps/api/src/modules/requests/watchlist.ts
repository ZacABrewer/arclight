import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  WatchlistCreate,
  type DiscoverItem,
  type MediaType,
  type UserRequestSettings,
  type WatchlistItem,
  type WatchlistSource,
  type WatchlistSyncResult,
} from '@media-tron/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { RequestsError } from './errors.js';
import { type Actor, can, canAutoRequest, canManageUsers } from './permissions.js';
import { Permission } from '@media-tron/shared';
import { watchlistItems } from './schema.js';
import type { RequestsService } from './service.js';
import { allUserRows, requestSettingsOf, userPermissions, userRow, type UserRow } from './users.js';

// Watchlists (docs/spec/requests.md section 11): a per-user list, filled by hand or synced
// from a media server. Sync providers are pluggable; Plex (plex.tv watchlist with the user's
// own token) is implemented, Jellyfin is a placeholder until it grows a watchlist API.

type ItemRow = typeof watchlistItems.$inferSelect;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One entry of a remote watchlist. Items without a tmdbId are resolved through TMDB. */
export interface WatchlistProviderItem {
  mediaType: MediaType;
  title: string;
  year?: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
  externalId?: string | null;
}

export interface WatchlistProvider {
  readonly source: Exclude<WatchlistSource, 'manual'>;
  /** null: the user has not connected this provider (skip). */
  fetch(user: UserRow, settings: UserRequestSettings, signal?: AbortSignal): Promise<WatchlistProviderItem[] | null>;
}

export const PLEX_WATCHLIST_URL = 'https://discover.provider.plex.tv/library/sections/watchlist/all';
const PLEX_PAGE_SIZE = 50;
const PLEX_MAX_PAGES = 40;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function guidIds(guids: unknown): { tmdbId: number | null; imdbId: string | null; tvdbId: number | null } {
  const out = { tmdbId: null as number | null, imdbId: null as string | null, tvdbId: null as number | null };
  for (const g of Array.isArray(guids) ? guids : []) {
    const id = asRecord(g)?.['id'];
    if (typeof id !== 'string') continue;
    const [scheme, value = ''] = id.split('://');
    if (scheme === 'tmdb' && /^\d+$/.test(value)) out.tmdbId = Number(value);
    else if (scheme === 'tvdb' && /^\d+$/.test(value)) out.tvdbId = Number(value);
    else if (scheme === 'imdb' && /^tt\d+$/.test(value)) out.imdbId = value;
  }
  return out;
}

/** plex.tv watchlist of the user's own account (token from `settings.plexToken`). */
export function plexWatchlistProvider(fetchImpl: FetchLike = (u, i) => globalThis.fetch(u, i)): WatchlistProvider {
  return {
    source: 'plex',
    async fetch(_user, settings, signal) {
      if (!settings.plexToken) return null;
      const out: WatchlistProviderItem[] = [];
      for (let page = 0; page < PLEX_MAX_PAGES; page++) {
        const url = new URL(PLEX_WATCHLIST_URL);
        url.searchParams.set('includeGuids', '1');
        url.searchParams.set('X-Plex-Container-Start', String(page * PLEX_PAGE_SIZE));
        url.searchParams.set('X-Plex-Container-Size', String(PLEX_PAGE_SIZE));
        // The token travels in a header, never the query string, so it stays out of logs.
        const res = await fetchImpl(url.toString(), {
          headers: { Accept: 'application/json', 'X-Plex-Token': settings.plexToken, 'X-Plex-Client-Identifier': 'media-tron', 'X-Plex-Product': 'Media-Tron' },
          ...(signal ? { signal } : {}),
        });
        if (res.status === 401) throw new Error('Plex rejected the token');
        if (!res.ok) throw new Error(`Plex watchlist answered HTTP ${res.status}`);
        const container = asRecord(asRecord(await res.json())?.['MediaContainer']);
        const rows = Array.isArray(container?.['Metadata']) ? (container['Metadata'] as unknown[]) : [];
        for (const raw of rows) {
          const r = asRecord(raw);
          const type = r?.['type'];
          const mediaType: MediaType | null = type === 'movie' ? 'movie' : type === 'show' ? 'series' : null;
          const title = typeof r?.['title'] === 'string' ? r['title'] : '';
          if (!r || !mediaType || !title) continue;
          out.push({
            mediaType,
            title,
            year: typeof r['year'] === 'number' ? r['year'] : null,
            externalId: typeof r['ratingKey'] === 'string' ? r['ratingKey'] : null,
            ...guidIds(r['Guid']),
          });
        }
        const total = typeof container?.['totalSize'] === 'number' ? container['totalSize'] : rows.length;
        if (rows.length < PLEX_PAGE_SIZE || (page + 1) * PLEX_PAGE_SIZE >= total) break;
      }
      return out;
    },
  };
}

/** Placeholder: Jellyfin has no server-side watchlist API yet (favourites could stand in). */
export const jellyfinWatchlistProvider: WatchlistProvider = {
  source: 'jellyfin',
  fetch: async () => null,
};

export interface WatchlistServiceOptions {
  db: Db;
  log?: Logger;
  requests: RequestsService;
  providers?: WatchlistProvider[];
}

export class WatchlistService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly requests: RequestsService;
  private readonly providers: WatchlistProvider[];

  constructor(opts: WatchlistServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.requests = opts.requests;
    this.providers = opts.providers ?? [plexWatchlistProvider(), jellyfinWatchlistProvider];
  }

  has(userId: number, type: MediaType, tmdbId: number): boolean {
    return (
      this.db
        .select({ id: watchlistItems.id })
        .from(watchlistItems)
        .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.mediaType, type), eq(watchlistItems.tmdbId, tmdbId)))
        .get() !== undefined
    );
  }

  private rows(userId: number): ItemRow[] {
    return this.db.select().from(watchlistItems).where(eq(watchlistItems.userId, userId)).orderBy(desc(watchlistItems.createdAt), desc(watchlistItems.id)).all();
  }

  private toResources(rows: ItemRow[]): WatchlistItem[] {
    const statuses = {
      movie: this.requests.titleStatuses('movie', rows.filter((r) => r.mediaType === 'movie').map((r) => r.tmdbId)),
      series: this.requests.titleStatuses('series', rows.filter((r) => r.mediaType === 'series').map((r) => r.tmdbId)),
    };
    return rows.map((r) => {
      const st = statuses[r.mediaType].get(r.tmdbId);
      return {
        id: r.id,
        userId: r.userId,
        mediaType: r.mediaType,
        tmdbId: r.tmdbId,
        title: r.title,
        year: r.year,
        posterUrl: r.poster,
        source: r.source,
        createdAt: r.createdAt,
        mediaStatus: st?.status ?? 'unknown',
        requestId: st?.request?.id ?? null,
        requestStatus: st?.request?.status ?? null,
      };
    });
  }

  list(actor: Actor, userId?: number): WatchlistItem[] {
    const target = userId ?? actor.userId;
    if (target === null || target === undefined) return [];
    if (target !== actor.userId && !can(actor.permissions, Permission.WATCHLIST_VIEW)) {
      throw RequestsError.forbidden("viewing other users' watchlists needs View watchlists");
    }
    userRow(this.db, target);
    return this.toResources(this.rows(target));
  }

  asDiscoverItems(userId: number): DiscoverItem[] {
    return this.toResources(this.rows(userId).slice(0, 40)).map((w) => ({
      mediaType: w.mediaType,
      tmdbId: w.tmdbId,
      title: w.title,
      year: w.year ?? null,
      overview: '',
      posterUrl: w.posterUrl ?? null,
      mediaStatus: w.mediaStatus,
      mediaStatus4k: 'unknown',
      requestId: w.requestId ?? null,
      requestStatus: w.requestStatus ?? null,
    }));
  }

  private async titleOf(type: MediaType, tmdbId: number): Promise<{ title: string; year: number | null; poster: string | null }> {
    let client;
    try {
      client = this.requests.titles.client();
    } catch (err) {
      throw new RequestsError('NOT_CONFIGURED', err instanceof Error ? err.message : 'TMDB is not configured');
    }
    try {
      const meta = type === 'movie' ? await client.getMovie(tmdbId) : await client.getSeries(tmdbId);
      return { title: meta.title, year: meta.year ?? null, poster: meta.images.poster ?? null };
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'not-found') throw RequestsError.notFound('TMDB title', tmdbId);
      throw err;
    }
  }

  async add(actor: Actor, raw: WatchlistCreate): Promise<WatchlistItem> {
    const input = WatchlistCreate.parse(raw);
    if (actor.userId === null) throw new RequestsError('VALIDATION', 'a watchlist belongs to a signed-in user');
    if (this.has(actor.userId, input.mediaType, input.tmdbId)) throw new RequestsError('CONFLICT', 'already on your watchlist');
    const meta = await this.titleOf(input.mediaType, input.tmdbId);
    const row = this.db
      .insert(watchlistItems)
      .values({ userId: actor.userId, mediaType: input.mediaType, tmdbId: input.tmdbId, ...meta, source: 'manual', createdAt: this.requests.now().toISOString() })
      .returning()
      .get();
    return this.toResources([row])[0]!;
  }

  remove(actor: Actor, id: number): void {
    const row = this.db.select().from(watchlistItems).where(eq(watchlistItems.id, id)).get();
    if (!row) throw RequestsError.notFound('watchlist item', id);
    if (row.userId !== actor.userId && !canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    this.db.delete(watchlistItems).where(eq(watchlistItems.id, id)).run();
  }

  /** Resolves an item to a TMDB id through TMDB "find" when the provider did not give one. */
  private async resolveTmdbId(item: WatchlistProviderItem): Promise<number | null> {
    if (item.tmdbId) return item.tmdbId;
    try {
      const client = this.requests.titles.client();
      const found = item.imdbId ? await client.findByImdbId(item.imdbId) : item.tvdbId ? await client.findByTvdbId(item.tvdbId) : [];
      return found.find((r) => r.mediaType === item.mediaType)?.tmdbId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * WatchlistSync: for every user with a connected provider, mirror the remote list into
   * theirs (source = provider) and auto-request new titles when the user holds an
   * AUTO_REQUEST permission and enabled sync for that media type.
   */
  async sync(signal?: AbortSignal): Promise<WatchlistSyncResult> {
    const result: WatchlistSyncResult = { users: 0, added: 0, requested: 0 };
    for (const user of allUserRows(this.db)) {
      const settings = requestSettingsOf(user);
      for (const provider of this.providers) {
        if (signal?.aborted) throw new Error('cancelled');
        let items: WatchlistProviderItem[] | null;
        try {
          items = await provider.fetch(user, settings, signal);
        } catch (err) {
          this.log?.warn({ err, userId: user.id, provider: provider.source }, 'watchlist fetch failed');
          continue;
        }
        if (items === null) continue;
        result.users++;
        const seen = new Set<string>();
        for (const item of items) {
          const tmdbId = await this.resolveTmdbId(item);
          if (!tmdbId) continue;
          seen.add(`${item.mediaType}:${tmdbId}`);
          if (!this.has(user.id, item.mediaType, tmdbId)) {
            this.db
              .insert(watchlistItems)
              .values({
                userId: user.id,
                mediaType: item.mediaType,
                tmdbId,
                title: item.title,
                year: item.year ?? null,
                poster: null,
                source: provider.source,
                externalId: item.externalId ?? null,
                createdAt: this.requests.now().toISOString(),
              })
              .run();
            result.added++;
          }
          if (await this.autoRequest(user, settings, item.mediaType, tmdbId)) result.requested++;
        }
        // Items the provider no longer lists leave the mirror (manual items stay).
        const stale = this.db
          .select()
          .from(watchlistItems)
          .where(and(eq(watchlistItems.userId, user.id), eq(watchlistItems.source, provider.source)))
          .all()
          .filter((r) => !seen.has(`${r.mediaType}:${r.tmdbId}`))
          .map((r) => r.id);
        if (stale.length) this.db.delete(watchlistItems).where(inArray(watchlistItems.id, stale)).run();
      }
    }
    return result;
  }

  private async autoRequest(user: UserRow, settings: UserRequestSettings, type: MediaType, tmdbId: number): Promise<boolean> {
    const held = userPermissions(user);
    if (!canAutoRequest(held, type)) return false;
    if (type === 'movie' ? !settings.watchlistSyncMovies : !settings.watchlistSyncSeries) return false;
    const status = this.requests.titleStatuses(type, [tmdbId]).get(tmdbId);
    if (type === 'movie' && status && status.status !== 'unknown') return false;
    if (type === 'series' && status?.status === 'available') return false;
    try {
      const outcome = await this.requests.create(
        { userId: user.id, permissions: held },
        { mediaType: type, tmdbId, ...(type === 'series' ? { seasons: 'all' as const } : {}) },
        { isAutoRequest: true },
      );
      return outcome.kind === 'created';
    } catch (err) {
      // Permission, duplicate, quota and exclusion refusals are expected here.
      this.log?.debug({ err, userId: user.id, tmdbId }, 'watchlist auto-request skipped');
      return false;
    }
  }
}
