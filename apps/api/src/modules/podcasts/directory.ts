import { createHash } from 'node:crypto';
import type { PodcastSearchResult, PodcastSearchSource } from '@arclight/shared';
import { fetchText, PodcastHttpError, USER_AGENT, type Transport } from './http.js';

// Podcast directories: the iTunes Search API (no key) and Podcast Index (free key + secret,
// signed per request). Both only return metadata and feed URLs; episodes always come from the
// publisher's feed.

export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
export const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup';
export const PODCAST_INDEX_URL = 'https://api.podcastindex.org/api/1.0';
const LIMIT = 30;

export interface DirectoryOptions {
  transport: Transport;
  country: string;
  podcastIndexKey: string | null;
  podcastIndexSecret: string | null;
  now?: () => number;
}

type SearchHit = Omit<PodcastSearchResult, 'podcastId'>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

function parseJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PodcastHttpError(`${what} answered with something that is not JSON`);
  }
}

// ---------------------------------------------------------------------------------------
// iTunes
// ---------------------------------------------------------------------------------------

function itunesHit(r: Record<string, unknown>): SearchHit | null {
  const feedUrl = str(r.feedUrl);
  const title = str(r.collectionName) ?? str(r.trackName);
  if (!feedUrl || !title) return null;
  const genres = Array.isArray(r.genres) ? r.genres.filter((g): g is string => typeof g === 'string' && g !== 'Podcasts') : [];
  return {
    source: 'itunes',
    title,
    author: str(r.artistName),
    feedUrl,
    imageUrl: str(r.artworkUrl600) ?? str(r.artworkUrl100),
    description: null,
    categories: genres,
    episodeCount: num(r.trackCount),
    itunesId: num(r.collectionId),
    podcastIndexId: null,
    explicit: r.collectionExplicitness === 'explicit',
  };
}

export async function searchItunes(opts: DirectoryOptions, term: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set('media', 'podcast');
  url.searchParams.set('entity', 'podcast');
  url.searchParams.set('term', term);
  url.searchParams.set('country', opts.country.toLowerCase());
  url.searchParams.set('limit', String(LIMIT));
  const { body } = await fetchText(opts.transport, url.toString(), { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
  const json = parseJson(body, 'iTunes') as { results?: unknown };
  const results = Array.isArray(json.results) ? json.results : [];
  return results.flatMap((r) => (r && typeof r === 'object' ? (itunesHit(r as Record<string, unknown>) ?? []) : []));
}

/** The feed URL behind an iTunes / Apple Podcasts id. */
export async function lookupItunes(opts: DirectoryOptions, id: number, signal?: AbortSignal): Promise<SearchHit | null> {
  const url = new URL(ITUNES_LOOKUP_URL);
  url.searchParams.set('id', String(id));
  url.searchParams.set('entity', 'podcast');
  const { body } = await fetchText(opts.transport, url.toString(), { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
  const json = parseJson(body, 'iTunes') as { results?: unknown };
  const first = Array.isArray(json.results) ? json.results[0] : undefined;
  return first && typeof first === 'object' ? itunesHit(first as Record<string, unknown>) : null;
}

/** `https://podcasts.apple.com/us/podcast/name/id123456789` → 123456789. */
export function applePodcastsId(raw: string): number | null {
  try {
    const u = new URL(raw);
    if (!/(^|\.)(podcasts|itunes)\.apple\.com$/i.test(u.hostname)) return null;
    const m = /\/id(\d{3,})/.exec(u.pathname) ?? /^(\d{3,})$/.exec(u.searchParams.get('id') ?? '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Podcast Index
// ---------------------------------------------------------------------------------------

/** The four request headers Podcast Index wants: key, date and sha1(key + secret + date). */
export function podcastIndexHeaders(key: string, secret: string, nowSeconds: number): Record<string, string> {
  const date = String(nowSeconds);
  return {
    'user-agent': USER_AGENT,
    'x-auth-key': key,
    'x-auth-date': date,
    authorization: createHash('sha1').update(`${key}${secret}${date}`).digest('hex'),
    accept: 'application/json',
  };
}

function podcastIndexHit(f: Record<string, unknown>): SearchHit | null {
  const feedUrl = str(f.url) ?? str(f.originalUrl);
  const title = str(f.title);
  if (!feedUrl || !title) return null;
  const cats = f.categories && typeof f.categories === 'object' ? Object.values(f.categories as Record<string, unknown>).filter((c): c is string => typeof c === 'string') : [];
  return {
    source: 'podcastindex',
    title,
    author: str(f.author) ?? str(f.ownerName),
    feedUrl,
    imageUrl: str(f.artwork) ?? str(f.image),
    description: str(f.description),
    categories: cats,
    episodeCount: num(f.episodeCount),
    itunesId: num(f.itunesId),
    podcastIndexId: num(f.id),
    explicit: f.explicit === true,
  };
}

export async function searchPodcastIndex(opts: DirectoryOptions, term: string, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!opts.podcastIndexKey || !opts.podcastIndexSecret) throw new PodcastHttpError('Podcast Index needs an API key and secret (Settings → Podcasts)');
  const url = new URL(`${PODCAST_INDEX_URL}/search/byterm`);
  url.searchParams.set('q', term);
  url.searchParams.set('max', String(LIMIT));
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const { body } = await fetchText(opts.transport, url.toString(), {
    headers: podcastIndexHeaders(opts.podcastIndexKey, opts.podcastIndexSecret, now),
    ...(signal ? { signal } : {}),
  });
  const json = parseJson(body, 'Podcast Index') as { feeds?: unknown; status?: unknown; description?: unknown };
  if (json.status === 'false' || json.status === false) throw new PodcastHttpError(`Podcast Index: ${str(json.description) ?? 'request refused'}`);
  const feeds = Array.isArray(json.feeds) ? json.feeds : [];
  return feeds.flatMap((f) => (f && typeof f === 'object' ? (podcastIndexHit(f as Record<string, unknown>) ?? []) : []));
}

/** Default source: Podcast Index when it is configured, else iTunes. */
export function defaultSource(opts: Pick<DirectoryOptions, 'podcastIndexKey' | 'podcastIndexSecret'>): PodcastSearchSource {
  return opts.podcastIndexKey && opts.podcastIndexSecret ? 'podcastindex' : 'itunes';
}

export async function searchDirectory(opts: DirectoryOptions, term: string, source?: PodcastSearchSource, signal?: AbortSignal): Promise<SearchHit[]> {
  const which = source ?? defaultSource(opts);
  return which === 'podcastindex' ? searchPodcastIndex(opts, term, signal) : searchItunes(opts, term, signal);
}
