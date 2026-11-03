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
  mergeTags,
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
  WatchItem,
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

/**
 * One movie or episode with one user's play state (the watch-history sync). Episodes carry their
 * series and season ids and numbers so the caller can resolve them against its own library.
 */
/** Jellyfin/Emby play state of one movie or episode (the shared watch-item shape). */
export type MediaBrowserWatchItem = WatchItem;

/** Any item by id (status lookups): type, provider ids and, for episodes and seasons, the series. */
export interface MediaBrowserItemInfo {
  id: string;
  type: string;
  name: string;
  ids: ProviderIds;
  seriesId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface MediaBrowserCollection {
  id: string;
  name: string;
  overview: string | null;
}

/** An Audio item and its file path as the server sees it. */
export interface MediaBrowserAudioPath {
  id: string;
  path: string;
}

/** What to stream: the original bytes, or a server-side transcode. */
export interface MediaBrowserAudioStreamSpec {
  format: 'original' | 'aac' | 'opus' | 'mp3';
  /** Transcodes: target bitrate. */
  bitrateKbps?: number | undefined;
  /** Transcodes: start this far into the file. */
  startMs?: number | undefined;
  /** Transcodes: the server keys its transcode jobs on device + play session. */
  deviceId?: string | undefined;
  playSessionId?: string | undefined;
}

/** Container (the path extension) and codec of each transcode format. */
const AUDIO_TRANSCODE: Record<'aac' | 'opus' | 'mp3', { container: string; codec: string }> = {
  aac: { container: 'aac', codec: 'aac' },
  opus: { container: 'ogg', codec: 'opus' },
  mp3: { container: 'mp3', codec: 'mp3' },
};

/**
 * The `Audio/{id}/stream` request for a spec (the same endpoint on Jellyfin and Emby). Originals
 * use `static=true` (the file as is, with range support); transcodes name the container in the
 * path and pass codec, bitrate (bits/s), start (100 ns ticks) and a stereo downmix.
 */
export function mediaBrowserAudioStream(itemId: string, spec: MediaBrowserAudioStreamSpec): { path: string; query: Record<string, string> } {
  const id = encodeURIComponent(itemId);
  if (spec.format === 'original') return { path: `Audio/${id}/stream`, query: { static: 'true', mediaSourceId: itemId } };
  const t = AUDIO_TRANSCODE[spec.format];
  const query: Record<string, string> = {
    static: 'false',
    mediaSourceId: itemId,
    container: t.container,
    audioCodec: t.codec,
    maxAudioChannels: '2',
    deviceId: spec.deviceId ?? 'arclight',
  };
  if (spec.bitrateKbps && spec.bitrateKbps > 0) query['audioBitRate'] = String(Math.round(spec.bitrateKbps * 1000));
  if (spec.startMs && spec.startMs > 0) query['startTimeTicks'] = String(Math.round(spec.startMs * 10_000));
  if (spec.playSessionId) query['playSessionId'] = spec.playSessionId;
  return { path: `Audio/${id}/stream.${t.container}`, query };
}

/** Item ids per collection add/remove call (keeps the query string short). */
const COLLECTION_BATCH = 50;
/** Fields read before an item update, so the update sends them back unchanged. */
const UPDATE_FIELDS = 'Overview,Genres,Tags,Studios,People,ProviderIds,Taglines,LockedFields,DateCreated,SortName,ForcedSortName,PremiereDate,ProductionYear,OfficialRating,CustomRating';

export interface WatchItemsOptions {
  /**
   * Incremental read: only items whose last play is at or after this ISO time, newest first,
   * stopping at the first older one. Without it every present movie and episode is listed.
   *
   * Jellyfin's `MinDateLastSavedForUser` filter is not used: despite its name the server compares
   * it with the item's own DateLastSaved (metadata saves), not the user's data, so plays would be
   * missed. Sorting by DatePlayed catches plays and progress; un-played and favourite changes
   * only show up in a full read.
   */
  playedSince?: string | null;
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
const ITEM_TYPE: Record<MediaKind, string> = { movie: 'Movie', series: 'Series', music: 'MusicAlbum', audiobook: 'AudioBook', podcast: 'Audio' };

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
          parental: {
            maxRating: typeof policy['MaxParentalRating'] === 'number' ? policy['MaxParentalRating'] : null,
            maxSubRating: typeof policy['MaxParentalSubRating'] === 'number' ? policy['MaxParentalSubRating'] : null,
            blockUnrated: list(policy['BlockUnratedItems']).flatMap((k) => (typeof k === 'string' ? [k] : [])),
          },
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
      // Podcast episodes are plain Audio items: only the played ones are listed (every music
      // track is an Audio item too, so the full list would be the whole music library).
      const filter = mediaType === 'podcast' ? { Filters: 'IsPlayed' } : {};
      const rows = await this.paged(userPath, { Recursive: 'true', IncludeItemTypes: ITEM_TYPE[mediaType], Fields: ITEM_FIELDS, EnableUserData: 'true', ...filter });
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

