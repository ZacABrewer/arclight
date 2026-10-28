// Source records → unified catalog records, plus cross-source de-duplication and series
// grouping. Pure functions.

import type { AudibleProduct } from '../audible/types.js';
import type { AnxAuthor, AnxBook, AnxSeriesRef } from '../audnexus/types.js';
import { openLibraryCoverUrl } from '../openlibrary/covers.js';
import type {
  OlAuthor,
  OlAuthorSearchResult,
  OlBookSearchResult,
  OlEdition,
  OlWork,
} from '../openlibrary/types.js';
import { parseOlDate } from '../openlibrary/map.js';
import {
  maybe,
  normalizePersonName,
  normalizeTitle,
  positionNumber,
  toIsbn13,
  uniqueStrings,
} from '../audiobook-util.js';
import type {
  CatalogAuthor,
  CatalogBook,
  CatalogPersonRef,
  CatalogSeries,
  CatalogSeriesEntry,
  CatalogSeriesRef,
  CatalogSource,
} from './types.js';

function olCovers(coverIds: readonly number[], coverId?: number): CatalogBook['images'] {
  const id = coverId ?? coverIds[0];
  if (id === undefined) return {};
  return {
    cover: openLibraryCoverUrl({ id }, { size: 'L' }),
    thumbnail: openLibraryCoverUrl({ id }, { size: 'M' }),
  };
}

function isbnList(values: Iterable<string | undefined>): string[] {
  return uniqueStrings([...values].map((v) => toIsbn13(v)));
}

function seriesRef(s: AnxSeriesRef): CatalogSeriesRef {
  return {
    name: s.name,
    ...maybe('asin', s.asin),
    ...maybe('position', s.position),
    ...maybe('positionNumber', s.positionNumber),
  };
}

export function bookFromAudnexus(book: AnxBook): CatalogBook {
  const isbn = toIsbn13(book.isbn);
  return {
    asin: book.asin,
    ...maybe('isbn', isbn),
    isbns: isbnList([isbn]),
    title: book.title,
    ...maybe('subtitle', book.subtitle),
    authors: book.authors.map((a) => ({ name: a.name, ...maybe('asin', a.asin) })),
    narrators: [...book.narrators],
    series: [book.seriesPrimary, book.seriesSecondary]
      .filter((s): s is AnxSeriesRef => s !== undefined)
      .map(seriesRef),
    ...maybe('runtimeMinutes', book.runtimeMinutes),
    ...maybe('formatType', book.formatType),
    ...maybe('language', book.language),
    ...maybe('releaseDate', book.releaseDate),
    ...maybe('publisher', book.publisher),
    ...maybe('overview', book.overview),
    genres: uniqueStrings(book.genres.map((g) => g.name)),
    images: book.image ? { cover: book.image } : {},
    ...maybe('rating', book.rating),
    isAdult: book.isAdult,
    region: book.region,
    sources: ['audnexus'],
  };
}

export function bookFromAudible(product: AudibleProduct): CatalogBook {
  const thumbnail = product.images['500'];
  return {
    asin: product.asin,
    isbns: [],
    title: product.title,
    ...maybe('subtitle', product.subtitle),
    authors: product.authors.map((a) => ({ name: a.name, ...maybe('asin', a.asin) })),
    narrators: [...product.narrators],
    series: product.series.map(seriesRef),
    ...maybe('runtimeMinutes', product.runtimeMinutes),
    ...maybe('formatType', product.formatType),
    ...maybe('language', product.language),
    ...maybe('releaseDate', product.releaseDate),
    ...maybe('publisher', product.publisher),
    ...maybe('overview', product.overview),
    genres: [...product.genres],
    images: {
      ...maybe('cover', product.image),
      ...maybe('thumbnail', thumbnail !== product.image ? thumbnail : undefined),
    },
    ...maybe('rating', product.rating?.average),
    isAdult: product.isAdult,
    region: product.region,
    sources: ['audible'],
  };
}

