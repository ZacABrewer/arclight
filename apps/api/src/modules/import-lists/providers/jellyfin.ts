import type { JellyfinFavoritesSettings } from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, getJson, imdbIdOf, int, str } from './http.js';
import { wants, type FetchedItem, type Provider } from './types.js';

// A Jellyfin or Emby user's favourite movies and series ("hearted" items), so favouriting a
// title on the media server adds it here. Both servers speak the same items API; Jellyfin moved
// the per-user listing to /Items?userId=, Emby keeps /Users/{id}/Items.

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

export const jellyfinFavorites: Provider<'jellyfinFavorites'> = async (s: JellyfinFavoritesSettings, mediaType, ctx) => {
  const what = s.serverType === 'emby' ? 'Emby' : 'Jellyfin';
  const headers = { 'X-Emby-Token': s.apiKey, Accept: 'application/json' };
  const users = asArray(await getJson(ctx, what, `${base(s.url)}/Users`, { headers }));
  const user = users.map(asRecord).find((u) => str(u?.['Name'])?.toLowerCase() === s.username.toLowerCase());
  const userId = str(user?.['Id']);
  if (!userId) throw new ImportListFetchError('not-found', `${what} has no user "${s.username}"`);

  const types: string[] = [];
  if (wants(mediaType, 'movie')) types.push('Movie');
  if (wants(mediaType, 'series')) types.push('Series');
  const out: FetchedItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(s.serverType === 'emby' ? `${base(s.url)}/Users/${userId}/Items` : `${base(s.url)}/Items`);
    if (s.serverType !== 'emby') url.searchParams.set('userId', userId);
    url.searchParams.set('Filters', 'IsFavorite');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('IncludeItemTypes', types.join(','));
    url.searchParams.set('Fields', 'ProviderIds,ProductionYear');
    url.searchParams.set('StartIndex', String(page * PAGE_SIZE));
    url.searchParams.set('Limit', String(PAGE_SIZE));
    const body = asRecord(await getJson(ctx, what, url.toString(), { headers }));
    const rows = asArray(body?.['Items']);
    for (const raw of rows) {
      const r = asRecord(raw);
      const type = str(r?.['Type']);
      const kind = type === 'Series' ? 'series' : type === 'Movie' ? 'movie' : null;
      const title = str(r?.['Name']);
      if (!r || !kind || !title || !wants(mediaType, kind)) continue;
      // Provider id keys are case-insensitive in practice (Tmdb, TMDB, tmdb).
      const ids = Object.fromEntries(Object.entries(asRecord(r['ProviderIds']) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      out.push({
        mediaType: kind,
        title,
        year: int(r['ProductionYear']),
        tmdbId: int(ids['tmdb']),
        imdbId: imdbIdOf(ids['imdb']),
        tvdbId: int(ids['tvdb']),
      });
    }
    const total = int(body?.['TotalRecordCount']) ?? rows.length;
    if (rows.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= total) break;
  }
  return out;
};