  /** Movies and episodes with the user's play state (see WatchItemsOptions). */
  async watchItems(userId: string, opts: WatchItemsOptions = {}): Promise<MediaBrowserWatchItem[]> {
    const path = `Users/${encodeURIComponent(userId)}/Items`;
    const query: Record<string, string> = {
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      IsMissing: 'false',
      EnableUserData: 'true',
      Fields: 'ProviderIds',
    };
    if (!opts.playedSince) {
      // A stable order so paging does not skip or repeat items while the library changes.
      return (await this.paged(path, { ...query, SortBy: 'SortName', SortOrder: 'Ascending' })).filter(isPresent).flatMap((r) => toWatchItem(r) ?? []);
    }
    const since = opts.playedSince;
    const out: MediaBrowserWatchItem[] = [];
    for (let start = 0; start < 1_000_000; start += this.pageSize) {
      const body = rec(await this.get(path, { ...query, SortBy: 'DatePlayed', SortOrder: 'Descending', StartIndex: String(start), Limit: String(this.pageSize) }));
      const rows = list(body['Items']).map(rec);
      let older = false;
      for (const row of rows) {
        const item = toWatchItem(row);
        if (!item) continue;
        if (!item.lastPlayedAt || item.lastPlayedAt < since) {
          older = true;
          break;
        }
        if (isPresent(row)) out.push(item);
      }
      const total = num(body['TotalRecordCount']) ?? rows.length;
      if (older || rows.length < this.pageSize || start + this.pageSize >= total) break;
    }
    return out;
  }

  /** Items by Jellyfin/Emby id, any type (unknown ids are left out). */
  async itemsByIds(ids: readonly string[]): Promise<MediaBrowserItemInfo[]> {
    const out: MediaBrowserItemInfo[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const body = rec(await this.get('Items', { Ids: ids.slice(i, i + 100).join(','), Fields: 'ProviderIds' }));
      for (const r of list(body['Items']).map(rec)) {
        const id = str(r['Id']);
        if (!id) continue;
        out.push({
          id,
          type: str(r['Type']) ?? 'Unknown',
          name: str(r['Name']) ?? id,
          ids: mediaBrowserProviderIds(r['ProviderIds']),
          seriesId: str(r['SeriesId']),
          seasonNumber: str(r['Type']) === 'Season' ? num(r['IndexNumber']) : num(r['ParentIndexNumber']),
          episodeNumber: str(r['Type']) === 'Episode' ? num(r['IndexNumber']) : null,
        });
      }
    }
    return out;
  }

  // ---- audio streaming (Arclight's player with the Jellyfin/Emby engine) -------------------

  /**
   * Audio items with the file path the server sees. `searchTerm` narrows by name (one page of
   * `limit`); without it every Audio item is listed (paged), for a path index.
   */
  async audioPaths(opts: { searchTerm?: string; limit?: number } = {}): Promise<MediaBrowserAudioPath[]> {
    const query: Record<string, string> = { Recursive: 'true', IncludeItemTypes: 'Audio', Fields: 'Path', EnableImages: 'false', EnableUserData: 'false' };
    if (opts.searchTerm) query['SearchTerm'] = opts.searchTerm;
    const rows = opts.searchTerm ? list(rec(await this.get('Items', { ...query, Limit: String(opts.limit ?? 50) }))['Items']).map(rec) : await this.paged('Items', query);
    return rows.flatMap((r) => {
      const id = str(r['Id']);
      const path = str(r['Path']);
      return id && path ? [{ id, path }] : [];
    });
  }

