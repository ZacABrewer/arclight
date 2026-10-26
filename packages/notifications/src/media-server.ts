/**
 * Media-server clients for the requests side: user sign-in and listing (Jellyfin/Emby
 * `AuthenticateByName`, plex.tv PIN flow), favourites as a watchlist, and library lookups by
 * TMDB/TVDB id with per-season episode counts for availability.
 *
 * Jellyfin and Emby share the MediaBrowser REST API; Plex has a server API (library) and the
 * plex.tv account API (PINs, accounts, shared servers). Every call goes through `httpRequest`
 * so failures surface as `NotificationError` with a code (`unauthorized`, `network`, ...).
 */

import { httpRequest, joinUrl, readJson, type FetchLike } from './http.js';
import { NotificationError, type MediaType } from './types.js';

export type MediaBrowserKind = 'jellyfin' | 'emby';

export interface ProviderIds {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

export interface MediaServerAccount {
  /** Jellyfin/Emby user id, or the plex.tv account id. */
  id: string;
  username: string;
  email?: string;
  isAdmin: boolean;
  isDisabled: boolean;
  /** Avatar URL when the server exposes a public one (plex.tv thumbnails). */
  thumb?: string;
}

export interface MediaServerAuthResult {
  account: MediaServerAccount;
  accessToken: string;
}

/** A movie or series on a media server (favourites, library matches). */
export interface MediaServerItem {
  id: string;
  mediaType: MediaType;
  title: string;
  year: number | null;
  ids: ProviderIds;
}

/** Episodes present per season (missing/virtual placeholders excluded). */
export interface SeasonPresence {
  seasonNumber: number;
  episodes: number;
}

export interface LibraryMatch {
  item: MediaServerItem;
  /** Series only. */
  seasons: SeasonPresence[];
}

export interface ServerInfo {
  name: string;
  version?: string;
  /** Plex machineIdentifier / Jellyfin server id. */
  id?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Reads `Tmdb`/`Tvdb`/`Imdb` provider ids regardless of key case. */
export function providerIdsOf(raw: unknown): ProviderIds {
  const out: ProviderIds = { tmdbId: null, tvdbId: null, imdbId: null };
  for (const [key, value] of Object.entries(rec(raw))) {
    const k = key.toLowerCase();
    if (k === 'tmdb' || k === 'themoviedb') out.tmdbId = num(value);
    else if (k === 'tvdb') out.tvdbId = num(value);
    else if (k === 'imdb' && typeof value === 'string' && /^tt\d+$/.test(value)) out.imdbId = value;
  }
  return out;
}

/** True when an item's ids match the TMDB (or, for series, TVDB) id asked for. */
export function idsMatch(ids: ProviderIds, tmdbId: number, tvdbId?: number | null): boolean {
  if (ids.tmdbId !== null && ids.tmdbId === tmdbId) return true;
  return Boolean(tvdbId && ids.tvdbId !== null && ids.tvdbId === tvdbId);
}

// ---------------------------------------------------------------------------------------
// Jellyfin / Emby
// ---------------------------------------------------------------------------------------

export interface MediaBrowserClientOptions {
  kind: MediaBrowserKind;
  /** Server base URL including any URL base, e.g. http://jf.lan:8096/jellyfin. */
  url: string;
  /** Server API key (admin calls: users, library). Optional for sign-in only. */
  apiKey?: string;
  fetch?: FetchLike;
  /** Shown to the server as the client device name. */
  device?: string;
}

const PAGE = 200;

export class MediaBrowserClient {
  readonly kind: MediaBrowserKind;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly device: string;

  constructor(opts: MediaBrowserClientOptions) {
    this.kind = opts.kind;
    this.url = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.device = opts.device ?? 'Arclight';
  }

  private authorization(deviceId: string, token?: string): string {
    const parts = [`Client="Arclight"`, `Device="${this.device}"`, `DeviceId="${deviceId}"`, `Version="1.0.0"`];
    if (token) parts.push(`Token="${token}"`);
    return `MediaBrowser ${parts.join(', ')}`;
  }

  private headers(token: string | undefined, deviceId = 'arclight'): Record<string, string> {
    const auth = this.authorization(deviceId, token);
    // Jellyfin reads Authorization, Emby reads X-Emby-Authorization; both accept X-Emby-Token.
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: auth, 'X-Emby-Authorization': auth };
    if (token) headers['X-Emby-Token'] = token;
    return headers;
  }

