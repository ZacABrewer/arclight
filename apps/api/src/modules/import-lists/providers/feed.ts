import type { ImportListMediaType } from '@media-tron/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, getText, imdbIdOf, int, str } from './http.js';
import { wants, type FetchedItem, type Provider } from './types.js';

// Generic feeds: a JSON document of titles (or bare TMDB ids), or an RSS/Atom feed whose items
// carry TMDB/IMDb ids in links or tags. StevenLu's popular-movies feed is the JSON shape.

function kindFrom(v: unknown, fallback: 'series' | 'movie'): 'series' | 'movie' {
  const s = str(v)?.toLowerCase();
  if (s === 'tv' || s === 'show' || s === 'series' || s === 'tvseries') return 'series';
  if (s === 'movie' || s === 'film') return 'movie';
  return fallback;
}

function fallbackKind(mediaType: ImportListMediaType): 'series' | 'movie' {
  return mediaType === 'series' ? 'series' : 'movie';
}

export function parseJsonFeed(json: unknown, mediaType: ImportListMediaType): FetchedItem[] {
  const fallback = fallbackKind(mediaType);
  const root = asRecord(json);
  const rows = Array.isArray(json) ? json : asArray(root?.['items'] ?? root?.['results'] ?? root?.['movies'] ?? root?.['shows']);
  const out: FetchedItem[] = [];
  for (const raw of rows) {
    const bare = int(raw);
    if (bare !== null) {
      out.push({ mediaType: fallback, tmdbId: bare, title: `TMDB ${bare}` });
      continue;
    }
    const r = asRecord(raw);
    if (!r) continue;
    const tmdbId = int(r['tmdbId'] ?? r['tmdb_id'] ?? r['tmdb'] ?? r['id']);
    const imdbId = imdbIdOf(r['imdbId'] ?? r['imdb_id'] ?? r['imdb']);
    const tvdbId = int(r['tvdbId'] ?? r['tvdb_id'] ?? r['tvdb']);
    if (tmdbId === null && !imdbId && tvdbId === null) continue;
    out.push({
      mediaType: kindFrom(r['mediaType'] ?? r['media_type'] ?? r['type'], fallback),
      tmdbId,
      imdbId,
      tvdbId,
      title: str(r['title'] ?? r['name']) ?? imdbId ?? `TMDB ${tmdbId ?? tvdbId}`,
      year: int(r['year']),
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m?.[1] !== undefined ? decodeXml(m[1]) : null;
}

export function parseXmlFeed(xml: string, mediaType: ImportListMediaType): FetchedItem[] {
  const fallback = fallbackKind(mediaType);
  const out: FetchedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const text = decodeXml(block);
    const tmdbLink = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(text);
    const tmdbTag = tag(block, 'tmdb') ?? tag(block, 'tmdbid') ?? tag(block, 'tmdb:id');
    const imdb = /\b(tt\d{7,})\b/.exec(text)?.[1] ?? null;
    const tvdb = tag(block, 'tvdb') ?? tag(block, 'tvdbid');
    const tmdbId = tmdbLink ? int(tmdbLink[2]) : int(tmdbTag);
    if (tmdbId === null && !imdb && int(tvdb) === null) continue;
    const kind = tmdbLink ? (tmdbLink[1]!.toLowerCase() === 'tv' ? 'series' : 'movie') : kindFrom(tag(block, 'mediatype'), fallback);
    const rawTitle = tag(block, 'title') ?? '';
    const yearMatch = /\((\d{4})\)\s*$/.exec(rawTitle);
    const title = rawTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim() || imdb || `TMDB ${tmdbId}`;
    out.push({
      mediaType: kind,
      tmdbId,
      imdbId: imdb,
      tvdbId: int(tvdb),
      title,
      year: yearMatch ? int(yearMatch[1]) : int(tag(block, 'year')),
    });
  }
  return out;
}

export function parseFeed(text: string, mediaType: ImportListMediaType): FetchedItem[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (cause) {
      throw new ImportListFetchError('bad-response', 'feed is not valid JSON', { cause });
    }
    return parseJsonFeed(json, mediaType);
  }
  if (trimmed.startsWith('<')) return parseXmlFeed(trimmed, mediaType);
  throw new ImportListFetchError('bad-response', 'feed is neither JSON nor RSS/Atom');
}

export const rssList: Provider<'rss'> = async (settings, mediaType, ctx) => {
  const text = await getText(ctx, 'Feed', settings.url, { headers: { Accept: 'application/json, application/rss+xml, application/xml' } });
  return parseFeed(text, mediaType).filter((i) => wants(mediaType, i.mediaType));
};

export const stevenLu: Provider<'stevenLu'> = async (settings, mediaType, ctx) => {
  if (!wants(mediaType, 'movie')) return [];
  const text = await getText(ctx, 'StevenLu', settings.url, { headers: { Accept: 'application/json' } });
  return parseFeed(text, 'movie').filter((i) => i.mediaType === 'movie');
};
