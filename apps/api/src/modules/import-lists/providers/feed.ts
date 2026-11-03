import type { CustomUrlSettings, ImportListMediaType } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, imdbIdOf, int, request, str } from './http.js';
import { parseCsv } from './imdb.js';
import { wants, type FetchedItem, type Provider, type ProviderContext } from './types.js';

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
  const root = asRecord(json);
  // `{ movies: [...], shows: [...] }` documents keep both halves with their kind.
  if (root && !Array.isArray(root['items']) && Array.isArray(root['movies']) && Array.isArray(root['shows'])) {
    return [...parseJsonRows(root['movies'], 'movie'), ...parseJsonRows(root['shows'], 'series')];
  }
  const rows = Array.isArray(json)
    ? json
    : asArray(root?.['items'] ?? root?.['results'] ?? root?.['data'] ?? root?.['movies'] ?? root?.['shows']);
  return parseJsonRows(rows, fallbackKind(mediaType));
}

function parseJsonRows(rows: unknown[], fallback: 'series' | 'movie'): FetchedItem[] {
  const out: FetchedItem[] = [];
  for (const raw of rows) {
    const bare = int(raw);
    if (bare !== null) {
      out.push({ mediaType: fallback, tmdbId: bare, title: `TMDB ${bare}` });
      continue;
    }
    let r = asRecord(raw);
    if (!r) continue;
    // Trakt-style rows wrap the title: `{ movie: {...} }` / `{ show: {...} }`.
    let rowKind = fallback;
    if (asRecord(r['movie'])) [r, rowKind] = [asRecord(r['movie'])!, 'movie'];
    else if (asRecord(r['show'])) [r, rowKind] = [asRecord(r['show'])!, 'series'];
    const ids = asRecord(r['ids']);
    // A bare `id` is a TMDB id only when there is no `ids` object naming the services.
    const tmdbId = int(r['tmdbId'] ?? r['tmdb_id'] ?? r['tmdb'] ?? ids?.['tmdb'] ?? (ids ? undefined : r['id']));
    const imdbId = imdbIdOf(r['imdbId'] ?? r['imdb_id'] ?? r['imdb'] ?? ids?.['imdb']);
    const tvdbId = int(r['tvdbId'] ?? r['tvdb_id'] ?? r['tvdb'] ?? ids?.['tvdb']);
    if (tmdbId === null && !imdbId && tvdbId === null) continue;
    out.push({
      mediaType: kindFrom(r['mediaType'] ?? r['media_type'] ?? r['mediatype'] ?? r['type'], rowKind),
      tmdbId,
      imdbId,
      tvdbId,
      title: str(r['title'] ?? r['name']) ?? imdbId ?? `TMDB ${tmdbId ?? tvdbId}`,
      year: int(r['year']),
    });
  }
  return out;
}

/** Largest feed or list document read; real ones are a few hundred kilobytes. */
export const MAX_FEED_BYTES = 16 * 1024 * 1024;
/** Longest item title kept; the year regexes below run on it. */
const MAX_FEED_TITLE = 512;

