import type { LetterboxdSettings } from '@arclight/shared';
import { getText, int, mapLimit, USER_AGENT } from './http.js';
import { wants, type FetchedItem, type Provider, type ProviderContext } from './types.js';

// Letterboxd has no public API. Lists and watchlists are public HTML pages whose posters carry
// the film slug; each film page names its TMDB id (data-tmdb-id), which is cached forever per
// slug. A member's diary has an RSS feed that already carries TMDB ids.

export const LETTERBOXD_BASE = 'https://letterboxd.com';
const MAX_PAGES = 25;
const FILM_CONCURRENCY = 4;
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' };

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export interface LetterboxdPoster {
  slug: string;
  title: string;
  year: number | null;
}

/** Posters on one list/watchlist page, in page order, plus the next page link if any. */
export function parseLetterboxdPage(html: string): { posters: LetterboxdPoster[]; next: string | null } {
  const posters: LetterboxdPoster[] = [];
  const seen = new Set<string>();
  // One poster element per film; attribute order varies between page versions.
  for (const m of html.matchAll(/<(?:div|li)\b[^>]*\bdata-(?:item|film)-slug="([^"]+)"[^>]*>/g)) {
    const slug = m[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const tag = m[0];
    const name = decode(/\bdata-item-name="([^"]*)"/.exec(tag)?.[1] ?? /\bdata-film-name="([^"]*)"/.exec(tag)?.[1] ?? '');
    const yearMatch = /\((\d{4})\)\s*$/.exec(name);
    posters.push({
      slug,
      title: name.replace(/\s*\(\d{4}\)\s*$/, '').trim() || slug,
      year: yearMatch ? int(yearMatch[1]) : int(/\bdata-film-release-year="(\d{4})"/.exec(tag)?.[1]),
    });
  }
  if (!posters.length) {
    // Fallback: plain links to film pages.
    for (const m of html.matchAll(/data-target-link="\/film\/([a-z0-9-]+)\/"/g)) {
      if (seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      posters.push({ slug: m[1]!, title: m[1]!, year: null });
    }
  }
  const next = /<a\b[^>]*class="next"[^>]*href="([^"]+)"|<a\b[^>]*href="([^"]+)"[^>]*class="next"/.exec(html);
  const href = next?.[1] ?? next?.[2] ?? null;
  return { posters, next: href ? new URL(decode(href), LETTERBOXD_BASE).toString() : null };
}

/** TMDB (and IMDb) ids from a film page. */
export function parseLetterboxdFilm(html: string): { mediaType: 'series' | 'movie'; tmdbId: number | null; imdbId: string | null } {
  const tmdbId = int(/\bdata-tmdb-id="(\d+)"/.exec(html)?.[1]);
  const type = /\bdata-tmdb-type="(\w+)"/.exec(html)?.[1];
  const imdbId = /imdb\.com\/title\/(tt\d{7,})/.exec(html)?.[1] ?? null;
  return { mediaType: type === 'tv' ? 'series' : 'movie', tmdbId, imdbId };
}

/** Diary RSS: items carry `<tmdb:movieId>` (or `<tmdb:tvId>`) and the film title/year. */
export function parseLetterboxdRss(xml: string): FetchedItem[] {
  const out: FetchedItem[] = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const movieId = int(/<tmdb:movieId>(\d+)<\/tmdb:movieId>/.exec(block)?.[1]);
    const tvId = int(/<tmdb:tvId>(\d+)<\/tmdb:tvId>/.exec(block)?.[1]);
    const title = /<letterboxd:filmTitle>([\s\S]*?)<\/letterboxd:filmTitle>/.exec(block)?.[1];
    const year = int(/<letterboxd:filmYear>(\d{4})<\/letterboxd:filmYear>/.exec(block)?.[1]);
    if (movieId === null && tvId === null) continue;
    out.push({
      mediaType: tvId !== null && movieId === null ? 'series' : 'movie',
      tmdbId: movieId ?? tvId,
      title: title ? decode(title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')).trim() : `TMDB ${movieId ?? tvId}`,
      year,
    });
  }
  return out;
}

/** The first page URL for the configured source; any `/page/N/` suffix is dropped. */
export function letterboxdStartUrl(s: LetterboxdSettings): string {
  const user = encodeURIComponent(s.username ?? '');
  switch (s.source) {
    case 'watchlist':
      return `${LETTERBOXD_BASE}/${user}/watchlist/`;
    case 'list':
      return `${LETTERBOXD_BASE}/${user}/list/${encodeURIComponent(s.listSlug ?? '')}/`;
    case 'diary':
      return `${LETTERBOXD_BASE}/${user}/rss/`;
    case 'url': {
      const url = new URL(s.url!);
      url.pathname = url.pathname.replace(/page\/\d+\/?$/, '').replace(/\/?$/, '/');
      url.search = '';
      return url.toString();
    }
  }
}

async function resolveSlug(ctx: ProviderContext, poster: LetterboxdPoster): Promise<FetchedItem> {
  const cached = ctx.ids.get('letterboxd', poster.slug);
  if (cached) {
    return {
      mediaType: cached.mediaType ?? 'movie',
      tmdbId: cached.tmdbId,
      imdbId: cached.imdbId,
      title: cached.title ?? poster.title,
      year: cached.year ?? poster.year,
    };
  }
  const html = await getText(ctx, 'Letterboxd', `${LETTERBOXD_BASE}/film/${encodeURIComponent(poster.slug)}/`, { headers: HEADERS });
  const film = parseLetterboxdFilm(html);
  ctx.ids.set('letterboxd', poster.slug, { ...film, title: poster.title, year: poster.year });
  return { ...film, title: poster.title, year: poster.year };
}

export const letterboxd: Provider<'letterboxd'> = async (s, mediaType, ctx) => {
  const start = letterboxdStartUrl(s);
  if (s.source === 'diary') {
    const xml = await getText(ctx, 'Letterboxd', start, { headers: { ...HEADERS, Accept: 'application/rss+xml' } });
    return parseLetterboxdRss(xml)
      .filter((i) => wants(mediaType, i.mediaType))
      .slice(0, s.limit);
  }
  const posters: LetterboxdPoster[] = [];
  const seen = new Set<string>();
  let next: string | null = start;
  for (let page = 0; next && page < MAX_PAGES && posters.length < s.limit; page++) {
    const html = await getText(ctx, 'Letterboxd', next, { headers: HEADERS });
    const parsed = parseLetterboxdPage(html);
    for (const p of parsed.posters) {
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);
      posters.push(p);
    }
    next = parsed.next && parsed.next !== next ? parsed.next : null;
  }
  const items = await mapLimit(posters.slice(0, s.limit), FILM_CONCURRENCY, (p) => resolveSlug(ctx, p));
  return items.filter((i) => wants(mediaType, i.mediaType));
};