export function bookFromOpenLibrarySearch(doc: OlBookSearchResult): CatalogBook {
  const isbns = isbnList(doc.isbns);
  return {
    ...maybe('asin', doc.asins.length === 1 ? doc.asins[0] : undefined),
    isbns,
    olWorkId: doc.olid,
    title: doc.title,
    ...maybe('subtitle', doc.subtitle),
    authors: doc.authorNames.map((name, i) => ({ name, ...maybe('olid', doc.authorOlids[i]) })),
    narrators: [],
    series: [],
    ...maybe('language', doc.languages.length === 1 ? doc.languages[0] : undefined),
    ...maybe('releaseDate', doc.firstPublishYear ? String(doc.firstPublishYear) : undefined),
    ...maybe('publisher', doc.publishers[0]),
    genres: doc.subjects.slice(0, 10),
    images: olCovers([], doc.coverId),
    sources: ['openlibrary'],
  };
}

/** A work (optionally with the edition that led to it) as a catalog book. */
export function bookFromOpenLibraryWork(
  work: OlWork | undefined,
  edition: OlEdition | undefined,
  authors: readonly CatalogPersonRef[] = [],
): CatalogBook {
  const isbns = isbnList([...(edition?.isbn13 ?? []), ...(edition?.isbn10 ?? [])]);
  const title = work?.title ?? edition?.title ?? 'Untitled';
  const subtitle = work?.subtitle ?? edition?.subtitle;
  const workId = work?.olid ?? edition?.workOlids[0];
  const series = uniqueStrings([...(work?.series ?? []), ...(edition?.series ?? [])]).map(
    parseOlSeries,
  );
  return {
    ...maybe('asin', edition?.asins.length === 1 ? edition.asins[0] : undefined),
    ...maybe('isbn', isbns[0]),
    isbns,
    ...maybe('olWorkId', workId),
    ...maybe('olEditionId', edition?.olid),
    title,
    ...maybe('subtitle', subtitle),
    authors:
      authors.length > 0
        ? [...authors]
        : (work?.authorOlids ?? edition?.authorOlids ?? []).map((olid) => ({ name: olid, olid })),
    narrators: [],
    series,
    ...maybe('language', edition?.languages.length === 1 ? edition.languages[0] : undefined),
    ...maybe('releaseDate', edition?.releaseDate ?? parseOlDate(work?.firstPublishDate)),
    ...maybe('publisher', edition?.publishers[0]),
    ...maybe('overview', work?.description ?? edition?.description),
    genres: (work?.subjects ?? []).filter((s) => !s.includes(':')).slice(0, 10),
    images: olCovers([...(edition?.coverIds ?? []), ...(work?.coverIds ?? [])]),
    sources: ['openlibrary'],
  };
}

