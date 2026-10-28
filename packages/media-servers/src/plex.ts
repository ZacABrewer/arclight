/**
 * Plex Media Server read client, called with the owner's X-Plex-Token.
 *
 * Plex cannot filter by external id, so items are found through an index of the movie/show
 * sections (`includeGuids=1`), built once per client instance. Play state differs by user:
 * the owner's state is on the items themselves (viewCount, lastViewedAt, viewOffset,
 * viewedLeafCount); every other account's state comes from the server's watch history
 * (`status/sessions/history/all?accountID=`), where a show counts as played once every
 * episode present (leafCount) appears in that account's history.
 */

import { emptyIds, idsMatchQuery, isoFromSeconds, joinUrl, laterOf, list, normaliseBaseUrl, num, queryHasIds, rec, request, requestJson, str } from './http.js';
import type {
  FetchLike,
  FindItemsQuery,
  ItemPlayState,
  MediaKind,
  MediaServerClient,
  MediaServerItem,
  MediaServerLibrary,
  MediaServerUser,
  PlayState,
  ProviderIds,
  RefreshOptions,
  ServerInfo,
} from './types.js';
import { MediaServerError } from './types.js';

/** The server-local account id of the owner. */
export const PLEX_OWNER_ACCOUNT_ID = '1';

export interface PlexServerOptions {
  url: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Items per page for listings. Default 500. */
  pageSize?: number;
  clientIdentifier?: string;
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids from a Plex item: the new agents' `Guid` array and/or a legacy agent `guid` string.
 * Music agents report `mbid://<uuid>`: a release group on albums (`type` album), the artist
 * on artists.
 */
export function plexProviderIds(item: Record<string, unknown>): ProviderIds {
  const out = emptyIds();
  const type = str(item['type']);
  const apply = (guid: string): void => {
    const m = /^(?:com\.plexapp\.agents\.)?([a-z]+):\/\/([^/?#]+)/i.exec(guid);
    if (!m) return;
    const scheme = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? '';
    if ((scheme === 'tmdb' || scheme === 'themoviedb') && /^\d+$/.test(value)) out.tmdbId ??= Number(value);
    else if ((scheme === 'tvdb' || scheme === 'thetvdb') && /^\d+$/.test(value)) out.tvdbId ??= Number(value);
    else if (scheme === 'imdb' && /^tt\d+$/i.test(value)) out.imdbId ??= value.toLowerCase();
    else if ((scheme === 'mbid' || scheme === 'musicbrainz') && MBID.test(value)) {
      if (type === 'artist') out.mbArtistId ??= value.toLowerCase();
      else out.mbReleaseGroupId ??= value.toLowerCase();
    } else if (scheme === 'audible' && /^[0-9A-Z]{10}$/i.test(value)) out.asin ??= value.toUpperCase();
    else if (scheme === 'isbn') out.isbn ??= value.replace(/[\s-]/g, '').toUpperCase();
  };
  for (const g of list(item['Guid'])) {
    const id = str(rec(g)['id']);
    if (id) apply(id);
  }
  const legacy = str(item['guid']);
  if (legacy) apply(legacy);
  return out;
}

/** Forward slashes, no trailing slash; drive-letter paths compare case-insensitively. */
export function normalisePath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

export function pathIsInside(child: string, parent: string): boolean {
  const c = normalisePath(child);
  const p = normalisePath(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** Rating key from a `/library/metadata/123` style key. */
function keyId(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const m = /\/library\/metadata\/(\d+)/.exec(s);
  return m ? (m[1] ?? null) : /^\d+$/.test(s) ? s : null;
}

interface IndexedRow {
  item: MediaServerItem;
  raw: Record<string, unknown>;
}

interface HistoryEntry {
  ratingKey: string | null;
  showKey: string | null;
  type: string;
  viewedAt: string | null;
}

/** Plex section type to library kind (`artist` sections hold music, and audiobooks by path). */
export function plexLibraryKind(type: string | null): MediaKind | 'other' {
  return type === 'movie' ? 'movie' : type === 'show' ? 'series' : type === 'artist' ? 'music' : 'other';
}

/** Section kind a media kind lives in on Plex. */
const plexSectionKind = (kind: MediaKind): MediaKind => (kind === 'audiobook' ? 'music' : kind);

export class PlexServerReadClient implements MediaServerClient {
  readonly kind = 'plex' as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  private readonly pageSize: number;
  private readonly clientIdentifier: string;
  private sectionsCache: Promise<MediaServerLibrary[]> | null = null;
  private readonly index = new Map<MediaKind, Promise<IndexedRow[]>>();
  private readonly history = new Map<string, Promise<HistoryEntry[]>>();

  constructor(opts: PlexServerOptions) {
    if (!opts.url.trim()) throw new MediaServerError('plex', 'invalidSettings', 'Plex URL is not configured');
    if (!opts.token.trim()) throw new MediaServerError('plex', 'invalidSettings', 'Plex token is not configured');
    this.base = normaliseBaseUrl(opts.url);
    this.token = opts.token.trim();
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs;
    this.pageSize = opts.pageSize ?? 500;
    this.clientIdentifier = opts.clientIdentifier ?? 'arclight';
  }

  private headers(): Record<string, string> {
    return {
      'X-Plex-Token': this.token,
      'X-Plex-Client-Identifier': this.clientIdentifier,
      'X-Plex-Product': 'Arclight',
      'X-Plex-Device-Name': 'Arclight',
    };
  }

  private async container(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const body = await requestJson(this.fetchImpl, 'plex', joinUrl(this.base, path), {
      headers: this.headers(),
      query,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return rec(rec(body)['MediaContainer']);
  }

  private async pagedMetadata(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let start = 0; start < 1_000_000; start += this.pageSize) {
      const mc = await this.container(path, {
        ...query,
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(this.pageSize),
      });
      const rows = list(mc['Metadata']).map(rec);
      out.push(...rows);
      const total = num(mc['totalSize']) ?? num(mc['size']) ?? rows.length;
      if (rows.length < this.pageSize || start + this.pageSize >= total) break;
    }
    return out;
  }

  async info(): Promise<ServerInfo> {
    const mc = await this.container('');
    const version = str(mc['version']);
    const id = str(mc['machineIdentifier']);
    return { name: str(mc['friendlyName']) ?? 'Plex', ...(version ? { version } : {}), ...(id ? { id } : {}) };
  }

  libraries(): Promise<MediaServerLibrary[]> {
    if (!this.sectionsCache) {
      this.sectionsCache = this.container('library/sections').then((mc) =>
        list(mc['Directory']).map((raw) => {
          const d = rec(raw);
          const type = str(d['type']);
          return {
            id: str(d['key']) ?? '',
            name: str(d['title']) ?? '',
            type: plexLibraryKind(type),
            locations: list(d['Location']).flatMap((l) => {
              const p = str(rec(l)['path']);
              return p ? [p] : [];
            }),
          } satisfies MediaServerLibrary;
        }),
      );
      this.sectionsCache.catch(() => {
        this.sectionsCache = null;
      });
    }
    return this.sectionsCache;
  }

  async users(): Promise<MediaServerUser[]> {
    const mc = await this.container('accounts');
    return list(mc['Account']).flatMap((raw) => {
      const a = rec(raw);
      const id = str(a['id']);
      const name = str(a['name']);
      // Account 0 is a placeholder for unauthenticated local playback.
      if (!id || id === '0' || !name) return [];
      return [{ id, name, isAdmin: id === PLEX_OWNER_ACCOUNT_ID, isDisabled: false, lastActivityAt: null }];
    });
  }

  private indexed(mediaType: MediaKind): Promise<IndexedRow[]> {
    let cached = this.index.get(mediaType);
    if (!cached) {
      cached = (async () => {
        const sections = (await this.libraries()).filter((s) => s.type === mediaType);
        const rows: IndexedRow[] = [];
        for (const section of sections) {
          // Music items are albums (type 9); the default listing of an artist section is artists.
          const query: Record<string, string> = mediaType === 'music' ? { includeGuids: '1', type: '9' } : { includeGuids: '1' };
          const metadata = await this.pagedMetadata(`library/sections/${encodeURIComponent(section.id)}/all`, query);
          for (const raw of metadata) {
            const item = toItem(raw, mediaType, section.id);
            if (item) rows.push({ item, raw });
          }
        }
        return rows;
      })();
      cached.catch(() => this.index.delete(mediaType));
      this.index.set(mediaType, cached);
    }
    return cached;
  }

  async listItems(mediaType: MediaKind): Promise<MediaServerItem[]> {
    return (await this.indexed(mediaType)).map((r) => r.item);
  }

  async findItems(query: FindItemsQuery): Promise<MediaServerItem[]> {
    if (!queryHasIds(query)) return [];
    return (await this.listItems(query.mediaType)).filter((i) => idsMatchQuery(i.ids, query));
  }

  /** One account's watch history, oldest pages included (cached per client instance). */
  private accountHistory(accountId: string): Promise<HistoryEntry[]> {
    let cached = this.history.get(accountId);
    if (!cached) {
      cached = this.pagedMetadata('status/sessions/history/all', { accountID: accountId, sort: 'viewedAt:desc' }).then((rows) =>
        rows.map((h) => ({
          ratingKey: str(h['ratingKey']) ?? keyId(h['key']),
          showKey: str(h['grandparentRatingKey']) ?? keyId(h['grandparentKey']),
          type: str(h['type']) ?? '',
          viewedAt: isoFromSeconds(h['viewedAt']),
        })),
      );
      cached.catch(() => this.history.delete(accountId));
      this.history.set(accountId, cached);
    }
    return cached;
  }

  async playState(item: Pick<MediaServerItem, 'id' | 'mediaType'>, userId: string): Promise<PlayState> {
    const mc = await this.container(`library/metadata/${encodeURIComponent(item.id)}`);
    const raw = rec(list(mc['Metadata'])[0]);
    if (userId === PLEX_OWNER_ACCOUNT_ID) return ownerState(userId, item.mediaType, raw);
    return historyState(userId, item.mediaType, item.id, raw, await this.accountHistory(userId));
  }

  async listPlayStates(userId: string, mediaType: MediaKind): Promise<ItemPlayState[]> {
    const rows = await this.indexed(mediaType);
    if (userId === PLEX_OWNER_ACCOUNT_ID) return rows.map((r) => ({ item: r.item, state: ownerState(userId, mediaType, r.raw) }));
    const history = await this.accountHistory(userId);
    return rows.map((r) => ({ item: r.item, state: historyState(userId, mediaType, r.item.id, r.raw, history) }));
  }

  async refreshLibrary(options: RefreshOptions = {}): Promise<void> {
    const wanted = options.mediaType ? plexSectionKind(options.mediaType) : undefined;
    const sections = (await this.libraries()).filter((s) => (wanted ? s.type === wanted : s.type === 'movie' || s.type === 'series'));
    const path = options.path;
    const matching = path ? sections.filter((s) => s.locations.some((loc) => pathIsInside(path, loc))) : sections;
    // A path outside every section: let Plex rescan the candidate sections in full.
    const targets = matching.length > 0 ? matching : sections;
    for (const section of targets) {
      await request(this.fetchImpl, 'plex', joinUrl(this.base, `library/sections/${encodeURIComponent(section.id)}/refresh`), {
        headers: this.headers(),
        query: path && matching.length > 0 ? { path } : {},
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
    }
  }
}

function toItem(raw: Record<string, unknown>, mediaType: MediaKind, sectionId: string): MediaServerItem | null {
  const id = str(raw['ratingKey']);
  if (!id) return null;
  const media = rec(list(raw['Media'])[0]);
  const part = rec(list(media['Part'])[0]);
  const location = rec(list(raw['Location'])[0]);
  return {
    id,
    mediaType,
    title: str(raw['title']) ?? id,
    year: num(raw['year']),
    ids: plexProviderIds(raw),
    path: str(part['file']) ?? str(location['path']),
    libraryId: str(raw['librarySectionID']) ?? sectionId,
  };
}

function ownerState(userId: string, mediaType: MediaKind, raw: Record<string, unknown>): PlayState {
  const duration = num(raw['duration']);
  const lastPlayedAt = isoFromSeconds(raw['lastViewedAt']);
  const viewCount = num(raw['viewCount']) ?? 0;
  if (mediaType === 'movie') {
    return {
      userId,
      played: viewCount > 0,
      playCount: viewCount,
      lastPlayedAt,
      positionMs: num(raw['viewOffset']) ?? 0,
      durationMs: duration,
    };
  }
  const total = num(raw['leafCount']) ?? 0;
  const played = num(raw['viewedLeafCount']) ?? 0;
  return {
    userId,
    played: total > 0 && played >= total,
    playCount: viewCount,
    lastPlayedAt,
    positionMs: num(raw['viewOffset']) ?? 0,
    durationMs: duration,
    episodes: { total, played: Math.min(played, total) },
  };
}

function historyState(userId: string, mediaType: MediaKind, itemId: string, raw: Record<string, unknown>, history: HistoryEntry[]): PlayState {
  const duration = num(raw['duration']);
  if (mediaType === 'movie') {
    const views = history.filter((h) => h.ratingKey === itemId);
    const lastPlayedAt = views.reduce<string | null>((acc, h) => laterOf(acc, h.viewedAt), null);
    return { userId, played: views.length > 0, playCount: views.length, lastPlayedAt, positionMs: 0, durationMs: duration };
  }
  const views = history.filter((h) => h.showKey === itemId);
  const distinct = new Set(views.map((h) => h.ratingKey ?? ''));
  distinct.delete('');
  const total = num(raw['leafCount']) ?? 0;
  const lastPlayedAt = views.reduce<string | null>((acc, h) => laterOf(acc, h.viewedAt), null);
  return {
    userId,
    played: total > 0 && distinct.size >= total,
    playCount: views.length,
    lastPlayedAt,
    positionMs: 0,
    durationMs: duration,
    episodes: { total, played: Math.min(distinct.size, total) },
  };
}