/** The response body as text, refused once it passes MAX_FEED_BYTES. */
async function getFeedText(ctx: Pick<ProviderContext, 'fetch' | 'signal'>, what: string, url: string, init: RequestInit): Promise<string> {
  const res = await request(ctx, what, url, init);
  const declared = Number(res.headers.get('content-length'));
  const tooBig = () => new ImportListFetchError('bad-response', `${what} sent more than ${MAX_FEED_BYTES / 1024 / 1024} MB`);
  if (declared > MAX_FEED_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Every `<name ...>...</name>` element (first match wins, as a lazy regex would), found with
 * indexOf so an unclosed tag costs one scan, not one scan per opening tag.
 */
function elements(xml: string, names: readonly string[], limit = Infinity): string[] {
  const lower = xml.toLowerCase();
  const out: string[] = [];
  const open = names.map((n) => `<${n}`);
  const closed = new Set<number>(); // names with no closing tag left
  let pos = 0;
  while (out.length < limit) {
    let at = -1;
    let which = -1;
    for (let k = 0; k < names.length; k++) {
      if (closed.has(k)) continue;
      const i = lower.indexOf(open[k]!, pos);
      if (i >= 0 && (at < 0 || i < at)) [at, which] = [i, k];
    }
    if (at < 0) break;
    const after = at + open[which]!.length;
    const next = xml[after];
    if (next === undefined || !(next === '>' || /\s/.test(next))) {
      pos = at + 1;
      continue;
    }
    const closer = `</${names[which]}>`;
    const end = lower.indexOf(closer, after + 1);
    if (end < 0) {
      closed.add(which);
      pos = at + 1;
      continue;
    }
    out.push(xml.slice(at, end + closer.length));
    pos = end + closer.length;
  }
  return out;
}

function stripCdata(s: string): string {
  if (!s.includes('<![CDATA[')) return s;
  let out = '';
  let pos = 0;
  for (;;) {
    const start = s.indexOf('<![CDATA[', pos);
    const end = start < 0 ? -1 : s.indexOf(']]>', start + 9);
    if (end < 0) return out + s.slice(pos);
    out += s.slice(pos, start) + s.slice(start + 9, end);
    pos = end + 3;
  }
}

function decodeXml(s: string): string {
  return stripCdata(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block: string, name: string): string | null {
  const el = elements(block, [name], 1)[0];
  if (el === undefined) return null;
  return decodeXml(el.slice(el.indexOf('>') + 1, el.length - name.length - 3));
}

export function parseXmlFeed(xml: string, mediaType: ImportListMediaType): FetchedItem[] {
  const fallback = fallbackKind(mediaType);
  const out: FetchedItem[] = [];
  for (const block of elements(xml, ['item', 'entry'])) {
    const text = decodeXml(block);
    const tmdbLink = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(text);
    const tmdbTag = tag(block, 'tmdb') ?? tag(block, 'tmdbid') ?? tag(block, 'tmdb:id');
    const imdb = /\b(tt\d{7,})\b/.exec(text)?.[1] ?? null;
    const tvdb = tag(block, 'tvdb') ?? tag(block, 'tvdbid');
    const tmdbId = tmdbLink ? int(tmdbLink[2]) : int(tmdbTag);
    if (tmdbId === null && !imdb && int(tvdb) === null) continue;
    const kind = tmdbLink ? (tmdbLink[1]!.toLowerCase() === 'tv' ? 'series' : 'movie') : kindFrom(tag(block, 'mediatype'), fallback);
    const rawTitle = (tag(block, 'title') ?? '').slice(0, MAX_FEED_TITLE);
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
  if (text.length > MAX_FEED_BYTES) throw new ImportListFetchError('bad-response', 'feed is too large');
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
  const text = await getFeedText(ctx, 'Feed', settings.url, { headers: { Accept: 'application/json, application/rss+xml, application/xml' } });
  return parseFeed(text, mediaType).filter((i) => wants(mediaType, i.mediaType));
};

export const stevenLu: Provider<'stevenLu'> = async (settings, mediaType, ctx) => {
  if (!wants(mediaType, 'movie')) return [];
  const text = await getFeedText(ctx, 'StevenLu', settings.url, { headers: { Accept: 'application/json' } });
  return parseFeed(text, 'movie').filter((i) => i.mediaType === 'movie');
};

/** Walk a dotted path (`data.items`) into a JSON document. */
function atPath(json: unknown, path: string | undefined): unknown {
  if (!path) return json;
  let cur: unknown = json;
  for (const part of path.split('.').filter(Boolean)) {
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else cur = asRecord(cur)?.[part];
    if (cur === undefined) throw new ImportListFetchError('bad-response', `the document has nothing at "${path}"`);
  }
  return cur;
}

const CSV_COLUMNS = {
  tmdb: ['tmdb', 'tmdbid', 'tmdb_id', 'tmdb id', 'themoviedb'],
  imdb: ['imdb', 'imdbid', 'imdb_id', 'imdb id', 'const'],
  tvdb: ['tvdb', 'tvdbid', 'tvdb_id', 'tvdb id'],
  title: ['title', 'name'],
  year: ['year', 'release year', 'release_year'],
  type: ['type', 'mediatype', 'media_type', 'media type', 'title type', 'kind'],
};

/** A CSV with a header row naming any of the id columns above (case-insensitive). */
export function parseCsvList(text: string, mediaType: ImportListMediaType): FetchedItem[] {
  const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!header) return [];
  const names = header.map((h) => h.trim().toLowerCase());
  const col = (k: keyof typeof CSV_COLUMNS) => names.findIndex((n) => CSV_COLUMNS[k].includes(n));
  const i = { tmdb: col('tmdb'), imdb: col('imdb'), tvdb: col('tvdb'), title: col('title'), year: col('year'), type: col('type') };
  if (i.tmdb < 0 && i.imdb < 0 && i.tvdb < 0) {
    throw new ImportListFetchError('bad-response', 'the CSV has no tmdb, imdb or tvdb column');
  }
  const fallback = fallbackKind(mediaType);
  const cell = (r: string[], idx: number) => (idx >= 0 ? (r[idx]?.trim() ?? '') : '');
  const out: FetchedItem[] = [];
  for (const r of rows) {
    const tmdbId = int(cell(r, i.tmdb));
    const imdbId = imdbIdOf(cell(r, i.imdb));
    const tvdbId = int(cell(r, i.tvdb));
    if (tmdbId === null && !imdbId && tvdbId === null) continue;
    out.push({
      mediaType: kindFrom(cell(r, i.type), fallback),
      tmdbId,
      imdbId,
      tvdbId,
      title: str(cell(r, i.title)) ?? imdbId ?? `TMDB ${tmdbId ?? tvdbId}`,
      year: int(cell(r, i.year)),
    });
  }
  return out;
}

export function parseCustomDocument(text: string, s: Pick<CustomUrlSettings, 'format' | 'itemsPath'>, mediaType: ImportListMediaType): FetchedItem[] {
  const trimmed = text.trim();
  const format = s.format === 'auto' ? (trimmed.startsWith('[') || trimmed.startsWith('{') ? 'json' : 'csv') : s.format;
  if (format === 'csv') return parseCsvList(trimmed, mediaType);
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (cause) {
    throw new ImportListFetchError('bad-response', 'the document is not valid JSON', { cause });
  }
  return parseJsonFeed(atPath(json, s.itemsPath), mediaType);
}

export const customUrl: Provider<'customUrl'> = async (settings, mediaType, ctx) => {
  const headers: Record<string, string> = { Accept: 'application/json, text/csv, text/plain' };
  if (settings.headerName && settings.headerValue) headers[settings.headerName] = settings.headerValue;
  const text = await getFeedText(ctx, 'Custom list', settings.url, { headers });
  return parseCustomDocument(text, settings, mediaType).filter((i) => wants(mediaType, i.mediaType));
};
