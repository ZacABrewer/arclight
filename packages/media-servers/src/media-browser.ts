/**
 * Jellyfin and Emby read client. Both speak the MediaBrowser REST API; the differences that
 * matter here are header names (both are sent) and Jellyfin 10.9+ ignoring the
 * `AnyProviderIdEquals` filter, which is why matches are verified client-side and fall back to
 * a full library index.
 *
 * Play state comes from the per-user item endpoints (`Users/{id}/Items`), whose `UserData`
 * carries Played / PlayCount / LastPlayedDate / PlaybackPositionTicks. A series is evaluated
 * from its episodes: played when every present episode is played.
 */

import {
  emptyIds,
  idsMatchQuery,
  isoDate,
  joinUrl,
  laterOf,
  list,
  normaliseBaseUrl,
  normaliseIsbn,
  num,
  queryHasIds,
  rec,
  request,
  requestJson,
  str,
} from './http.js';
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

export type MediaBrowserKind = 'jellyfin' | 'emby';

export interface MediaBrowserServerOptions {
  kind: MediaBrowserKind;
  url: string;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Items per page for listings. Default 500. */
  pageSize?: number;
}

/** 100-nanosecond ticks to milliseconds. */
export function ticksToMs(value: unknown): number {
  const n = num(value);
  return n !== null && n > 0 ? Math.round(n / 10_000) : 0;
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads provider ids regardless of key case: `Tmdb`/`Tvdb`/`Imdb`, and for audio
 * `MusicBrainzReleaseGroup`, `MusicBrainzAlbumArtist`/`MusicBrainzArtist`, `Audible`/`Asin`,
 * `Isbn`. Audio ids are set only when present.
 */
export function mediaBrowserProviderIds(raw: unknown): ProviderIds {
  const out = emptyIds();
  for (const [key, value] of Object.entries(rec(raw))) {
    const k = key.toLowerCase();
    const text = typeof value === 'string' ? value.trim() : '';
    if (k === 'tmdb') out.tmdbId = num(value);
    else if (k === 'tvdb') out.tvdbId = num(value);
    else if (k === 'imdb' && /^tt\d+$/i.test(text)) out.imdbId = text.toLowerCase();
    else if (k === 'musicbrainzreleasegroup' && MBID.test(text)) out.mbReleaseGroupId = text.toLowerCase();
    else if ((k === 'musicbrainzalbumartist' || (k === 'musicbrainzartist' && !out.mbArtistId)) && MBID.test(text)) out.mbArtistId = text.toLowerCase();
    else if ((k === 'audible' || k === 'asin') && /^[0-9A-Z]{10}$/i.test(text)) out.asin = text.toUpperCase();
    else if (k === 'isbn' && /^[\d\s-]{9,17}[\dX]$/i.test(text)) out.isbn = normaliseIsbn(text);
  }
  return out;
}

const ITEM_FIELDS = 'ProviderIds,Path,ProductionYear,ParentId';

/** MediaBrowser item type listed for each kind (music items are albums). */
const ITEM_TYPE: Record<MediaKind, string> = { movie: 'Movie', series: 'Series', music: 'MusicAlbum', audiobook: 'AudioBook' };

/** Virtual-folder `CollectionType` to library kind. */
export function mediaBrowserLibraryKind(collectionType: string | null): MediaKind | 'other' {
  switch ((collectionType ?? '').toLowerCase()) {
    case 'movies':
      return 'movie';
    case 'tvshows':
      return 'series';
    case 'music':
      return 'music';
    case 'books':
    case 'audiobooks':
      return 'audiobook';
    default:
      return 'other';
  }
}

export class MediaBrowserServerClient implements MediaServerClient {
  readonly kind: MediaBrowserKind;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  private readonly pageSize: number;
  private readonly index = new Map<MediaKind, Promise<MediaServerItem[]>>();

  constructor(opts: MediaBrowserServerOptions) {
    if (!opts.url.trim()) throw new MediaServerError(opts.kind, 'invalidSettings', `${opts.kind} URL is not configured`);
    if (!opts.apiKey.trim()) throw new MediaServerError(opts.kind, 'invalidSettings', `${opts.kind} API key is not configured`);
    this.kind = opts.kind;
    this.base = normaliseBaseUrl(opts.url);
    this.apiKey = opts.apiKey.trim();
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs;
    this.pageSize = opts.pageSize ?? 500;
  }

  private headers(): Record<string, string> {
    const auth = `MediaBrowser Client="Arclight", Device="Arclight", DeviceId="arclight", Version="1.0.0", Token="${this.apiKey}"`;
    // Jellyfin reads Authorization; Emby reads X-Emby-Authorization; both accept X-Emby-Token.
    return {
      Authorization: auth,
      'X-Emby-Authorization': auth,
      'X-Emby-Token': this.apiKey,
      'X-MediaBrowser-Token': this.apiKey,
    };
  }

  private get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    return requestJson(this.fetchImpl, this.kind, joinUrl(this.base, path), {
      headers: this.headers(),
      query,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
  }

  private async post(path: string, body?: unknown): Promise<void> {
    await request(this.fetchImpl, this.kind, joinUrl(this.base, path), {
      method: 'POST',
      headers: this.headers(),
      ...(body !== undefined ? { body } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
  }

  /** Pages through an `Items`-shaped endpoint. */
  private async paged(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let start = 0; start < 1_000_000; start += this.pageSize) {
      const body = rec(await this.get(path, { ...query, StartIndex: String(start), Limit: String(this.pageSize) }));
      const items = list(body['Items']).map(rec);
      out.push(...items);
      const total = num(body['TotalRecordCount']) ?? items.length;
      if (items.length < this.pageSize || start + this.pageSize >= total) break;
    }
    return out;
  }

  async info(): Promise<ServerInfo> {
    const body = rec(await this.get('System/Info'));
    const version = str(body['Version']);
    const id = str(body['Id']);
    return {
      name: str(body['ServerName']) ?? (this.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'),
      ...(version ? { version } : {}),
      ...(id ? { id } : {}),
    };
  }

  async libraries(): Promise<MediaServerLibrary[]> {
    return list(await this.get('Library/VirtualFolders')).map((raw) => {
      const f = rec(raw);
      const collection = str(f['CollectionType']);
      return {
        id: str(f['ItemId']) ?? str(f['Id']) ?? str(f['Name']) ?? '',
        name: str(f['Name']) ?? '',
        type: mediaBrowserLibraryKind(collection),
        locations: list(f['Locations']).flatMap((l) => (typeof l === 'string' && l ? [l] : [])),
      };
    });
  }

  async users(): Promise<MediaServerUser[]> {
    return list(await this.get('Users')).flatMap((raw) => {
      const u = rec(raw);
      const id = str(u['Id']);
      if (!id) return [];
      const policy = rec(u['Policy']);
      return [
        {
          id,
          name: str(u['Name']) ?? id,
          isAdmin: policy['IsAdministrator'] === true,
          isDisabled: policy['IsDisabled'] === true,
          lastActivityAt: isoDate(u['LastActivityDate']),
        },
      ];
    });
  }

  listItems(mediaType: MediaKind): Promise<MediaServerItem[]> {
    let cached = this.index.get(mediaType);
    if (!cached) {
      cached = this.paged('Items', {
        Recursive: 'true',
        IncludeItemTypes: ITEM_TYPE[mediaType],
        Fields: ITEM_FIELDS,
      }).then((rows) => rows.flatMap((r) => toItem(r) ?? []));
      // A failed listing must not poison the cache.
      cached.catch(() => this.index.delete(mediaType));
      this.index.set(mediaType, cached);
    }
    return cached;
  }

  async findItems(query: FindItemsQuery): Promise<MediaServerItem[]> {
    const filter: string[] = [];
    if (query.tmdbId) filter.push(`Tmdb.${query.tmdbId}`);
    if (query.tvdbId) filter.push(`Tvdb.${query.tvdbId}`);
    if (query.imdbId) filter.push(`Imdb.${query.imdbId}`);
    if (query.mbReleaseGroupId) filter.push(`MusicBrainzReleaseGroup.${query.mbReleaseGroupId}`);
    if (query.mbArtistId) filter.push(`MusicBrainzAlbumArtist.${query.mbArtistId}`);
    if (query.asin) filter.push(`Audible.${query.asin}`);
    if (query.isbn) filter.push(`Isbn.${query.isbn}`);
    if (filter.length === 0 || !queryHasIds(query)) return [];
    const body = rec(
      await this.get('Items', {
        Recursive: 'true',
        IncludeItemTypes: ITEM_TYPE[query.mediaType],
        AnyProviderIdEquals: filter.join(','),
        Fields: ITEM_FIELDS,
        Limit: '50',
      }),
    );
    // Servers that ignore the filter return unrelated items: verify, then fall back to the index.
    const direct = list(body['Items'])
      .flatMap((r) => toItem(rec(r)) ?? [])
      .filter((i) => i.mediaType === query.mediaType && idsMatchQuery(i.ids, query));
    if (direct.length > 0) return direct;
    return (await this.listItems(query.mediaType)).filter((i) => idsMatchQuery(i.ids, query));
  }

  async playState(item: Pick<MediaServerItem, 'id' | 'mediaType'>, userId: string): Promise<PlayState> {
    if (item.mediaType !== 'series') {
      // Movies, albums and books carry their own user data.
      const body = rec(await this.get(`Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(item.id)}`));
      return stateOf(userId, body);
    }
    const episodes = await this.paged(`Users/${encodeURIComponent(userId)}/Items`, {
      ParentId: item.id,
      Recursive: 'true',
      IncludeItemTypes: 'Episode',
      IsMissing: 'false',
      EnableUserData: 'true',
    });
    return aggregateEpisodes(userId, episodes.filter(isPresent));
  }

  async listPlayStates(userId: string, mediaType: MediaKind): Promise<ItemPlayState[]> {
    const userPath = `Users/${encodeURIComponent(userId)}/Items`;
    if (mediaType !== 'series') {
      const rows = await this.paged(userPath, { Recursive: 'true', IncludeItemTypes: ITEM_TYPE[mediaType], Fields: ITEM_FIELDS, EnableUserData: 'true' });
      return rows.flatMap((r) => {
        const item = toItem(r);
        return item ? [{ item, state: stateOf(userId, r) }] : [];
      });
    }
    const series = await this.paged(userPath, { Recursive: 'true', IncludeItemTypes: 'Series', Fields: ITEM_FIELDS });
    const episodes = await this.paged(userPath, {
      Recursive: 'true',
      IncludeItemTypes: 'Episode',
      IsMissing: 'false',
      Fields: 'SeriesId',
      EnableUserData: 'true',
    });
    const bySeries = new Map<string, Record<string, unknown>[]>();
    for (const ep of episodes) {
      if (!isPresent(ep)) continue;
      const seriesId = str(ep['SeriesId']);
      if (!seriesId) continue;
      const bucket = bySeries.get(seriesId);
      if (bucket) bucket.push(ep);
      else bySeries.set(seriesId, [ep]);
    }
    return series.flatMap((r) => {
      const item = toItem(r);
      return item ? [{ item, state: aggregateEpisodes(userId, bySeries.get(item.id) ?? []) }] : [];
    });
  }

  async refreshLibrary(options: RefreshOptions = {}): Promise<void> {
    if (options.path) {
      await this.post('Library/Media/Updated', { Updates: [{ Path: options.path, UpdateType: options.updateType ?? 'Modified' }] });
    } else {
      await this.post('Library/Refresh');
    }
  }
}

function isPresent(ep: Record<string, unknown>): boolean {
  return ep['LocationType'] !== 'Virtual' && ep['IsMissing'] !== true;
}

function toItem(r: Record<string, unknown>): MediaServerItem | null {
  const type = str(r['Type']);
  const mediaType = (Object.keys(ITEM_TYPE) as MediaKind[]).find((k) => ITEM_TYPE[k] === type) ?? null;
  const id = str(r['Id']);
  if (!mediaType || !id) return null;
  return {
    id,
    mediaType,
    title: str(r['Name']) ?? id,
    year: num(r['ProductionYear']),
    ids: mediaBrowserProviderIds(r['ProviderIds']),
    path: str(r['Path']),
    libraryId: str(r['ParentId']),
  };
}

function stateOf(userId: string, item: Record<string, unknown>): PlayState {
  const data = rec(item['UserData']);
  const played = data['Played'] === true;
  const plays = num(data['PlayCount']) ?? 0;
  const duration = ticksToMs(item['RunTimeTicks']);
  return {
    userId,
    played,
    // A server-side "mark played" has no play count; count it once.
    playCount: played ? Math.max(1, plays) : plays,
    lastPlayedAt: isoDate(data['LastPlayedDate']),
    positionMs: ticksToMs(data['PlaybackPositionTicks']),
    durationMs: duration > 0 ? duration : null,
  };
}

function aggregateEpisodes(userId: string, episodes: Record<string, unknown>[]): PlayState {
  let playedCount = 0;
  let playCount = 0;
  let lastPlayedAt: string | null = null;
  let positionMs = 0;
  let durationMs = 0;
  for (const ep of episodes) {
    const s = stateOf(userId, ep);
    if (s.played) playedCount++;
    playCount += s.playCount;
    lastPlayedAt = laterOf(lastPlayedAt, s.lastPlayedAt);
    if (!s.played && s.positionMs > positionMs) positionMs = s.positionMs;
    durationMs += s.durationMs ?? 0;
  }
  return {
    userId,
    played: episodes.length > 0 && playedCount === episodes.length,
    playCount,
    lastPlayedAt,
    positionMs,
    durationMs: durationMs > 0 ? durationMs : null,
    episodes: { total: episodes.length, played: playedCount },
  };
}
