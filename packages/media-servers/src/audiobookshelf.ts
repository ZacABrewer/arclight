/**
 * Audiobookshelf read client (docs/design/music-audiobooks.md section 10). Audiobookshelf is a
 * library server for audiobooks and podcasts; Arclight uses it to rescan a library after an
 * audiobook import and (Wave 4) to answer "is this book on the server?" by ASIN or ISBN.
 *
 * Authentication is an API token sent as `Authorization: Bearer <token>`. Endpoints used:
 *   GET  /status                              server identity (no auth needed)
 *   GET  /api/libraries                       libraries with their folders (`fullPath`)
 *   POST /api/libraries/{id}/scan             rescan one library
 *   GET  /api/libraries/{id}/items            paged items (`limit`, `page`)
 *   GET  /api/users, /api/users/{id}          accounts and their listening progress
 *
 * Not a sign-in provider. Only `book` libraries map to a media kind (`audiobook`); podcast
 * libraries are `other`, and video/music kinds list nothing.
 */

import {
  emptyIds,
  idsMatchQuery,
  joinUrl,
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
import { pathIsInside } from './plex.js';
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

export interface AudiobookshelfServerOptions {
  url: string;
  /** API token (Settings > Users > the user's API token, or an API key). */
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Items per page for listings. Default 200. */
  pageSize?: number;
}

/** Library `mediaType` to media kind: `book` holds audiobooks, anything else (podcasts) is `other`. */
export function audiobookshelfLibraryKind(mediaType: unknown): MediaKind | 'other' {
  return str(mediaType)?.toLowerCase() === 'book' ? 'audiobook' : 'other';
}

/** ASIN and ISBN from an item's `media.metadata`. */
export function audiobookshelfProviderIds(metadata: unknown): ProviderIds {
  const m = rec(metadata);
  const ids = emptyIds();
  const asin = str(m['asin'])?.trim();
  if (asin && /^[0-9A-Z]{10}$/i.test(asin)) ids.asin = asin.toUpperCase();
  const isbn = str(m['isbn'])?.trim();
  if (isbn && /^[\d\s-]{9,17}[\dX]$/i.test(isbn)) ids.isbn = normaliseIsbn(isbn);
  return ids;
}

/** Milliseconds from Audiobookshelf seconds. */
const secondsToMs = (value: unknown): number | null => {
  const n = num(value);
  return n !== null && n >= 0 ? Math.round(n * 1000) : null;
};

/** ISO string from Audiobookshelf's millisecond timestamps. */
const isoFromMs = (value: unknown): string | null => {
  const n = num(value);
  return n !== null && n > 0 ? new Date(n).toISOString() : null;
};

export class AudiobookshelfServerClient implements MediaServerClient {
  readonly kind = 'audiobookshelf' as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  private readonly pageSize: number;
  private index: Promise<MediaServerItem[]> | null = null;

  constructor(opts: AudiobookshelfServerOptions) {
    if (!opts.url.trim()) throw new MediaServerError('audiobookshelf', 'invalidSettings', 'Audiobookshelf URL is not configured');
    if (!opts.token.trim()) throw new MediaServerError('audiobookshelf', 'invalidSettings', 'Audiobookshelf API token is not configured');
    this.base = normaliseBaseUrl(opts.url);
    this.token = opts.token.trim();
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs;
    this.pageSize = opts.pageSize ?? 200;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private opts(extra: { query?: Record<string, string>; method?: 'GET' | 'POST' } = {}) {
    return { headers: this.headers(), ...extra, ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}) };
  }

  private get(path: string, query?: Record<string, string>): Promise<unknown> {
    return requestJson(this.fetchImpl, 'audiobookshelf', joinUrl(this.base, path), this.opts(query ? { query } : {}));
  }

  async info(): Promise<ServerInfo> {
    const status = rec(await this.get('status'));
    const version = str(status['serverVersion']);
    return { name: 'Audiobookshelf', ...(version ? { version } : {}) };
  }

  async libraries(): Promise<MediaServerLibrary[]> {
    const body = await this.get('api/libraries');
    // Newer servers answer `{ libraries: [...] }`, some older ones a bare array.
    const rows = Array.isArray(body) ? body : list(rec(body)['libraries']);
    return rows.flatMap((raw): MediaServerLibrary[] => {
      const r = rec(raw);
      const id = str(r['id']);
      if (!id) return [];
      return [
        {
          id,
          name: str(r['name']) ?? id,
          type: audiobookshelfLibraryKind(r['mediaType']),
          locations: list(r['folders'])
            .map((f) => str(rec(f)['fullPath']))
            .filter((p): p is string => p !== null),
        },
      ];
    });
  }

  async users(): Promise<MediaServerUser[]> {
    const body = rec(await this.get('api/users'));
    return list(body['users']).flatMap((raw): MediaServerUser[] => {
      const r = rec(raw);
      const id = str(r['id']);
      if (!id) return [];
      const type = str(r['type'])?.toLowerCase();
      return [
        {
          id,
          name: str(r['username']) ?? id,
          isAdmin: type === 'root' || type === 'admin',
          isDisabled: r['isActive'] === false,
          lastActivityAt: isoFromMs(r['lastSeen']),
        },
      ];
    });
  }

  /** Every book in the server's book libraries. Video and music kinds list nothing. */
  listItems(mediaType: MediaKind): Promise<MediaServerItem[]> {
    if (mediaType !== 'audiobook') return Promise.resolve([]);
    this.index ??= this.loadIndex().catch((err: unknown) => {
      this.index = null;
      throw err;
    });
    return this.index;
  }

  private async loadIndex(): Promise<MediaServerItem[]> {
    const libraries = (await this.libraries()).filter((l) => l.type === 'audiobook');
    const out: MediaServerItem[] = [];
    for (const library of libraries) {
      for (let page = 0; ; page++) {
        const body = rec(
          await this.get(`api/libraries/${encodeURIComponent(library.id)}/items`, { limit: String(this.pageSize), page: String(page) }),
        );
        const results = list(body['results']);
        for (const raw of results) {
          const item = toItem(rec(raw), library.id);
          if (item) out.push(item);
        }
        const total = num(body['total']);
        const seen = (page + 1) * this.pageSize;
        if (results.length < this.pageSize || (total !== null && seen >= total)) break;
      }
    }
    return out;
  }

  /** Books whose ASIN or ISBN matches the query (compared client-side). */
  async findItems(query: FindItemsQuery): Promise<MediaServerItem[]> {
    if (query.mediaType !== 'audiobook' || !queryHasIds(query)) return [];
    const ids = {
      ...(query.asin ? { asin: query.asin } : {}),
      ...(query.isbn ? { isbn: query.isbn } : {}),
    };
    if (!ids.asin && !ids.isbn) return [];
    return (await this.listItems('audiobook')).filter((item) => idsMatchQuery(item.ids, ids));
  }

  private async progressOf(userId: string): Promise<Map<string, Record<string, unknown>>> {
    const user = rec(await this.get(`api/users/${encodeURIComponent(userId)}`));
    const out = new Map<string, Record<string, unknown>>();
    for (const raw of list(user['mediaProgress'])) {
      const p = rec(raw);
      const itemId = str(p['libraryItemId']);
      // Podcast episodes carry an episodeId; book progress does not.
      if (itemId && !str(p['episodeId'])) out.set(itemId, p);
    }
    return out;
  }

  async playState(item: Pick<MediaServerItem, 'id' | 'mediaType'>, userId: string): Promise<PlayState> {
    const progress = (await this.progressOf(userId)).get(item.id);
    return toPlayState(userId, progress);
  }

  async listPlayStates(userId: string, mediaType: MediaKind): Promise<ItemPlayState[]> {
    if (mediaType !== 'audiobook') return [];
    const [items, progress] = await Promise.all([this.listItems('audiobook'), this.progressOf(userId)]);
    return items.map((item) => ({ item, state: toPlayState(userId, progress.get(item.id)) }));
  }

  /**
   * Rescans the book libraries whose folders contain `options.path` (every book library
   * without a path). Audiobookshelf scans whole libraries; a path outside every library
   * refreshes nothing, since a full rescan of unrelated libraries is never what an import wants.
   */
  async refreshLibrary(options: RefreshOptions = {}): Promise<void> {
    if (options.mediaType && options.mediaType !== 'audiobook') return;
    const libraries = (await this.libraries()).filter((l) => l.type === 'audiobook');
    const path = options.path;
    const targets = path ? libraries.filter((l) => l.locations.some((loc) => pathIsInside(path, loc))) : libraries;
    for (const library of targets) {
      await request(this.fetchImpl, 'audiobookshelf', joinUrl(this.base, `api/libraries/${encodeURIComponent(library.id)}/scan`), this.opts({ method: 'POST' }));
    }
  }
}

function toItem(raw: Record<string, unknown>, libraryId: string): MediaServerItem | null {
  const id = str(raw['id']);
  if (!id) return null;
  const media = rec(raw['media']);
  const metadata = rec(media['metadata']);
  const year = num(metadata['publishedYear']);
  return {
    id,
    mediaType: 'audiobook',
    title: str(metadata['title']) ?? str(raw['relPath']) ?? id,
    year: year !== null ? Math.trunc(year) : null,
    ids: audiobookshelfProviderIds(metadata),
    path: str(raw['path']),
    libraryId: str(raw['libraryId']) ?? libraryId,
  };
}

function toPlayState(userId: string, p: Record<string, unknown> | undefined): PlayState {
  if (!p) return { userId, played: false, playCount: 0, lastPlayedAt: null, positionMs: 0, durationMs: null };
  const finished = p['isFinished'] === true;
  const position = secondsToMs(p['currentTime']) ?? 0;
  return {
    userId,
    played: finished,
    playCount: finished ? 1 : 0,
    lastPlayedAt: isoFromMs(p['finishedAt']) ?? isoFromMs(p['lastUpdate']),
    positionMs: finished ? 0 : position,
    durationMs: secondsToMs(p['duration']),
  };
}
