import type { SearchRequest } from '@arclight/indexers';
import { isVariousArtistsName, stripEdition } from './audio-matcher.js';

// Search plans for albums and artists (docs/design/music-audiobooks.md 8.2). A plan is a list of
// steps; each step is an ordered list of indexer queries for some albums, and the service stops
// a step after the first query that brought an approved release for them:
//
//   album    t=music with artist + album (+ year), then q="{artist} {album}", then the album
//            title without edition brackets; Various Artists albums search by the album alone.
//   artist   q="{artist}" once (discographies and packs come back on it), then each wanted
//            album the artist query did not settle, as above.
//
// Indexers without t=music fall back to t=search with the same words in the indexers package.

export interface PlanAlbum {
  id: number;
  title: string;
  year: number | null;
}

export interface PlanArtist {
  id: number;
  name: string;
}

export interface SearchStep {
  /** Albums this step is for; the step ends once one of its queries brings an approved release for them. */
  albumIds: number[];
  requests: SearchRequest[];
}

function key(r: SearchRequest): string {
  return JSON.stringify(r);
}

function dedupe(requests: SearchRequest[]): SearchRequest[] {
  const seen = new Set<string>();
  return requests.filter((r) => {
    const k = key(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Queries for one album, most specific first. */
export function albumRequests(artist: PlanArtist, album: PlanAlbum): SearchRequest[] {
  const title = album.title.trim();
  const plain = stripEdition(title);
  if (isVariousArtistsName(artist.name)) {
    return dedupe([
      { kind: 'music', album: title, ...(album.year !== null ? { year: album.year } : {}) },
      { kind: 'music', query: title },
      { kind: 'music', query: plain },
    ]);
  }
  return dedupe([
    { kind: 'music', artist: artist.name, album: title, ...(album.year !== null ? { year: album.year } : {}) },
    { kind: 'music', query: `${artist.name} ${title}` },
    { kind: 'music', query: `${artist.name} ${plain}` },
  ]);
}

/** One step per album. */
export function albumSearchPlan(artist: PlanArtist, albums: readonly PlanAlbum[]): SearchStep[] {
  return albums.map((a) => ({ albumIds: [a.id], requests: albumRequests(artist, a) }));
}

/** The artist query once for every wanted album, then a step per album. */
export function artistSearchPlan(artist: PlanArtist, albums: readonly PlanAlbum[]): SearchStep[] {
  if (albums.length === 0) return [];
  const steps: SearchStep[] = [];
  // Various Artists has no useful artist query: every compilation would come back.
  if (!isVariousArtistsName(artist.name)) steps.push({ albumIds: albums.map((a) => a.id), requests: [{ kind: 'music', query: artist.name }] });
  return [...steps, ...albumSearchPlan(artist, albums)];
}
