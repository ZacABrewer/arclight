import type { MediaServerClient, MediaServerItem } from '@arclight/media-servers';

// Matching Arclight movies and series to a media server's items by provider id, shared by the
// collections sync and the tag sync. One listing per kind gives an index keyed
// `<kind>:tmdb:<id>`, `<kind>:tvdb:<id>` and `<kind>:imdb:<id>`; lookups try TMDB, then TVDB,
// then IMDb.

export type RemoteIndexKind = 'movie' | 'series';

/** Remote item id per provider id key. */
export type RemoteIndex = Map<string, string>;

/** The provider ids of an Arclight movie or series. */
export interface RemoteMatchIds {
  tmdbId: number;
  tvdbId?: number | null | undefined;
  imdbId?: string | null | undefined;
}

/** Lists every item of each kind (the client caches its listings) and indexes them by provider id. */
export async function buildRemoteIndex(client: Pick<MediaServerClient, 'listItems'>, kind: RemoteIndexKind | Iterable<RemoteIndexKind>): Promise<RemoteIndex> {
  const kinds = typeof kind === 'string' ? [kind] : [...new Set(kind)];
  const index: RemoteIndex = new Map();
  const add = (k: RemoteIndexKind, item: MediaServerItem) => {
    if (item.ids.tmdbId) index.set(`${k}:tmdb:${item.ids.tmdbId}`, item.id);
    if (item.ids.tvdbId) index.set(`${k}:tvdb:${item.ids.tvdbId}`, item.id);
    if (item.ids.imdbId) index.set(`${k}:imdb:${item.ids.imdbId.toLowerCase()}`, item.id);
  };
  for (const k of kinds) for (const item of await client.listItems(k)) add(k, item);
  return index;
}

/** The remote item id of a title: by TMDB id, else TVDB, else IMDb. */
export function remoteIdFor(index: RemoteIndex, kind: RemoteIndexKind, ids: RemoteMatchIds): string | undefined {
  return (
    index.get(`${kind}:tmdb:${ids.tmdbId}`) ??
    (ids.tvdbId ? index.get(`${kind}:tvdb:${ids.tvdbId}`) : undefined) ??
    (ids.imdbId ? index.get(`${kind}:imdb:${ids.imdbId.toLowerCase()}`) : undefined)
  );
}
