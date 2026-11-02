/**
 * Plex Media Server read client, called with the owner's X-Plex-Token.
 *
 * Plex cannot filter by external id, so items are found through an index of the movie/show
 * sections (`includeGuids=1`), built once per client instance. Play state differs by user:
 * the owner's state is on the items themselves (viewCount, lastViewedAt, viewOffset,
 * viewedLeafCount); every other account's state comes from the server's watch history
 * (`status/sessions/history/all?accountID=`), where a show counts as played once every
 * episode present (leafCount) appears in that account's history.
 *
 * The watch-history sync uses `accounts()` (the server's accounts merged with plex.tv friends
 * and Plex Home users, keyed by plex.tv account id so they match Plex sign-in links) and
 * `watchItems()` (per-movie and per-episode state); live playback comes from `sessions()` and
 * from Plex webhooks (`parsePlexWebhook`).
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
  WatchItem,
} from './types.js';
import { MediaServerError } from './types.js';

/** The server-local account id of the owner. */
export const PLEX_OWNER_ACCOUNT_ID = '1';

/** plex.tv, for the owner's account id, friends and Plex Home users. */
export const PLEX_TV_URL = 'https://plex.tv';

export interface PlexServerOptions {
  url: string;
  token: string;
  /** plex.tv base URL (tests point it elsewhere). */
  plexTvUrl?: string;
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

/**
 * A Plex account as the watch-history sync keeps it. `id` is the plex.tv account id (what a
 * Plex sign-in link stores); `localId` is the id the server uses in its history, sessions and
 * webhooks. Plex uses the plex.tv id locally for every account but the owner, who is always 1.
 */
export interface PlexAccount extends MediaServerUser {
  localId: string;
  /** owner; managed (restricted Plex Home user); shared (a friend or Home member with their own account); local (only the server knows it). */
  kind: 'owner' | 'managed' | 'shared' | 'local';
}

export interface PlexAccountList {
  accounts: PlexAccount[];
  /** False when plex.tv could not be asked; callers must not treat missing accounts as removed. */
  complete: boolean;
}

/** Item fields shared by live sessions and webhooks. */
export interface PlexLiveItem {
  ratingKey: string;
  /** Plex type: movie, episode, track, ... */
  type: string;
  title: string;
  grandparentTitle: string | null;
  /** Episodes: the show's and the season's rating keys. */
  grandparentRatingKey: string | null;
  parentRatingKey: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  ids: ProviderIds;
  positionMs: number | null;
  durationMs: number | null;
  viewCount: number | null;
}

/** One entry of `/status/sessions`. */
export interface PlexSession {
  /** Session key (stable while the playback lasts). */
  sessionKey: string;
  item: PlexLiveItem;
  /** Server-local account id (1 = owner). */
  accountId: string | null;
  accountName: string | null;
  /** The player's machine identifier (the webhook's Player.uuid). */
  playerId: string | null;
  client: string | null;
  device: string | null;
  state: 'playing' | 'paused' | 'buffering' | 'other';
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
}

/** A Plex webhook (multipart field `payload`), reduced to what the watch history needs. */
export interface PlexWebhookEvent {
  /** media.play, media.pause, media.resume, media.stop, media.scrobble, library.new, ... */
  event: string;
  /** Server-local account id (1 = owner). */
  accountId: string | null;
  accountName: string | null;
  /** The server's machineIdentifier. */
  serverUuid: string | null;
  playerId: string | null;
  device: string | null;
  client: string | null;
  item: PlexLiveItem | null;
}

function liveItem(m: Record<string, unknown>): PlexLiveItem | null {
  const ratingKey = str(m['ratingKey']) ?? keyId(m['key']);
  if (!ratingKey) return null;
  return {
    ratingKey,
    type: str(m['type']) ?? 'other',
    title: str(m['title']) ?? ratingKey,
    grandparentTitle: str(m['grandparentTitle']),
    grandparentRatingKey: str(m['grandparentRatingKey']) ?? keyId(m['grandparentKey']),
    parentRatingKey: str(m['parentRatingKey']) ?? keyId(m['parentKey']),
    seasonNumber: num(m['parentIndex']),
    episodeNumber: num(m['index']),
    ids: plexProviderIds(m),
    positionMs: num(m['viewOffset']),
    durationMs: num(m['duration']),
    viewCount: num(m['viewCount']),
  };
}

/** Parses a webhook's `payload` JSON (string or object); null when it is not a Plex event. */
export function parsePlexWebhook(payload: unknown): PlexWebhookEvent | null {
  let body: unknown = payload;
  if (typeof payload === 'string') {
    try {
      body = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  const p = rec(body);
  const event = str(p['event']);
  if (!event) return null;
  const account = rec(p['Account']);
  const player = rec(p['Player']);
  const metadata = rec(p['Metadata']);
  return {
    event,
    accountId: str(account['id']),
    accountName: str(account['title']),
    serverUuid: str(rec(p['Server'])['uuid']),
    playerId: str(player['uuid']),
    device: str(player['title']),
    client: str(player['product']) ?? str(player['title']),
    item: Object.keys(metadata).length > 0 ? liveItem(metadata) : null,
  };
}

function baseItem(raw: Record<string, unknown>, id: string, kind: 'movie' | 'episode'): WatchItem {
  const episode = kind === 'episode';
  return {
    id,
    type: episode ? 'Episode' : 'Movie',
    name: str(raw['title']) ?? id,
    ids: plexProviderIds(raw),
    seriesId: episode ? (str(raw['grandparentRatingKey']) ?? keyId(raw['grandparentKey'])) : null,
    seasonId: episode ? (str(raw['parentRatingKey']) ?? keyId(raw['parentKey'])) : null,
    seasonNumber: episode ? num(raw['parentIndex']) : null,
    episodeNumber: episode ? num(raw['index']) : null,
    durationMs: num(raw['duration']),
    played: false,
    playCount: 0,
    lastPlayedAt: null,
    positionMs: 0,
    favorite: false,
  };
}

/** State on the item itself. Played = viewCount above 0 (Plex marks watched at 90% or on "mark as played"). */
function stateItem(raw: Record<string, unknown>, kind: 'movie' | 'episode'): WatchItem | null {
  const id = str(raw['ratingKey']);
  if (!id) return null;
  const viewCount = num(raw['viewCount']) ?? 0;
  return {
    ...baseItem(raw, id, kind),
    played: viewCount > 0,
    playCount: viewCount,
    lastPlayedAt: isoFromSeconds(raw['lastViewedAt']),
    positionMs: num(raw['viewOffset']) ?? 0,
  };
}

function playMethodOf(m: Record<string, unknown>): PlexSession['playMethod'] {
  const transcode = rec(m['TranscodeSession']);
  if (Object.keys(transcode).length === 0) return 'DirectPlay';
  const video = str(transcode['videoDecision']);
  const audio = str(transcode['audioDecision']);
  return video === 'transcode' || (video === null && audio === 'transcode') ? 'Transcode' : 'DirectStream';
}

/**
 * Whether a plex.tv friend entry shares this server. Entries without server details count as
 * sharing (the server's own account list decides then).
 */
function sharesServer(friend: Record<string, unknown>, machineId: string | undefined): boolean {
  const shared = list(friend['sharedServers']).map(rec);
  if (!machineId || shared.length === 0) return true;
  const ids = shared.flatMap((s) => str(s['machineIdentifier']) ?? str(s['clientIdentifier']) ?? []);
  return ids.length === 0 || ids.includes(machineId);
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
  private readonly plexTvUrl: string;
  private sectionsCache: Promise<MediaServerLibrary[]> | null = null;
  private readonly index = new Map<MediaKind, Promise<IndexedRow[]>>();
  private readonly history = new Map<string, Promise<HistoryEntry[]>>();
  private readonly videoRows = new Map<'movie' | 'episode', Promise<Record<string, unknown>[]>>();

  constructor(opts: PlexServerOptions) {
    if (!opts.url.trim()) throw new MediaServerError('plex', 'invalidSettings', 'Plex URL is not configured');
    if (!opts.token.trim()) throw new MediaServerError('plex', 'invalidSettings', 'Plex token is not configured');
    this.base = normaliseBaseUrl(opts.url);
    this.token = opts.token.trim();
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs;
    this.pageSize = opts.pageSize ?? 500;
    this.clientIdentifier = opts.clientIdentifier ?? 'arclight';
    this.plexTvUrl = normaliseBaseUrl(opts.plexTvUrl ?? PLEX_TV_URL);
  }

  private headers(token = this.token): Record<string, string> {
    return {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': this.clientIdentifier,
      'X-Plex-Product': 'Arclight',
      'X-Plex-Device-Name': 'Arclight',
    };
  }

  private async container(path: string, query: Record<string, string> = {}, token?: string): Promise<Record<string, unknown>> {
    const body = await requestJson(this.fetchImpl, 'plex', joinUrl(this.base, path), {
      headers: this.headers(token),
      query,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return rec(rec(body)['MediaContainer']);
  }

  /** Every page of a listing; with `until`, stops at (and leaves out) the first row it accepts. */
  private async pagedMetadata(
    path: string,
    query: Record<string, string>,
    opts: { token?: string | undefined; until?: (row: Record<string, unknown>) => boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let start = 0; start < 1_000_000; start += this.pageSize) {
      const mc = await this.container(
        path,
        {
          ...query,
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': String(this.pageSize),
        },
        opts.token,
      );
      const rows = list(mc['Metadata']).map(rec);
      for (const row of rows) {
        if (opts.until?.(row)) return out;
        out.push(row);
      }
      const total = num(mc['totalSize']) ?? num(mc['size']) ?? rows.length;
      if (rows.length < this.pageSize || start + this.pageSize >= total) break;
    }
    return out;
  }

  private async plexTv(path: string, token = this.token, query: Record<string, string> = {}): Promise<unknown> {
    return requestJson(this.fetchImpl, 'plex', joinUrl(this.plexTvUrl, path), {
      headers: this.headers(token),
      query,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
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

  // ---- watch history ---------------------------------------------------------------------

  /**
   * Every account that can watch on this server: the server's own list (`/accounts`: the owner
   * and everyone who has played something), plex.tv friends the server is shared with, and
   * Plex Home users. The owner's id comes from plex.tv (`api/v2/user`); when plex.tv cannot be
   * reached, `ownerId` (the id stored last time) is used and the list is marked incomplete.
   */
  async accounts(opts: { ownerId?: string | null } = {}): Promise<PlexAccountList> {
    const mc = await this.container('accounts');
    const local = list(mc['Account']).flatMap((raw) => {
      const a = rec(raw);
      const id = str(a['id']);
      const name = str(a['name']);
      return id && id !== '0' && name ? [{ id, name }] : [];
    });
    const localOwnerName = local.find((a) => a.id === PLEX_OWNER_ACCOUNT_ID)?.name ?? 'owner';
    let complete = true;
    let owner: { id: string; name: string };
    try {
      const me = rec(await this.plexTv('api/v2/user'));
      const id = str(me['id']);
      if (!id) throw new MediaServerError('plex', 'remoteError', 'plex.tv returned no account id');
      owner = { id, name: str(me['username']) ?? str(me['title']) ?? localOwnerName };
    } catch (err) {
      if (!opts.ownerId) throw err;
      complete = false;
      owner = { id: opts.ownerId, name: localOwnerName };
    }
    const remote = new Map<string, { name: string; kind: PlexAccount['kind'] }>();
    if (complete) {
      try {
        const machineId = (await this.info()).id;
        for (const raw of list(await this.plexTv('api/v2/friends'))) {
          const f = rec(raw);
          const id = str(f['id']);
          const status = str(f['status']);
          if (!id || id === owner.id || (status !== null && status !== 'accepted')) continue;
          if (!sharesServer(f, machineId)) continue;
          remote.set(id, { name: str(f['title']) ?? str(f['username']) ?? `plex-${id}`, kind: f['restricted'] === true ? 'managed' : 'shared' });
        }
        const home = await this.plexTv('api/v2/home/users');
        const homeUsers = Array.isArray(home) ? home : list(rec(home)['users']);
        for (const raw of homeUsers) {
          const u = rec(raw);
          const id = str(u['id']);
          if (!id || id === owner.id || u['admin'] === true || remote.has(id)) continue;
          remote.set(id, { name: str(u['title']) ?? str(u['username']) ?? `plex-${id}`, kind: u['restricted'] === true ? 'managed' : 'shared' });
        }
      } catch {
        complete = false;
      }
    }
    const out = new Map<string, PlexAccount>();
    const add = (a: Pick<PlexAccount, 'id' | 'localId' | 'name' | 'kind'>) => {
      if (!out.has(a.id)) out.set(a.id, { ...a, isAdmin: a.kind === 'owner', isDisabled: false, lastActivityAt: null });
    };
    add({ id: owner.id, localId: PLEX_OWNER_ACCOUNT_ID, name: owner.name, kind: 'owner' });
    for (const a of local) {
      if (a.id !== PLEX_OWNER_ACCOUNT_ID) add({ id: a.id, localId: a.id, name: a.name, kind: remote.get(a.id)?.kind ?? 'local' });
    }
    for (const [id, r] of remote) add({ id, localId: id, name: r.name, kind: r.kind });
    return { accounts: [...out.values()], complete };
  }

  /**
   * The server token a user's own plex.tv token gives for this server (plex.tv resources), or
   * null when the account has no access. Reading with it shows that user's own resume points.
   */
  async serverTokenFor(userToken: string): Promise<string | null> {
    const machineId = (await this.info()).id;
    if (!machineId) return null;
    const resources = list(await this.plexTv('api/v2/resources', userToken, { includeHttps: '1' })).map(rec);
    const server = resources.find((r) => str(r['clientIdentifier']) === machineId);
    return server ? (str(server['accessToken']) ?? null) : null;
  }

  /** Movie (type 1) or episode (type 4) rows of every movie/show section. */
  private async videoListing(
    kind: 'movie' | 'episode',
    opts: { token?: string | undefined; sort?: string; until?: (row: Record<string, unknown>) => boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const want: MediaKind = kind === 'movie' ? 'movie' : 'series';
    const sections = (await this.libraries()).filter((s) => s.type === want);
    const out: Record<string, unknown>[] = [];
    for (const section of sections) {
      const query: Record<string, string> = { includeGuids: '1', type: kind === 'movie' ? '1' : '4', ...(opts.sort ? { sort: opts.sort } : {}) };
      out.push(...(await this.pagedMetadata(`library/sections/${encodeURIComponent(section.id)}/all`, query, { token: opts.token, ...(opts.until ? { until: opts.until } : {}) })));
    }
    return out;
  }

  /** The owner's full movie or episode listing, cached per client instance (history reads reuse it). */
  private allVideo(kind: 'movie' | 'episode'): Promise<Record<string, unknown>[]> {
    let cached = this.videoRows.get(kind);
    if (!cached) {
      cached = this.videoListing(kind);
      cached.catch(() => this.videoRows.delete(kind));
      this.videoRows.set(kind, cached);
    }
    return cached;
  }

  /**
   * One account's play state of every movie and episode (full read) or of those played since
   * `playedSince` (incremental). The owner's state, and anyone's when `token` (their own server
   * token) is given, is on the items: viewCount, lastViewedAt, viewOffset. Other accounts' state
   * comes from the server's watch history: played and play counts but no resume points (those
   * arrive live through webhooks and session polling).
   */
  async watchItems(account: { localId: string }, opts: { playedSince?: string | null; token?: string | null } = {}): Promise<WatchItem[]> {
    const since = opts.playedSince ?? null;
    const token = opts.token ?? undefined;
    if (account.localId === PLEX_OWNER_ACCOUNT_ID || token) {
      const out: WatchItem[] = [];
      for (const kind of ['movie', 'episode'] as const) {
        let rows: Record<string, unknown>[];
        if (since !== null) {
          rows = await this.videoListing(kind, {
            token,
            sort: 'lastViewedAt:desc',
            until: (r) => {
              const at = isoFromSeconds(r['lastViewedAt']);
              return at === null || at < since;
            },
          });
        } else {
          rows = token ? await this.videoListing(kind, { token }) : await this.allVideo(kind);
        }
        for (const raw of rows) {
          const item = stateItem(raw, kind);
          if (item) out.push(item);
        }
      }
      return out;
    }
    if (since === null) {
      const views = new Map<string, { count: number; last: string | null }>();
      for (const h of await this.accountHistory(account.localId)) {
        if (!h.ratingKey) continue;
        const v = views.get(h.ratingKey) ?? { count: 0, last: null };
        v.count++;
        v.last = laterOf(v.last, h.viewedAt);
        views.set(h.ratingKey, v);
      }
      const out: WatchItem[] = [];
      for (const kind of ['movie', 'episode'] as const) {
        for (const raw of await this.allVideo(kind)) {
          const id = str(raw['ratingKey']);
          if (!id) continue;
          const v = views.get(id);
          out.push({ ...baseItem(raw, id, kind), played: (v?.count ?? 0) > 0, playCount: v?.count ?? 0, lastPlayedAt: v?.last ?? null });
        }
      }
      return out;
    }
    // Incremental: what the history lists since `since`, then each of those items' full play count.
    const recent = await this.pagedMetadata(
      'status/sessions/history/all',
      { accountID: account.localId, sort: 'viewedAt:desc' },
      {
        until: (h) => {
          const at = isoFromSeconds(h['viewedAt']);
          return at === null || at < since;
        },
      },
    );
    const keys = [...new Set(recent.flatMap((h) => str(h['ratingKey']) ?? keyId(h['key']) ?? []))];
    const out: WatchItem[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const mc = await this.container(`library/metadata/${chunk.map(encodeURIComponent).join(',')}`, { includeGuids: '1' });
      for (const raw of list(mc['Metadata']).map(rec)) {
        const id = str(raw['ratingKey']);
        const type = str(raw['type']);
        if (!id || (type !== 'movie' && type !== 'episode')) continue;
        const views = (await this.pagedMetadata('status/sessions/history/all', { accountID: account.localId, metadataItemID: id })).filter(
          (h) => (str(h['ratingKey']) ?? keyId(h['key'])) === id,
        );
        const last = views.reduce<string | null>((acc, h) => laterOf(acc, isoFromSeconds(h['viewedAt'])), null);
        out.push({ ...baseItem(raw, id, type), played: views.length > 0, playCount: views.length, lastPlayedAt: last });
      }
    }
    return out;
  }

  /** Current playback sessions (`/status/sessions`). */
  async sessions(): Promise<PlexSession[]> {
    const mc = await this.container('status/sessions');
    return list(mc['Metadata']).flatMap((raw) => {
      const m = rec(raw);
      const item = liveItem(m);
      if (!item) return [];
      const user = rec(m['User']);
      const player = rec(m['Player']);
      const session = rec(m['Session']);
      const state = str(player['state']);
      return [
        {
          sessionKey: str(m['sessionKey']) ?? str(session['id']) ?? `${str(player['machineIdentifier']) ?? ''}:${item.ratingKey}`,
          item,
          accountId: str(user['id']),
          accountName: str(user['title']),
          playerId: str(player['machineIdentifier']),
          client: str(player['product']),
          device: str(player['title']),
          state: state === 'playing' || state === 'paused' || state === 'buffering' ? state : 'other',
          playMethod: playMethodOf(m),
        } satisfies PlexSession,
      ];
    });
  }

  /** Provider ids and title of one item (the show of an episode reported live), null when it is gone. */
  async itemIds(ratingKey: string): Promise<{ ids: ProviderIds; title: string | null } | null> {
    try {
      const mc = await this.container(`library/metadata/${encodeURIComponent(ratingKey)}`, { includeGuids: '1' });
      const raw = rec(list(mc['Metadata'])[0]);
      return Object.keys(raw).length === 0 ? null : { ids: plexProviderIds(raw), title: str(raw['title']) };
    } catch (err) {
      if (err instanceof MediaServerError && err.code === 'notFound') return null;
      throw err;
    }
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
