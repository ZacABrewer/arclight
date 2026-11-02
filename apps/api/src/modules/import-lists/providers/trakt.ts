import type { TraktDeviceResponse, TraktListSettings, TraktPopularSettings } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, getJson, imdbIdOf, int, request, str } from './http.js';
import { wants, type FetchedItem, type FetchLike, type Provider, type ProviderContext } from './types.js';

export const TRAKT_BASE = 'https://api.trakt.tv';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
/** Refresh a token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type TraktAuthSettings = Pick<TraktListSettings, 'clientId' | 'clientSecret' | 'accessToken' | 'refreshToken' | 'tokenExpiresAt'>;

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601. */
  tokenExpiresAt: string;
}

function headers(clientId: string, accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  };
  if (accessToken) h['Authorization'] = `Bearer ${accessToken}`;
  return h;
}

function tokensFrom(body: unknown, now: Date): TraktTokens {
  const r = asRecord(body);
  const accessToken = str(r?.['access_token']);
  const refreshToken = str(r?.['refresh_token']);
  if (!accessToken || !refreshToken) throw new ImportListFetchError('bad-response', 'Trakt token response is missing tokens');
  const expiresIn = int(r?.['expires_in']) ?? 7_776_000; // Trakt default: 90 days
  const createdAt = int(r?.['created_at']);
  const base = createdAt !== null ? createdAt * 1000 : now.getTime();
  return { accessToken, refreshToken, tokenExpiresAt: new Date(base + expiresIn * 1000).toISOString() };
}

/** Refresh the access token when it is about to expire; the new tokens are persisted. */
async function ensureFreshToken(s: TraktAuthSettings, ctx: ProviderContext): Promise<string | undefined> {
  if (!s.accessToken) return undefined;
  const expires = s.tokenExpiresAt ? Date.parse(s.tokenExpiresAt) : Number.NaN;
  if (Number.isNaN(expires) || expires - REFRESH_MARGIN_MS > ctx.now().getTime()) return s.accessToken;
  if (!s.refreshToken || !s.clientSecret) return s.accessToken;
  const body = await getJson(ctx, 'Trakt', `${TRAKT_BASE}/oauth/token`, {
    method: 'POST',
    headers: headers(s.clientId),
    body: JSON.stringify({
      refresh_token: s.refreshToken,
      client_id: s.clientId,
      client_secret: s.clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'refresh_token',
    }),
  });
  const tokens = tokensFrom(body, ctx.now());
  ctx.saveSettings({ ...tokens });
  ctx.log.info('refreshed Trakt access token');
  return tokens.accessToken;
}

/** A Trakt row: `{ movie: {...} }`, `{ show: {...} }`, `{ type, movie|show }`, or a bare movie/show. */
function fromTrakt(raw: unknown, bareKind?: 'series' | 'movie'): FetchedItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  let kind: 'series' | 'movie' | undefined;
  let media: Record<string, unknown> | null = null;
  if (asRecord(r['movie'])) {
    kind = 'movie';
    media = asRecord(r['movie']);
  } else if (asRecord(r['show'])) {
    kind = 'series';
    media = asRecord(r['show']);
  } else if (bareKind && asRecord(r['ids'])) {
    kind = bareKind;
    media = r;
  }
  if (!kind || !media) return null;
  const ids = asRecord(media['ids']);
  const title = str(media['title']);
  if (!title) return null;
  return {
    mediaType: kind,
    tmdbId: int(ids?.['tmdb']),
    imdbId: imdbIdOf(ids?.['imdb']),
    tvdbId: int(ids?.['tvdb']),
    title,
    year: int(media['year']),
  };
}

