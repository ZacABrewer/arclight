import type { MdblistSettings } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, imdbIdOf, int, request, str } from './http.js';
import { wants, type FetchedItem, type Provider } from './types.js';

// MDBList (mdblist.com): public and private user lists through its API with the user's key.
// Lists are addressed by numeric id or by `username/list-slug` (the list URL works too).

export const MDBLIST_BASE = 'https://api.mdblist.com';
const PAGE_SIZE = 1000;

/** `/lists/{id}` or `/lists/{user}/{slug}` from whatever the user pasted. */
export function mdblistPath(list: string): string {
  const raw = list.trim();
  if (/^\d+$/.test(raw)) return `/lists/${raw}`;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!/(^|\.)mdblist\.com$/i.test(url.hostname)) throw new ImportListFetchError('not-found', 'not an mdblist.com list URL');
    path = url.pathname.replace(/^\/lists\//, '');
  }
  const [user, slug] = path.replace(/^\/+|\/+$/g, '').split('/');
  if (!user || !slug) throw new ImportListFetchError('not-found', 'expected an MDBList list id or username/list-slug');
  return `/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}`;
}

function kindOf(v: unknown): 'series' | 'movie' | null {
  const s = str(v)?.toLowerCase();
  if (s === 'movie') return 'movie';
  if (s === 'show' || s === 'tv' || s === 'series') return 'series';
  return null;
}

/** One MDBList row: current `{ ids: { tmdb, imdb, tvdb } }` or legacy `{ id: <tmdb>, imdb_id }`. */
function fromRow(raw: unknown, fallback: 'series' | 'movie'): FetchedItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const ids = asRecord(r['ids']);
  const kind = kindOf(r['mediatype'] ?? r['media_type']) ?? fallback;
  const tmdbId = ids ? int(ids['tmdb']) : int(r['id']);
  const imdbId = imdbIdOf(ids?.['imdb'] ?? r['imdb_id']);
  const tvdbId = int(ids?.['tvdb'] ?? r['tvdb_id']);
  if (tmdbId === null && !imdbId && tvdbId === null) return null;
  return {
    mediaType: kind,
    tmdbId,
    imdbId,
    tvdbId,
    title: str(r['title']) ?? imdbId ?? `TMDB ${tmdbId}`,
    year: int(r['release_year'] ?? r['year']),
  };
}

export function parseMdblistItems(json: unknown): FetchedItem[] {
  const out: FetchedItem[] = [];
  if (Array.isArray(json)) {
    for (const raw of json) {
      const item = fromRow(raw, 'movie');
      if (item) out.push(item);
    }
    return out;
  }
  const body = asRecord(json);
  if (body?.['error']) throw new ImportListFetchError('bad-response', `MDBList: ${str(body['error']) ?? 'error'}`);
  for (const raw of asArray(body?.['movies'])) {
    const item = fromRow(raw, 'movie');
    if (item) out.push(item);
  }
  for (const raw of asArray(body?.['shows'])) {
    const item = fromRow(raw, 'series');
    if (item) out.push(item);
  }
  return out;
}

export const mdblist: Provider<'mdblist'> = async (s: MdblistSettings, mediaType, ctx) => {
  const path = mdblistPath(s.list);
  const out: FetchedItem[] = [];
  for (let offset = 0; offset < s.limit; offset += PAGE_SIZE) {
    const url = new URL(`${MDBLIST_BASE}${path}/items`);
    url.searchParams.set('apikey', s.apiKey);
    url.searchParams.set('limit', String(Math.min(PAGE_SIZE, s.limit - offset)));
    url.searchParams.set('offset', String(offset));
    const res = await request(ctx, 'MDBList', url.toString(), { headers: { Accept: 'application/json' } });
    let json: unknown;
    try {
      json = await res.json();
    } catch (cause) {
      throw new ImportListFetchError('bad-response', 'MDBList returned non-JSON content', { cause });
    }
    const page = parseMdblistItems(json);
    out.push(...page);
    if (res.headers.get('x-has-more') !== 'true' || page.length === 0) break;
  }
  return out.filter((i) => wants(mediaType, i.mediaType)).slice(0, s.limit);
};
