import { MetadataError } from '@arclight/metadata';
import { MetadataCollection, type MetadataCollectionPart } from '@arclight/shared';

// TMDB movie collections (`/collection/:id`): the TMDB client in @arclight/metadata does not
// cover them, so this is one small raw call mapped onto the shared contract.

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

export interface CollectionFetchOptions {
  apiKey: string;
  language?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function image(path: unknown, size: string): string | undefined {
  const p = str(path);
  return p ? `${IMAGE_BASE}/${size}${p.startsWith('/') ? '' : '/'}${p}` : undefined;
}

function images(raw: Record<string, unknown>) {
  const poster = image(raw['poster_path'], 'w500');
  const backdrop = image(raw['backdrop_path'], 'w1280');
  return { ...(poster ? { poster } : {}), ...(backdrop ? { backdrop } : {}) };
}

export function mapCollectionPart(raw: Record<string, unknown>): MetadataCollectionPart | null {
  const tmdbId = raw['id'];
  const title = str(raw['title']) ?? str(raw['original_title']);
  if (typeof tmdbId !== 'number' || !title) return null;
  const releaseDate = str(raw['release_date']);
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : NaN;
  return {
    tmdbId,
    title,
    ...(Number.isFinite(year) ? { year } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    overview: str(raw['overview']) ?? '',
    images: images(raw),
    originalLanguage: str(raw['original_language']) ?? '',
  };
}

/** Map a raw `/collection/:id` body; parts sorted by release date, undated last. */
export function mapCollection(raw: Record<string, unknown>): MetadataCollection {
  const parts = (Array.isArray(raw['parts']) ? raw['parts'] : [])
    .map((p) => (p && typeof p === 'object' ? mapCollectionPart(p as Record<string, unknown>) : null))
    .filter((p): p is MetadataCollectionPart => p !== null)
    .sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999') || a.title.localeCompare(b.title));
  return MetadataCollection.parse({
    tmdbId: raw['id'],
    name: str(raw['name']) ?? 'Collection',
    overview: str(raw['overview']) ?? '',
    images: images(raw),
    parts,
  });
}

export async function fetchTmdbCollection(tmdbId: number, opts: CollectionFetchOptions): Promise<MetadataCollection> {
  const url = new URL(`${opts.baseUrl ?? TMDB_BASE}/collection/${tmdbId}`);
  url.searchParams.set('api_key', opts.apiKey);
  if (opts.language) url.searchParams.set('language', opts.language);
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new MetadataError('unreachable', `TMDB is unreachable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (res.status === 404) throw new MetadataError('not-found', `TMDB collection ${tmdbId} not found`, { httpStatus: 404 });
  if (res.status === 401) throw new MetadataError('unauthorized', 'TMDB rejected the API key', { httpStatus: 401 });
  if (res.status === 429) throw new MetadataError('rate-limited', 'TMDB rate limit reached', { httpStatus: 429 });
  if (!res.ok) throw new MetadataError('bad-response', `TMDB answered ${res.status}`, { httpStatus: res.status });
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new MetadataError('bad-response', 'TMDB returned an unreadable collection');
  try {
    return mapCollection(body as Record<string, unknown>);
  } catch (err) {
    throw new MetadataError('bad-response', 'TMDB returned an unexpected collection shape', { cause: err });
  }
}