  private async getJson(path: string, query: Record<string, string> = {}, token = this.apiKey): Promise<unknown> {
    if (!token) throw new NotificationError(this.kind, 'invalidSettings', `${this.kind} API key is not configured`);
    const url = new URL(joinUrl(this.url, path));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await httpRequest(this.fetchImpl, this.kind, url.toString(), { headers: this.headers(token) });
    return readJson<unknown>(res, this.kind);
  }

  async info(): Promise<ServerInfo> {
    const body = rec(await this.getJson('System/Info'));
    return {
      name: str(body['ServerName']) ?? (this.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'),
      ...(str(body['Version']) ? { version: str(body['Version'])! } : {}),
      ...(str(body['Id']) ? { id: str(body['Id'])! } : {}),
    };
  }

  /** Signs a user in with their own credentials (no API key needed). */
  async authenticateByName(username: string, password: string, deviceId: string): Promise<MediaServerAuthResult> {
    const res = await httpRequest(this.fetchImpl, this.kind, joinUrl(this.url, 'Users/AuthenticateByName'), {
      method: 'POST',
      headers: { ...this.headers(undefined, deviceId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
      label: `${this.kind} sign-in`,
    });
    const body = rec(await readJson<unknown>(res, this.kind));
    const user = rec(body['User']);
    const token = str(body['AccessToken']);
    const id = str(user['Id']);
    if (!token || !id) throw new NotificationError(this.kind, 'remoteError', `${this.kind} sign-in returned no user or token`);
    return { account: accountOf(user), accessToken: token };
  }

  async users(): Promise<MediaServerAccount[]> {
    return list(await this.getJson('Users')).map(accountOf).filter((a) => a.id !== '');
  }

  /** The user's favourite movies and series (their watchlist). */
  async favorites(userId: string, token?: string): Promise<MediaServerItem[]> {
    const out: MediaServerItem[] = [];
    for (let start = 0; start < 10_000; start += PAGE) {
      const body = rec(
        await this.getJson(
          `Users/${encodeURIComponent(userId)}/Items`,
          {
            Filters: 'IsFavorite',
            Recursive: 'true',
            IncludeItemTypes: 'Movie,Series',
            Fields: 'ProviderIds,ProductionYear',
            StartIndex: String(start),
            Limit: String(PAGE),
          },
          token ?? this.apiKey,
        ),
      );
      const items = list(body['Items']);
      for (const raw of items) {
        const item = itemOf(raw);
        if (item) out.push(item);
      }
      const total = num(body['TotalRecordCount']) ?? items.length;
      if (items.length < PAGE || start + PAGE >= total) break;
    }
    return out;
  }

  /** Finds a movie/series by provider id; series also get per-season episode counts. */
  async findByIds(mediaType: MediaType, tmdbId: number, tvdbId?: number | null): Promise<LibraryMatch | null> {
    const ids = [`Tmdb.${tmdbId}`];
    if (tvdbId) ids.push(`Tvdb.${tvdbId}`);
    const body = rec(
      await this.getJson('Items', {
        Recursive: 'true',
        IncludeItemTypes: mediaType === 'movie' ? 'Movie' : 'Series',
        AnyProviderIdEquals: ids.join(','),
        Fields: 'ProviderIds,ProductionYear',
        Limit: '20',
      }),
    );
    // Verify the ids ourselves: servers that ignore the filter return unrelated items.
    const item = list(body['Items'])
      .map(itemOf)
      .find((i): i is MediaServerItem => i !== null && i.mediaType === mediaType && idsMatch(i.ids, tmdbId, tvdbId));
    if (!item) return null;
    return { item, seasons: mediaType === 'series' ? await this.seasonPresence(item.id) : [] };
  }

  /** Episodes on disk per season. Multi-episode files count every episode they span. */
  async seasonPresence(seriesId: string): Promise<SeasonPresence[]> {
    const counts = new Map<number, number>();
    for (let start = 0; start < 50_000; start += PAGE * 5) {
      const body = rec(
        await this.getJson('Items', {
          ParentId: seriesId,
          Recursive: 'true',
          IncludeItemTypes: 'Episode',
          Fields: 'Path',
          StartIndex: String(start),
          Limit: String(PAGE * 5),
        }),
      );
      const items = list(body['Items']);
      for (const raw of items) {
        const ep = rec(raw);
        if (ep['LocationType'] === 'Virtual' || ep['IsMissing'] === true) continue;
        const season = num(ep['ParentIndexNumber']);
        const first = num(ep['IndexNumber']);
        if (season === null || first === null) continue;
        const last = num(ep['IndexNumberEnd']) ?? first;
        counts.set(season, (counts.get(season) ?? 0) + Math.max(1, last - first + 1));
      }
      const total = num(body['TotalRecordCount']) ?? items.length;
      if (items.length < PAGE * 5 || start + PAGE * 5 >= total) break;
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([seasonNumber, episodes]) => ({ seasonNumber, episodes }));
  }
}

function accountOf(raw: unknown): MediaServerAccount {
  const user = rec(raw);
  const policy = rec(user['Policy']);
  return {
    id: str(user['Id']) ?? '',
    username: str(user['Name']) ?? '',
    isAdmin: policy['IsAdministrator'] === true,
    isDisabled: policy['IsDisabled'] === true,
  };
}

function itemOf(raw: unknown): MediaServerItem | null {
  const r = rec(raw);
  const type = r['Type'];
  const mediaType: MediaType | null = type === 'Movie' ? 'movie' : type === 'Series' ? 'series' : null;
  const id = str(r['Id']);
  const title = str(r['Name']);
  if (!mediaType || !id || !title) return null;
  return { id, mediaType, title, year: num(r['ProductionYear']), ids: providerIdsOf(r['ProviderIds']) };
}

// ---------------------------------------------------------------------------------------
// Plex
// ---------------------------------------------------------------------------------------

export const PLEX_TV_URL = 'https://plex.tv';
export const PLEX_CLIENT_ID = 'arclight';

function plexHeaders(token: string | undefined, clientId: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Product': 'Arclight',
    'X-Plex-Device-Name': 'Arclight',
  };
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

/** Ids from a Plex item: the new agent's `Guid` list, or a legacy agent `guid` string. */
export function plexGuidIds(item: Record<string, unknown>): ProviderIds {
  const out: ProviderIds = { tmdbId: null, tvdbId: null, imdbId: null };
  for (const g of list(item['Guid'])) {
    const id = str(rec(g)['id']);
    if (id) applyGuid(out, id);
  }
  const legacy = str(item['guid']);
  if (legacy) applyGuid(out, legacy);
  return out;
}

function applyGuid(out: ProviderIds, guid: string): void {
  const match = /^(?:com\.plexapp\.agents\.)?([a-z]+):\/\/([^/?]+)/.exec(guid);
  if (!match) return;
  const [, scheme, value = ''] = match;
  if ((scheme === 'tmdb' || scheme === 'themoviedb') && /^\d+$/.test(value)) out.tmdbId ??= Number(value);
  else if ((scheme === 'tvdb' || scheme === 'thetvdb') && /^\d+$/.test(value)) out.tvdbId ??= Number(value);
  else if (scheme === 'imdb' && /^tt\d+$/.test(value)) out.imdbId ??= value;
}

export interface PlexServerClientOptions {
  url: string;
  token: string;
  fetch?: FetchLike;
  clientId?: string;
}

/** A Plex Media Server, called with the owner's token. */
export class PlexServerClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly clientId: string;

  constructor(opts: PlexServerClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clientId = opts.clientId ?? PLEX_CLIENT_ID;
  }

  private async container(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = new URL(joinUrl(this.url, path));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await httpRequest(this.fetchImpl, 'plex', url.toString(), { headers: plexHeaders(this.token, this.clientId) });
    return rec(rec(await readJson<unknown>(res, 'plex'))['MediaContainer']);
  }

  async info(): Promise<ServerInfo> {
    const mc = await this.container('identity');
    return {
      name: str(mc['friendlyName']) ?? 'Plex',
      ...(str(mc['version']) ? { version: str(mc['version'])! } : {}),
      ...(str(mc['machineIdentifier']) ? { id: str(mc['machineIdentifier'])! } : {}),
    };
  }

  /** Every movie/show of the movie and show libraries (one paged request per library). */
  async libraryItems(): Promise<Array<MediaServerItem & { ratingKey: string }>> {
    const sections = list((await this.container('library/sections'))['Directory'])
      .map(rec)
      .filter((d) => d['type'] === 'movie' || d['type'] === 'show');
    const out: Array<MediaServerItem & { ratingKey: string }> = [];
    for (const section of sections) {
      const key = String(section['key'] ?? '');
      if (!key) continue;
      const mediaType: MediaType = section['type'] === 'movie' ? 'movie' : 'series';
      for (let start = 0; start < 200_000; start += 500) {
        const mc = await this.container(`library/sections/${encodeURIComponent(key)}/all`, {
          includeGuids: '1',
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': '500',
        });
        const rows = list(mc['Metadata']).map(rec);
        for (const r of rows) {
          const ratingKey = str(r['ratingKey']) ?? (typeof r['ratingKey'] === 'number' ? String(r['ratingKey']) : undefined);
          const title = str(r['title']);
          if (!ratingKey || !title) continue;
          out.push({ id: ratingKey, ratingKey, mediaType, title, year: num(r['year']), ids: plexGuidIds(r) });
        }
        const total = num(mc['totalSize']) ?? rows.length;
        if (rows.length < 500 || start + 500 >= total) break;
      }
    }
    return out;
  }

  /** Seasons of a show with the number of episodes present (`leafCount`). */
  async seasonPresence(ratingKey: string): Promise<SeasonPresence[]> {
    const mc = await this.container(`library/metadata/${encodeURIComponent(ratingKey)}/children`);
    return list(mc['Metadata'])
      .map(rec)
      .flatMap((s) => {
        const seasonNumber = num(s['index']);
        const episodes = num(s['leafCount']);
        return seasonNumber === null || episodes === null ? [] : [{ seasonNumber, episodes }];
      })
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
  }
}

export interface PlexPinResult {
  id: number;
  code: string;
  authUrl: string;
}

/** plex.tv account API: PIN sign-in, the account behind a token, shared servers and friends. */
export class PlexTvClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly clientId: string;

  constructor(opts: { fetch?: FetchLike; clientId?: string; baseUrl?: string } = {}) {
    this.base = (opts.baseUrl ?? PLEX_TV_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clientId = opts.clientId ?? PLEX_CLIENT_ID;
  }

  private async json(path: string, token?: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
    const res = await httpRequest(this.fetchImpl, 'plex', joinUrl(this.base, path), {
      method,
      headers: plexHeaders(token, this.clientId),
      label: 'plex.tv',
    });
    return readJson<unknown>(res, 'plex');
  }

  async createPin(): Promise<PlexPinResult> {
    const body = rec(await this.json('api/v2/pins?strong=true', undefined, 'POST'));
    const id = num(body['id']);
    const code = str(body['code']);
    if (id === null || !code) throw new NotificationError('plex', 'remoteError', 'plex.tv returned no PIN');
    const params = new URLSearchParams({ clientID: this.clientId, code, 'context[device][product]': 'Arclight' });
    return { id, code, authUrl: `https://app.plex.tv/auth#?${params.toString()}` };
  }

  /** The auth token once the user approved the PIN, null while pending. */
  async checkPin(id: number): Promise<string | null> {
    const body = rec(await this.json(`api/v2/pins/${id}`));
    return str(body['authToken']) ?? null;
  }

  async account(token: string): Promise<MediaServerAccount> {
    const body = rec(await this.json('api/v2/user', token));
    const id = num(body['id']);
    if (id === null) throw new NotificationError('plex', 'remoteError', 'plex.tv returned no account id');
    return {
      id: String(id),
      username: str(body['username']) ?? str(body['title']) ?? `plex-${id}`,
      ...(str(body['email']) ? { email: str(body['email'])! } : {}),
      ...(str(body['thumb']) ? { thumb: str(body['thumb'])! } : {}),
      isAdmin: false,
      isDisabled: false,
    };
  }

  /** Machine identifiers of the servers this token can reach. */
  async serverIds(token: string): Promise<string[]> {
    return list(await this.json('api/v2/resources?includeHttps=1', token))
      .map(rec)
      .filter((r) => String(r['provides'] ?? '').split(',').includes('server'))
      .flatMap((r) => (str(r['clientIdentifier']) ? [str(r['clientIdentifier'])!] : []));
  }

  /** Accounts the owner shares with (plex.tv friends). */
  async friends(ownerToken: string): Promise<MediaServerAccount[]> {
    return list(await this.json('api/v2/friends', ownerToken)).flatMap((raw) => {
      const f = rec(raw);
      const id = num(f['id']);
      if (id === null) return [];
      return [
        {
          id: String(id),
          username: str(f['username']) ?? str(f['title']) ?? `plex-${id}`,
          ...(str(f['email']) ? { email: str(f['email'])! } : {}),
          ...(str(f['thumb']) ? { thumb: str(f['thumb'])! } : {}),
          isAdmin: false,
          isDisabled: false,
        },
      ];
    });
  }
}