  /**
   * Opens the server's audio stream for one item (see `mediaBrowserAudioStream` for the
   * request). Resolves with the response whatever its status, so a proxy can forward 206/416 and
   * friends; throws MediaServerError on a network failure or when no headers arrive in time.
   * `signal` aborts the request and its body (the listener went away).
   */
  async audioStream(itemId: string, spec: MediaBrowserAudioStreamSpec, opts: { method?: 'GET' | 'HEAD'; range?: string | undefined; signal?: AbortSignal } = {}): Promise<Response> {
    const { path, query } = mediaBrowserAudioStream(itemId, spec);
    const url = new URL(joinUrl(this.base, path));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs ?? 30_000);
    const headers: Record<string, string> = { 'User-Agent': 'Arclight', Accept: '*/*', ...this.headers() };
    if (opts.range) headers['Range'] = opts.range;
    try {
      return await this.fetchImpl(url.toString(), { method: opts.method ?? 'GET', headers, signal: controller.signal });
    } catch (err) {
      const label = `${url.origin}${url.pathname}`;
      if (controller.signal.aborted && !opts.signal?.aborted) throw new MediaServerError(this.kind, 'timeout', `Request to ${label} timed out`, { cause: err });
      throw new MediaServerError(this.kind, 'network', `Could not reach ${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- collections (BoxSets; the same endpoints on Jellyfin and Emby) ----------------------

  private async send(method: 'POST' | 'DELETE', path: string, query: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    return requestJson(this.fetchImpl, this.kind, joinUrl(this.base, path), {
      method,
      headers: this.headers(),
      query,
      ...(body !== undefined ? { body } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
  }

  /** Every collection (BoxSet) on the server. */
  async collections(): Promise<MediaBrowserCollection[]> {
    const rows = await this.paged('Items', { Recursive: 'true', IncludeItemTypes: 'BoxSet', Fields: 'Overview' });
    return rows.flatMap((r) => {
      const id = str(r['Id']);
      return id ? [{ id, name: str(r['Name']) ?? id, overview: str(r['Overview']) }] : [];
    });
  }

  /** Ids of the items in a collection; null when the collection does not exist (any more). */
  async collectionItemIds(collectionId: string): Promise<string[] | null> {
    const found = await this.itemsByIds([collectionId]);
    if (!found.some((i) => i.type === 'BoxSet')) return null;
    const rows = await this.paged('Items', { ParentId: collectionId, Fields: 'ProviderIds' });
    return rows.flatMap((r) => (str(r['Id']) ? [str(r['Id'])!] : []));
  }

  /** Creates a collection holding `itemIds` (may be empty); returns its id. */
  async createCollection(name: string, itemIds: readonly string[] = []): Promise<string> {
    const first = itemIds.slice(0, COLLECTION_BATCH);
    const body = rec(await this.send('POST', 'Collections', { Name: name, ...(first.length ? { Ids: first.join(',') } : {}) }));
    const id = str(body['Id']);
    if (!id) throw new MediaServerError(this.kind, 'remoteError', 'creating the collection returned no id');
    if (itemIds.length > first.length) await this.addToCollection(id, itemIds.slice(first.length));
    return id;
  }

  async addToCollection(collectionId: string, itemIds: readonly string[]): Promise<void> {
    for (let i = 0; i < itemIds.length; i += COLLECTION_BATCH) {
      await this.send('POST', `Collections/${encodeURIComponent(collectionId)}/Items`, { Ids: itemIds.slice(i, i + COLLECTION_BATCH).join(',') });
    }
  }

  async removeFromCollection(collectionId: string, itemIds: readonly string[]): Promise<void> {
    for (let i = 0; i < itemIds.length; i += COLLECTION_BATCH) {
      await this.send('DELETE', `Collections/${encodeURIComponent(collectionId)}/Items`, { Ids: itemIds.slice(i, i + COLLECTION_BATCH).join(',') });
    }
  }

  /** Deletes a collection (the BoxSet only; its items stay). Gone already counts as done. */
  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await this.send('DELETE', `Items/${encodeURIComponent(collectionId)}`);
    } catch (err) {
      if (err instanceof MediaServerError && err.code === 'notFound') return;
      throw err;
    }
  }

  /**
   * Sets a collection's overview (the text its page shows). The update endpoint takes the whole
   * item, so the item is read first and sent back with the new overview, locked so a metadata
   * refresh keeps it.
   */
  async setCollectionOverview(collectionId: string, overview: string): Promise<void> {
    const body = rec(await this.get('Items', { Ids: collectionId, Fields: UPDATE_FIELDS }));
    const item = list(body['Items']).map(rec)[0];
    if (!item) throw new MediaServerError(this.kind, 'notFound', `collection ${collectionId} not found`);
    const locked = list(item['LockedFields']).flatMap((f) => (typeof f === 'string' ? [f] : []));
    await this.send('POST', `Items/${encodeURIComponent(collectionId)}`, {}, {
      ...item,
      Overview: overview,
      LockedFields: [...new Set([...locked, 'Overview'])],
      // Fields the update endpoint iterates over; absent ones would be read as null.
      Genres: list(item['Genres']),
      Tags: list(item['Tags']),
      Studios: list(item['Studios']),
      People: list(item['People']),
      ProviderIds: rec(item['ProviderIds']),
      Taglines: list(item['Taglines']),
    });
  }

  // ---- item tags (Arclight's tag sync; the same fields on Jellyfin and Emby) ----------------

  /** Tags of items by id, read in batches of 50 (unknown ids are left out). */
  async itemTags(ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += COLLECTION_BATCH) {
      const body = rec(await this.get('Items', { Ids: ids.slice(i, i + COLLECTION_BATCH).join(','), Fields: 'Tags', EnableImages: 'false', EnableUserData: 'false' }));
      for (const r of list(body['Items']).map(rec)) {
        const id = str(r['Id']);
        if (id) out.set(id, stringsOf(r['Tags']));
      }
    }
    return out;
  }

  /**
   * Adds and removes tags on one item, leaving every other tag as it is. Read-modify-write like
   * `setCollectionOverview`: the item is read, `Tags = (current - remove) + add` is computed
   * case-insensitively (a tag already there keeps its casing, nothing is duplicated) and the
   * whole item is sent back. With `lock`, `Tags` joins LockedFields so a metadata refresh keeps
   * them; without it LockedFields is sent back unchanged. Returns the tags now on the item.
   */
  async setItemTags(itemId: string, add: readonly string[], remove: readonly string[], opts: { lock?: boolean } = {}): Promise<string[]> {
    const body = rec(await this.get('Items', { Ids: itemId, Fields: UPDATE_FIELDS }));
    const item = list(body['Items']).map(rec)[0];
    if (!item) throw new MediaServerError(this.kind, 'notFound', `item ${itemId} not found`);
    const tags = mergeTags(stringsOf(item['Tags']), add, remove);
    const locked = stringsOf(item['LockedFields']);
    await this.send('POST', `Items/${encodeURIComponent(itemId)}`, {}, {
      ...item,
      Tags: tags,
      LockedFields: opts.lock ? [...new Set([...locked, 'Tags'])] : locked,
      // Fields the update endpoint iterates over; absent ones would be read as null.
      Genres: list(item['Genres']),
      Studios: list(item['Studios']),
      People: list(item['People']),
      ProviderIds: rec(item['ProviderIds']),
      Taglines: list(item['Taglines']),
    });
    return tags;
  }

  async refreshLibrary(options: RefreshOptions = {}): Promise<void> {
    if (options.path) {
      await this.post('Library/Media/Updated', { Updates: [{ Path: options.path, UpdateType: options.updateType ?? 'Modified' }] });
    } else {
      await this.post('Library/Refresh');
    }
  }
}

function stringsOf(value: unknown): string[] {
  return list(value).flatMap((v) => (typeof v === 'string' ? [v] : []));
}

function isPresent(ep: Record<string, unknown>): boolean {
  return ep['LocationType'] !== 'Virtual' && ep['IsMissing'] !== true;
}

function toWatchItem(r: Record<string, unknown>): MediaBrowserWatchItem | null {
  const type = str(r['Type']);
  const id = str(r['Id']);
  if ((type !== 'Movie' && type !== 'Episode') || !id) return null;
  const data = rec(r['UserData']);
  const duration = ticksToMs(r['RunTimeTicks']);
  return {
    id,
    type,
    name: str(r['Name']) ?? id,
    ids: mediaBrowserProviderIds(r['ProviderIds']),
    seriesId: type === 'Episode' ? str(r['SeriesId']) : null,
    seasonId: type === 'Episode' ? str(r['SeasonId']) : null,
    seasonNumber: type === 'Episode' ? num(r['ParentIndexNumber']) : null,
    episodeNumber: type === 'Episode' ? num(r['IndexNumber']) : null,
    durationMs: duration > 0 ? duration : null,
    played: data['Played'] === true,
    playCount: num(data['PlayCount']) ?? 0,
    lastPlayedAt: isoDate(data['LastPlayedDate']),
    positionMs: ticksToMs(data['PlaybackPositionTicks']),
    favorite: data['IsFavorite'] === true,
  };
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