/** "Bobiverse ; 3", "Bobiverse, #3", "Bobiverse (3)" → name + position. */
export function parseOlSeries(value: string): CatalogSeriesRef {
  const match = /^(.*?)(?:\s*[;,(#]\s*(?:#|book|vol\.?|volume)?\s*(\d+(?:\.\d+)?)\)?)$/i.exec(value);
  const name = match?.[1]?.trim();
  if (match && name) {
    return { name, position: match[2]!, ...maybe('positionNumber', positionNumber(match[2])) };
  }
  return { name: value.trim() };
}

export function authorFromAudnexus(author: AnxAuthor): CatalogAuthor {
  return {
    name: author.name,
    asin: author.asin,
    ...maybe('description', author.description),
    ...maybe('image', author.image),
    genres: uniqueStrings(author.genres.filter((g) => g.type === 'genre').map((g) => g.name)),
    similar: author.similar.map((s) => ({ name: s.name, ...maybe('asin', s.asin) })),
    region: author.region,
    sources: ['audnexus'],
  };
}

export function authorFromOpenLibrary(
  author: OlAuthor,
  photoUrl: ((id: number) => string) | undefined,
): CatalogAuthor {
  const photo = author.photoIds[0];
  return {
    name: author.name,
    ...maybe('asin', author.amazonAsin),
    olid: author.olid,
    ...maybe('description', author.bio),
    ...maybe('image', photo !== undefined && photoUrl ? photoUrl(photo) : undefined),
    genres: [],
    similar: [],
    ...maybe('birthDate', author.birthDate),
    ...maybe('deathDate', author.deathDate),
    sources: ['openlibrary'],
  };
}

export function authorFromOpenLibrarySearch(result: OlAuthorSearchResult): CatalogAuthor {
  return {
    name: result.name,
    olid: result.olid,
    genres: result.topSubjects.slice(0, 5),
    similar: [],
    ...maybe('birthDate', result.birthDate),
    ...maybe('deathDate', result.deathDate),
    sources: ['openlibrary'],
  };
}

// ---------------------------------------------------------------------------
// Merging

function unionSources(a: readonly CatalogSource[], b: readonly CatalogSource[]): CatalogSource[] {
  return [...new Set([...a, ...b])];
}

function isPlaceholder(person: CatalogPersonRef): boolean {
  return person.olid !== undefined && person.name === person.olid;
}

function mergePeople(
  a: readonly CatalogPersonRef[],
  b: readonly CatalogPersonRef[],
): CatalogPersonRef[] {
  const out = a.map((p) => ({ ...p }));
  for (const person of b) {
    const key = normalizePersonName(person.name);
    const existing = out.find(
      (p) =>
        (person.asin !== undefined && p.asin === person.asin) ||
        (person.olid !== undefined && p.olid === person.olid) ||
        normalizePersonName(p.name) === key,
    );
    if (!existing) {
      // OpenLibrary editions may only know the author id ("name" is the OLID). With one
      // author on each side it is the same person; otherwise an id-only credit is dropped
      // rather than shown as a name.
      if (isPlaceholder(person) && a.length > 0) {
        const only = out.length === 1 ? out[0] : undefined;
        if (only && !only.olid && b.filter(isPlaceholder).length === 1) only.olid = person.olid!;
        continue;
      }
      out.push({ ...person });
      continue;
    }
    if (!existing.asin && person.asin) existing.asin = person.asin;
    if (!existing.olid && person.olid) existing.olid = person.olid;
    if (isPlaceholder(existing) && !isPlaceholder(person)) existing.name = person.name;
  }
  return out;
}

function mergeSeries(
  a: readonly CatalogSeriesRef[],
  b: readonly CatalogSeriesRef[],
): CatalogSeriesRef[] {
  const out = a.map((s) => ({ ...s }));
  for (const series of b) {
    const key = normalizeTitle(series.name);
    const existing = out.find(
      (s) => (series.asin !== undefined && s.asin === series.asin) || normalizeTitle(s.name) === key,
    );
    if (!existing) {
      out.push({ ...series });
      continue;
    }
    if (!existing.asin && series.asin) existing.asin = series.asin;
    if (existing.position === undefined && series.position !== undefined) {
      existing.position = series.position;
      if (series.positionNumber !== undefined) existing.positionNumber = series.positionNumber;
    }
  }
  return out;
}

/**
 * Fills the gaps of `primary` from `secondary`. Scalars keep the primary value; lists are
 * unioned. Order sources so the most authoritative comes first (Audnexus, Audible, OpenLibrary).
 */
export function mergeBooks(primary: CatalogBook, secondary: CatalogBook): CatalogBook {
  const merged: CatalogBook = {
    ...secondary,
    ...stripUndefined(primary),
    isbns: uniqueStrings([...primary.isbns, ...secondary.isbns]),
    authors: mergePeople(primary.authors, secondary.authors),
    narrators: uniqueStrings([...primary.narrators, ...secondary.narrators]),
    series: mergeSeries(primary.series, secondary.series),
    genres: uniqueStrings([...primary.genres, ...secondary.genres]),
    images: { ...secondary.images, ...stripUndefined(primary.images) },
    sources: unionSources(primary.sources, secondary.sources),
  };
  if (!merged.isbn && merged.isbns[0]) merged.isbn = merged.isbns[0];
  return merged;
}

export function mergeAuthors(primary: CatalogAuthor, secondary: CatalogAuthor): CatalogAuthor {
  return {
    ...secondary,
    ...stripUndefined(primary),
    genres: uniqueStrings([...primary.genres, ...secondary.genres]),
    similar: mergePeople(primary.similar, secondary.similar),
    sources: unionSources(primary.sources, secondary.sources),
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// De-duplication

/** Normalised "title|first author" key, or undefined when either is missing. */
export function titleAuthorKey(book: CatalogBook): string | undefined {
  const title = normalizeTitle(book.title);
  const author = book.authors[0] ? normalizePersonName(book.authors[0].name) : '';
  return title && author ? `${title}|${author}` : undefined;
}

/**
 * Collapses the same book seen in several sources, matching by ASIN, then any shared ISBN,
 * then normalised title + first author. Two records with different ASINs are different
 * Audible products (other narrator, edition or language) and are never merged. Earlier
 * records win on conflicting fields.
 */
export function dedupeBooks(books: readonly CatalogBook[]): CatalogBook[] {
  const out: CatalogBook[] = [];
  const compatible = (a: CatalogBook, b: CatalogBook): boolean =>
    a.asin === undefined || b.asin === undefined || a.asin === b.asin;
  for (const book of books) {
    let index = book.asin ? out.findIndex((o) => o.asin === book.asin) : -1;
    if (index < 0 && book.isbns.length > 0) {
      const isbns = new Set(book.isbns);
      index = out.findIndex((o) => compatible(o, book) && o.isbns.some((i) => isbns.has(i)));
    }
    if (index < 0) {
      const key = titleAuthorKey(book);
      if (key) index = out.findIndex((o) => compatible(o, book) && titleAuthorKey(o) === key);
    }
    if (index < 0) out.push(book);
    else out[index] = mergeBooks(out[index]!, book);
  }
  return out;
}

/** Authors de-duplicated by ASIN, OLID, then normalised name. */
export function dedupeAuthors(authors: readonly CatalogAuthor[]): CatalogAuthor[] {
  const out: CatalogAuthor[] = [];
  for (const author of authors) {
    const key = normalizePersonName(author.name);
    const index = out.findIndex(
      (o) =>
        (author.asin !== undefined && o.asin === author.asin) ||
        (author.olid !== undefined && o.olid === author.olid) ||
        ((o.asin === undefined || author.asin === undefined) && normalizePersonName(o.name) === key),
    );
    if (index < 0) out.push(author);
    else out[index] = mergeAuthors(out[index]!, author);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Series

/** Numeric position, or the start of a range ("1-6" → 1); unnumbered sorts last. */
function sortPosition(entry: CatalogSeriesEntry): number {
  if (entry.positionNumber !== undefined) return entry.positionNumber;
  const lead = /^\s*(\d+(?:\.\d+)?)/.exec(entry.position ?? '');
  return lead ? Number(lead[1]) : Number.POSITIVE_INFINITY;
}

function byPosition(a: CatalogSeriesEntry, b: CatalogSeriesEntry): number {
  const pa = sortPosition(a);
  const pb = sortPosition(b);
  if (pa !== pb) return pa - pb;
  const da = a.book.releaseDate ?? '9999';
  const db = b.book.releaseDate ?? '9999';
  return da.localeCompare(db) || a.book.title.localeCompare(b.book.title);
}

/** Groups books into their series (a book may sit in two), ordered by position. */
export function groupSeries(books: readonly CatalogBook[]): CatalogSeries[] {
  const groups = new Map<string, CatalogSeries>();
  for (const book of books) {
    for (const ref of book.series) {
      const key = ref.asin ?? `name:${normalizeTitle(ref.name)}`;
      let group = groups.get(key);
      if (!group) {
        group = { name: ref.name, ...maybe('asin', ref.asin), books: [] };
        groups.set(key, group);
      }
      group.books.push({
        ...maybe('position', ref.position),
        ...maybe('positionNumber', ref.positionNumber),
        book,
      });
    }
  }
  const out = [...groups.values()];
  for (const group of out) group.books.sort(byPosition);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
