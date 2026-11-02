import type { SimklPinResponse, SimklSettings } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { animeItem, animeKind, loadAnimeIds, type AnimeIdIndex } from './anime-ids.js';
import { asArray, asRecord, getJson, imdbIdOf, int, str } from './http.js';
import { wants, type FetchedItem, type FetchLike, type Provider } from './types.js';

// Simkl: a member's shows, movies and anime by status (plan to watch, watching, ...), read with
// the app's client id and the member's token from the PIN flow. Simkl rows carry TMDB/IMDb/TVDB
// ids; anime rows without them fall back to the anime id mapping through their MAL id.

export const SIMKL_BASE = 'https://api.simkl.com';

function headers(clientId: string, token?: string): Record<string, string> {
  const h: Record<string, string> = { 'simkl-api-key': clientId, 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function fromSimkl(media: unknown, kind: 'series' | 'movie', index: AnimeIdIndex | null): FetchedItem | null {
  const m = asRecord(media);
  const title = str(m?.['title']);
  if (!m || !title) return null;
  const ids = asRecord(m['ids']);
  const item: FetchedItem = {
    mediaType: kind,
    tmdbId: int(ids?.['tmdb']),
    imdbId: imdbIdOf(ids?.['imdb']),
    tvdbId: int(ids?.['tvdb']),
    title,
    year: int(m['year']),
  };
  if (!item.tmdbId && !item.imdbId && !item.tvdbId && index) {
    const mal = int(ids?.['mal']);
    if (mal !== null) return animeItem(index.mal(mal), { kind, title, year: item.year ?? null });
  }
  return item;
}

export function parseSimklItems(json: unknown, index: AnimeIdIndex | null): FetchedItem[] {
  const body = asRecord(json);
  const out: FetchedItem[] = [];
  for (const row of asArray(body?.['movies'])) {
    const item = fromSimkl(asRecord(row)?.['movie'], 'movie', index);
    if (item) out.push(item);
  }
  for (const row of asArray(body?.['shows'])) {
    const item = fromSimkl(asRecord(row)?.['show'], 'series', index);
    if (item) out.push(item);
  }
  for (const row of asArray(body?.['anime'])) {
    const r = asRecord(row);
    const kind = animeKind(str(r?.['anime_type'])) ?? 'series';
    const item = fromSimkl(r?.['show'] ?? r?.['movie'], kind, index);
    if (item) out.push(item);
  }
  return out;
}

export const simkl: Provider<'simkl'> = async (s: SimklSettings, mediaType, ctx) => {
  if (!s.accessToken) throw new ImportListFetchError('auth', 'Simkl needs an access token; authenticate with Simkl first');
  const index = s.types.includes('anime') ? await loadAnimeIds(ctx.datasets, ctx.signal).catch(() => null) : null;
  const out: FetchedItem[] = [];
  for (const type of s.types) {
    if (type === 'movies' && !wants(mediaType, 'movie')) continue;
    if (type === 'shows' && !wants(mediaType, 'series')) continue;
    for (const status of s.statuses) {
      const body = await getJson(ctx, 'Simkl', `${SIMKL_BASE}/sync/all-items/${type}/${status}`, {
        headers: headers(s.clientId, s.accessToken),
      });
      out.push(...parseSimklItems(body, index));
    }
  }
  return out.filter((i) => wants(mediaType, i.mediaType)).slice(0, s.limit);
};

// ---- PIN flow ---------------------------------------------------------------------------

export async function simklPin(fetch: FetchLike, clientId: string): Promise<SimklPinResponse> {
  const url = new URL(`${SIMKL_BASE}/oauth/pin`);
  url.searchParams.set('client_id', clientId);
  const body = asRecord(await getJson({ fetch }, 'Simkl', url.toString(), { headers: headers(clientId) }));
  const userCode = str(body?.['user_code']);
  if (!userCode) throw new ImportListFetchError('bad-response', 'Simkl PIN response is incomplete');
  return {
    userCode,
    verificationUrl: str(body?.['verification_url']) ?? 'https://simkl.com/pin/',
    expiresIn: int(body?.['expires_in']) ?? 900,
    interval: int(body?.['interval']) ?? 5,
  };
}

export type SimklPollOutcome = { status: 'authorized'; accessToken: string } | { status: 'pending' | 'expired' };

export async function simklPollPin(fetch: FetchLike, clientId: string, userCode: string): Promise<SimklPollOutcome> {
  const url = new URL(`${SIMKL_BASE}/oauth/pin/${encodeURIComponent(userCode)}`);
  url.searchParams.set('client_id', clientId);
  let body: Record<string, unknown> | null;
  try {
    body = asRecord(await getJson({ fetch }, 'Simkl', url.toString(), { headers: headers(clientId) }));
  } catch (err) {
    if (err instanceof ImportListFetchError && err.code === 'not-found') return { status: 'expired' };
    throw err;
  }
  const token = str(body?.['access_token']);
  if (str(body?.['result']) === 'OK' && token) return { status: 'authorized', accessToken: token };
  if (/expire/i.test(str(body?.['message']) ?? '')) return { status: 'expired' };
  return { status: 'pending' };
}
