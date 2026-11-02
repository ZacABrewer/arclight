import { gunzipSync } from 'node:zlib';
import type { ImdbTopSettings } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, getText, imdbIdOf, int, mapLimit, str } from './http.js';
import { wants, type FetchedItem, type Provider, type ProviderContext } from './types.js';
import { withTmdbErrors } from './tmdb.js';

export function imdbExportUrl(listId: string): string {
  return listId.startsWith('ur')
    ? `https://www.imdb.com/user/${listId}/watchlist/export`
    : `https://www.imdb.com/list/${listId}/export`;
}

/** RFC-4180-ish CSV: quoted fields, doubled quotes, CRLF or LF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** IMDb title types to library kinds; shorts, episodes, games etc. are skipped. */
function kindOf(titleType: string | null): 'series' | 'movie' | null {
  const t = (titleType ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (t === 'tvseries' || t === 'tvminiseries') return 'series';
  if (t === 'movie' || t === 'tvmovie' || t === 'feature' || t === 'video' || t === '') return 'movie';
  return null;
}

/** Parse an IMDb list export: CSV (Const, Title, Year, Title Type) or a JSON array of the same. */
export function parseImdbExport(text: string): FetchedItem[] {
  const trimmed = text.trim();
  const out: FetchedItem[] = [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (cause) {
      throw new ImportListFetchError('bad-response', 'IMDb export is not valid JSON', { cause });
    }
    const rows = Array.isArray(json) ? json : asArray(asRecord(json)?.['items']);
    for (const raw of rows) {
      const r = asRecord(raw);
      const imdbId = imdbIdOf(r?.['const'] ?? r?.['Const'] ?? r?.['imdbId'] ?? r?.['id']);
      const kind = kindOf(str(r?.['titleType'] ?? r?.['Title Type'] ?? r?.['type']));
      if (!r || !imdbId || !kind) continue;
      out.push({ mediaType: kind, imdbId, title: str(r['title'] ?? r['Title']) ?? imdbId, year: int(r['year'] ?? r['Year']) });
    }
    return out;
  }
  const [header, ...rows] = parseCsv(trimmed);
  if (!header) return out;
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const iConst = col('const');
  const iTitle = col('title');
  const iYear = col('year');
  const iType = col('title type');
  if (iConst < 0) throw new ImportListFetchError('bad-response', 'IMDb export has no Const column');
  for (const r of rows) {
    const imdbId = imdbIdOf(r[iConst]);
    const kind = kindOf(iType >= 0 ? (r[iType] ?? null) : null);
    if (!imdbId || !kind) continue;
    out.push({
      mediaType: kind,
      imdbId,
      title: (iTitle >= 0 ? str(r[iTitle]) : null) ?? imdbId,
      year: iYear >= 0 ? int(r[iYear]) : null,
    });
  }
  return out;
}

export const imdbList: Provider<'imdbList'> = async (settings, mediaType, ctx) => {
  const text = await getText(ctx, 'IMDb', imdbExportUrl(settings.listId), { headers: { Accept: 'text/csv, application/json' } });
  return parseImdbExport(text).filter((i) => wants(mediaType, i.mediaType));
};

// ---- IMDb Top Rated from the official datasets ------------------------------------------
//
// IMDb publishes daily TSV dumps for personal and non-commercial use (datasets.imdbws.com).
// title.ratings carries every rated title's average and vote count but no title type, so
// candidates are resolved through TMDB's find-by-IMDb-id (cached per id); episodes, shorts and
// games have no TMDB movie/series match and drop out.

export const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const IMDB_RATINGS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESOLVE_CONCURRENCY = 4;
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

export interface ImdbRating {
  imdbId: string;
  rating: number;
  votes: number;
}

/** Rated titles with at least `minVotes` votes, best first (ties: more votes first). */
export function parseImdbRatings(tsv: string, minVotes: number): ImdbRating[] {
  const out: ImdbRating[] = [];
  let start = tsv.indexOf(NL) + 1; // skip the header row
  while (start > 0 && start < tsv.length) {
    let end = tsv.indexOf(NL, start);
    if (end < 0) end = tsv.length;
    const line = tsv.slice(start, end);
    start = end + 1;
    const [id, avg, num] = line.split(TAB);
    const votes = Number(num);
    if (!id || !(votes >= minVotes)) continue;
    const rating = Number(avg);
    if (!Number.isFinite(rating)) continue;
    out.push({ imdbId: id, rating, votes });
  }
  return out.sort((a, b) => b.rating - a.rating || b.votes - a.votes);
}

async function resolveImdb(ctx: ProviderContext, imdbId: string): Promise<FetchedItem | null> {
  const cached = ctx.ids.get('imdb', imdbId);
  if (cached) {
    if (cached.tmdbId === null || !cached.mediaType) return null;
    return { mediaType: cached.mediaType, tmdbId: cached.tmdbId, imdbId, title: cached.title ?? imdbId, year: cached.year };
  }
  const { client } = ctx.tmdb();
  const [hit] = await withTmdbErrors(() => client.findByImdbId(imdbId));
  if (!hit) {
    ctx.ids.set('imdb', imdbId, { mediaType: null, tmdbId: null, imdbId, title: null, year: null });
    return null;
  }
  ctx.ids.set('imdb', imdbId, { mediaType: hit.mediaType, tmdbId: hit.tmdbId, imdbId, title: hit.title, year: hit.year ?? null });
  return { mediaType: hit.mediaType, tmdbId: hit.tmdbId, imdbId, title: hit.title, year: hit.year ?? null };
}

export const imdbTop: Provider<'imdbTop'> = async (s: ImdbTopSettings, mediaType, ctx) => {
  const gz = await ctx.datasets.get('imdb-title-ratings.tsv.gz', IMDB_RATINGS_URL, {
    maxAgeMs: IMDB_RATINGS_MAX_AGE_MS,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  let tsv: string;
  try {
    tsv = gunzipSync(gz).toString('utf8');
  } catch (cause) {
    throw new ImportListFetchError('bad-response', 'the IMDb ratings dataset is not a gzip file', { cause });
  }
  const candidates = parseImdbRatings(tsv, s.minVotes);
  // Most top-rated titles are episodes when unfiltered; resolve in batches until the list is full.
  const budget = Math.min(candidates.length, s.limit * 4);
  const out: FetchedItem[] = [];
  const batch = Math.max(RESOLVE_CONCURRENCY * 5, s.limit);
  for (let i = 0; i < budget && out.length < s.limit; i += batch) {
    const slice = candidates.slice(i, Math.min(i + batch, budget));
    const items = await mapLimit(slice, RESOLVE_CONCURRENCY, (c) => resolveImdb(ctx, c.imdbId));
    for (const item of items) {
      if (item && wants(mediaType, item.mediaType)) out.push(item);
      if (out.length >= s.limit) break;
    }
  }
  return out;
};