async function traktGet(ctx: ProviderContext, s: TraktAuthSettings, path: string, params: Record<string, string | number | undefined>) {
  const token = await ensureFreshToken(s, ctx);
  const url = new URL(`${TRAKT_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  return asArray(await getJson(ctx, 'Trakt', url.toString(), { headers: headers(s.clientId, token) }));
}

function kinds(mediaType: Parameters<typeof wants>[0]): Array<{ kind: 'series' | 'movie'; path: 'shows' | 'movies' }> {
  const out: Array<{ kind: 'series' | 'movie'; path: 'shows' | 'movies' }> = [];
  if (wants(mediaType, 'series')) out.push({ kind: 'series', path: 'shows' });
  if (wants(mediaType, 'movie')) out.push({ kind: 'movie', path: 'movies' });
  return out;
}

export const traktList: Provider<'trakt'> = async (s, mediaType, ctx) => {
  const types = kinds(mediaType).map((k) => (k.kind === 'series' ? 'show' : 'movie')).join(',');
  const rows = await traktGet(
    ctx,
    s,
    `/users/${encodeURIComponent(s.username)}/lists/${encodeURIComponent(s.listName)}/items/${types}`,
    { limit: s.limit },
  );
  return rows
    .map((r) => fromTrakt(r))
    .filter((i): i is FetchedItem => i !== null && wants(mediaType, i.mediaType))
    .slice(0, s.limit);
};

const POPULAR_PATHS: Record<TraktPopularSettings['listType'], string> = {
  trending: 'trending',
  popular: 'popular',
  anticipated: 'anticipated',
  watched: 'watched',
  boxOffice: 'boxoffice',
  played: 'played',
  collected: 'collected',
  recommended: 'recommended',
};
/** Charts that take a period segment (`/movies/played/weekly`). */
const PERIOD_CHARTS = new Set<TraktPopularSettings['listType']>(['watched', 'played', 'collected', 'recommended']);

export const traktPopular: Provider<'traktPopular'> = async (s, mediaType, ctx) => {
  const years =
    s.yearFrom !== undefined || s.yearTo !== undefined ? `${s.yearFrom ?? s.yearTo}-${s.yearTo ?? s.yearFrom}` : undefined;
  const filters = {
    limit: s.limit,
    years,
    genres: s.genres.length ? s.genres.join(',') : undefined,
    languages: s.languages.length ? s.languages.join(',') : undefined,
    ratings: s.minRating !== undefined ? `${s.minRating}-100` : undefined,
  };
  const out: FetchedItem[] = [];
  for (const { kind, path } of kinds(mediaType)) {
    if (s.listType === 'boxOffice' && kind === 'series') continue; // movies only
    const chart = POPULAR_PATHS[s.listType] + (PERIOD_CHARTS.has(s.listType) ? `/${s.period}` : '');
    const rows = await traktGet(ctx, s, `/${path}/${chart}`, filters);
    for (const r of rows) {
      const item = fromTrakt(r, kind);
      if (item) out.push(item);
    }
  }
  return out;
};

export const traktUser: Provider<'traktUser'> = async (s, mediaType, ctx) => {
  const user = s.username ? encodeURIComponent(s.username) : 'me';
  if (user === 'me' && !s.accessToken) {
    throw new ImportListFetchError('auth', 'Trakt user lists without a username need authentication');
  }
  if (s.listType === 'recommendations' && !s.accessToken) {
    throw new ImportListFetchError('auth', 'Trakt recommendations are personal and need authentication');
  }
  const out: FetchedItem[] = [];
  for (const { kind, path } of kinds(mediaType)) {
    // Recommendations are always the authenticated user's own; the rest are per-user paths.
    const url = s.listType === 'recommendations' ? `/recommendations/${path}` : `/users/${user}/${s.listType}/${path}`;
    const rows = await traktGet(ctx, s, url, { limit: s.limit, ignore_collected: s.listType === 'recommendations' ? 'true' : undefined });
    for (const r of rows) {
      const item = fromTrakt(r, kind);
      if (item) out.push(item);
    }
  }
  return out;
};

/** A list row from `/users/{u}/lists` (bare) or `/users/{u}/likes/lists` (`{ list: {...} }`). */
export function parseTraktLists(rows: unknown[]): Array<{ id: number; slug: string | null; name: string }> {
  const out: Array<{ id: number; slug: string | null; name: string }> = [];
  for (const raw of rows) {
    const r = asRecord(raw);
    const list = asRecord(r?.['list']) ?? r;
    const ids = asRecord(list?.['ids']);
    const id = int(ids?.['trakt']);
    if (!list || id === null) continue;
    out.push({ id, slug: str(ids?.['slug']), name: str(list['name']) ?? String(id) });
  }
  return out;
}

export const traktLists: Provider<'traktLists'> = async (s, mediaType, ctx) => {
  const user = s.username ? encodeURIComponent(s.username) : 'me';
  if (user === 'me' && !s.accessToken) {
    throw new ImportListFetchError('auth', 'Trakt lists without a username need authentication');
  }
  const listRows = await traktGet(ctx, s, s.source === 'liked' ? `/users/${user}/likes/lists` : `/users/${user}/lists`, {
    limit: s.source === 'liked' ? 100 : undefined,
  });
  const wanted = new Set(s.listNames.map((n) => n.toLowerCase()));
  const lists = parseTraktLists(listRows).filter(
    (l) => wanted.size === 0 || wanted.has(l.name.toLowerCase()) || (l.slug !== null && wanted.has(l.slug.toLowerCase())),
  );
  const types = kinds(mediaType).map((k) => (k.kind === 'series' ? 'show' : 'movie')).join(',');
  const out: FetchedItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (out.length >= s.limit) break;
    const rows = await traktGet(ctx, s, `/lists/${list.id}/items/${types}`, { limit: s.limit });
    for (const r of rows) {
      const item = fromTrakt(r);
      if (!item || !wants(mediaType, item.mediaType)) continue;
      const key = `${item.mediaType}:${item.tmdbId ?? item.imdbId ?? item.tvdbId ?? item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.slice(0, s.limit);
};

// ---- device-code OAuth flow -----------------------------------------------------------

export async function traktDeviceCode(fetch: FetchLike, clientId: string): Promise<TraktDeviceResponse> {
  const body = asRecord(
    await getJson({ fetch }, 'Trakt', `${TRAKT_BASE}/oauth/device/code`, {
      method: 'POST',
      headers: headers(clientId),
      body: JSON.stringify({ client_id: clientId }),
    }),
  );
  const deviceCode = str(body?.['device_code']);
  const userCode = str(body?.['user_code']);
  if (!deviceCode || !userCode) throw new ImportListFetchError('bad-response', 'Trakt device code response is incomplete');
  return {
    deviceCode,
    userCode,
    verificationUrl: str(body?.['verification_url']) ?? 'https://trakt.tv/activate',
    expiresIn: int(body?.['expires_in']) ?? 600,
    interval: int(body?.['interval']) ?? 5,
  };
}

export type TraktPollOutcome =
  | { status: 'authorized'; tokens: TraktTokens }
  | { status: 'pending' | 'slowDown' | 'denied' | 'expired' | 'invalid' };

/** One poll of the device token endpoint. Trakt signals state through the HTTP status. */
export async function traktPollToken(
  fetch: FetchLike,
  args: { deviceCode: string; clientId: string; clientSecret: string },
  now: Date,
): Promise<TraktPollOutcome> {
  const init: RequestInit = {
    method: 'POST',
    headers: headers(args.clientId),
    body: JSON.stringify({ code: args.deviceCode, client_id: args.clientId, client_secret: args.clientSecret }),
  };
  let res: Response;
  try {
    res = await fetch(`${TRAKT_BASE}/oauth/device/token`, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (cause) {
    throw new ImportListFetchError('unreachable', 'Trakt is unreachable', { cause });
  }
  switch (res.status) {
    case 200:
      return { status: 'authorized', tokens: tokensFrom(await res.json(), now) };
    case 400:
      return { status: 'pending' };
    case 429:
      return { status: 'slowDown' };
    case 418:
      return { status: 'denied' };
    case 410:
      return { status: 'expired' };
    case 404:
    case 409:
      return { status: 'invalid' };
    default:
      // Reuse the shared mapping for auth and server errors.
      await request({ fetch: async () => res }, 'Trakt', `${TRAKT_BASE}/oauth/device/token`);
      throw new ImportListFetchError('bad-response', `Trakt answered HTTP ${res.status}`);
  }
}
