import { asArray, asRecord, getJson, imdbIdOf, int, str } from './http.js';
import { wants, type FetchedItem, type Provider } from './types.js';

export const PLEX_WATCHLIST_URL = 'https://discover.provider.plex.tv/library/sections/watchlist/all';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Parse the `Guid` array (`tmdb://603`, `imdb://tt0133093`, `tvdb://81189`). */
function idsFrom(guids: unknown): { tmdbId: number | null; imdbId: string | null; tvdbId: number | null } {
  const out = { tmdbId: null as number | null, imdbId: null as string | null, tvdbId: null as number | null };
  for (const g of asArray(guids)) {
    const id = str(asRecord(g)?.['id']);
    if (!id) continue;
    const [scheme, value] = id.split('://');
    if (scheme === 'tmdb') out.tmdbId = int(value);
    else if (scheme === 'imdb') out.imdbId = imdbIdOf(value);
    else if (scheme === 'tvdb') out.tvdbId = int(value);
  }
  return out;
}

// The token goes in a header, never the query string, so it does not end up in logs.
export const plexWatchlist: Provider<'plexWatchlist'> = async (settings, mediaType, ctx) => {
  const out: FetchedItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(PLEX_WATCHLIST_URL);
    url.searchParams.set('includeGuids', '1');
    url.searchParams.set('X-Plex-Container-Start', String(page * PAGE_SIZE));
    url.searchParams.set('X-Plex-Container-Size', String(PAGE_SIZE));
    const body = asRecord(
      await getJson(ctx, 'Plex', url.toString(), {
        headers: { 'X-Plex-Token': settings.plexToken, 'X-Plex-Client-Identifier': 'arclight', 'X-Plex-Product': 'Arclight' },
      }),
    );
    const container = asRecord(body?.['MediaContainer']);
    const rows = asArray(container?.['Metadata']);
    for (const raw of rows) {
      const r = asRecord(raw);
      const type = str(r?.['type']);
      const kind = type === 'show' ? 'series' : type === 'movie' ? 'movie' : null;
      const title = str(r?.['title']);
      if (!r || !kind || !title || !wants(mediaType, kind)) continue;
      out.push({ mediaType: kind, title, year: int(r['year']), ...idsFrom(r['Guid']) });
    }
    const total = int(container?.['totalSize']) ?? rows.length;
    if (rows.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= total) break;
  }
  return out;
};
