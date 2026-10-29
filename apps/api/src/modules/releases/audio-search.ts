import type { SearchRequest } from '@arclight/indexers';
import { isVariousArtistsName, stripEdition } from './audio-matcher.js';

// Search plans for albums and artists, books and authors (docs/design/music-audiobooks.md 8.2). A plan is a list of
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

// ---- audiobooks ---------------------------------------------------------------------
//
//   book     t=book with author + title, then q="{author} {title}", then q="{title}" when the
//            title has three or more significant words (short titles alone match too much),
//            then q="{asin}" when the book has one.
//   author   q="{author}" once (series packs come back on it), then each wanted book the author
//            query did not settle, as above.
//
// Indexers without t=book fall back to t=search with the same words in the indexers package.

export interface PlanBook {
  id: number;
  title: string;
  asin: string | null;
}

export interface PlanAuthor {
  id: number;
  name: string;
}

export interface BookSearchStep {
  /** Books this step is for; the step ends once one of its queries brings an approved release for them. */
  bookIds: number[];
  requests: SearchRequest[];
}

const MINOR_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from', 'der', 'die', 'das', 'le', 'la', 'les', 'el', 'de']);

/** Words of a title that carry meaning (articles, short prepositions and conjunctions left out). */
export function significantWords(title: string): number {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 0 && !MINOR_WORDS.has(w)).length;
}

/** Queries for one book, most specific first. */
export function bookRequests(author: PlanAuthor, book: PlanBook): SearchRequest[] {
  const title = book.title.trim();
  const requests: SearchRequest[] = [
    { kind: 'book', author: author.name, title },
    { kind: 'book', query: `${author.name} ${title}` },
  ];
  if (significantWords(title) >= 3) requests.push({ kind: 'book', query: title });
  if (book.asin) requests.push({ kind: 'book', query: book.asin });
  return dedupe(requests);
}

/** One step per book. */
export function bookSearchPlan(author: PlanAuthor, books: readonly PlanBook[]): BookSearchStep[] {
  return books.map((b) => ({ bookIds: [b.id], requests: bookRequests(author, b) }));
}

/** The author query once for every wanted book, then a step per book. */
export function authorSearchPlan(author: PlanAuthor, books: readonly PlanBook[]): BookSearchStep[] {
  if (books.length === 0) return [];
  return [{ bookIds: books.map((b) => b.id), requests: [{ kind: 'book', query: author.name }] }, ...bookSearchPlan(author, books)];
}
