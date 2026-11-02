// Maps the existing OpenLibrary client's clean types (../openlibrary/types.ts) into the book
// catalogue records. OpenLibrary is work-centric: search docs and works become `ol:` records,
// editions carry the ISBN-13 that makes a record `isbn:`.

import { maybe, normalizeIsbn, stripHtml, toIsbn13 } from '../audiobook-util.js';
import { openLibraryAuthorPhotoUrl, openLibraryCoverUrl } from '../openlibrary/covers.js';
import type {
  OlAuthor,
  OlAuthorSearchResult,
  OlBookSearchResult,
  OlEdition,
  OlWork,
} from '../openlibrary/types.js';
import type { BookAuthorRecord, BookRecord, BookSeriesRef } from './types.js';
import {
  bookLanguageCode,
  bookRecordKey,
  bookRecordKeys,
  genreList,
  isbn13List,
  parseSeriesString,
  partialDate,
} from './util.js';

/** OpenLibrary subjects include shelving noise; keep the first few that read like genres. */
const MAX_SUBJECTS = 8;
const SUBJECT_NOISE = /^(nyt:|new york times|accessible book|protected daisy|in library|lending library|overdrive)/i;

function subjects(values: readonly string[]): string[] {
  return genreList(values.filter((s) => !SUBJECT_NOISE.test(s) && !s.includes('=')).slice(0, MAX_SUBJECTS));
}

/** Language when every listed language is the same one; several languages read as unknown. */
function singleLanguage(values: readonly string[]): string | undefined {
  const codes = [...new Set(values.map(bookLanguageCode).filter((c): c is string => c !== undefined))];
  return codes.length === 1 ? codes[0] : undefined;
}

function seriesRefs(values: readonly string[]): BookSeriesRef[] {
  return values.map(parseSeriesString).filter((s): s is BookSeriesRef => s !== undefined);
}

export interface OpenLibraryAuthorRef {
  name: string;
  olid?: string;
}

function authorRefs(refs: readonly OpenLibraryAuthorRef[]): BookRecord['authors'] {
  return refs.map((a) => ({ name: a.name, ...maybe('key', a.olid ? `ol:${a.olid}` : undefined) }));
}

/** A work search result (`search.json`). */
export function bookFromOpenLibrarySearchDoc(doc: OlBookSearchResult): BookRecord {
  const base = { isbns: isbn13List(doc.isbns), olWorkId: doc.olid };
  return {
    key: bookRecordKey(base),
    keys: bookRecordKeys(base),
    title: doc.title,
    ...maybe('subtitle', doc.subtitle),
    authors: authorRefs(
      doc.authorNames.map((name, i) => ({ name, ...maybe('olid', doc.authorOlids[i]) })),
    ),
    ...base,
    ...maybe('publisher', doc.publishers[0]),
    ...maybe('language', singleLanguage(doc.languages)),
    ...maybe('releaseDate', partialDate(doc.firstPublishYear)),
    genres: subjects(doc.subjects),
    ...maybe('coverUrl', doc.coverId ? openLibraryCoverUrl({ id: doc.coverId }) : undefined),
    series: [],
    sources: ['openLibrary'],
  };
}

/**
 * A work record. Works name their authors by OLID only, so the caller passes the names it
 * knows (an author page knows its own author; `getWork` callers look them up).
 */
export function bookFromOpenLibraryWork(work: OlWork, authors: readonly OpenLibraryAuthorRef[] = []): BookRecord {
  const base = { isbns: [] as string[], olWorkId: work.olid };
  const coverId = work.coverIds[0];
  return {
    key: bookRecordKey(base),
    keys: bookRecordKeys(base),
    title: work.title,
    ...maybe('subtitle', work.subtitle),
    authors: authorRefs(authors),
    ...base,
    ...maybe('releaseDate', partialDate(work.firstPublishDate) ?? yearIn(work.firstPublishDate)),
    ...maybe('overview', stripHtml(work.description)),
    genres: subjects(work.subjects),
    ...maybe('coverUrl', coverId ? openLibraryCoverUrl({ id: coverId }) : undefined),
    series: seriesRefs(work.series),
    sources: ['openLibrary'],
  };
}

function yearIn(value: string | undefined): string | undefined {
  return value ? /\b(\d{4})\b/.exec(value)?.[1] : undefined;
}

/**
 * An edition (`/isbn/…`, `/books/…`), optionally with its work for the description, subjects
 * and series. `lookedUpIsbn` pins the ISBN-13 the caller asked for.
 */
export function bookFromOpenLibraryEdition(
  edition: OlEdition,
  opts: { work?: OlWork; authors?: readonly OpenLibraryAuthorRef[]; lookedUpIsbn?: string } = {},
): BookRecord {
  const { work } = opts;
  const isbns = isbn13List([opts.lookedUpIsbn, ...edition.isbn13, ...edition.isbn10]);
  const isbn13 = toIsbn13(normalizeIsbn(opts.lookedUpIsbn)) ?? isbns[0];
  const olWorkId = edition.workOlids[0] ?? work?.olid;
  const base = { isbns, ...maybe('isbn13', isbn13), ...maybe('olWorkId', olWorkId) };
  const coverId = edition.coverIds[0] ?? work?.coverIds[0];
  const series = seriesRefs(edition.series.length > 0 ? edition.series : (work?.series ?? []));
  return {
    key: bookRecordKey(base),
    keys: bookRecordKeys(base),
    title: work?.title ?? edition.title,
    ...maybe('subtitle', edition.subtitle ?? work?.subtitle),
    authors: authorRefs(opts.authors ?? []),
    ...base,
    ...maybe('publisher', edition.publishers[0]),
    ...maybe('language', singleLanguage(edition.languages)),
    ...maybe('releaseDate', edition.releaseDate),
    ...maybe('pageCount', edition.pages),
    ...maybe('overview', stripHtml(work?.description ?? edition.description)),
    genres: subjects(work?.subjects ?? []),
    ...maybe('coverUrl', coverId ? openLibraryCoverUrl({ id: coverId }) : undefined),
    series,
    sources: ['openLibrary'],
  };
}

export function authorFromOpenLibrary(author: OlAuthor): BookAuthorRecord {
  const photoId = author.photoIds[0];
  return {
    key: `ol:${author.olid}`,
    keys: [`ol:${author.olid}`],
    name: author.name,
    ...maybe('overview', stripHtml(author.bio)),
    ...maybe('imageUrl', photoId ? openLibraryAuthorPhotoUrl({ id: photoId }) : undefined),
    olAuthorId: author.olid,
    sources: ['openLibrary'],
  };
}

export function authorFromOpenLibrarySearch(result: OlAuthorSearchResult): BookAuthorRecord {
  return {
    key: `ol:${result.olid}`,
    keys: [`ol:${result.olid}`],
    name: result.name,
    imageUrl: openLibraryAuthorPhotoUrl({ olid: result.olid }),
    ...maybe('topWork', result.topWork),
    ...maybe('workCount', result.workCount > 0 ? result.workCount : undefined),
    olAuthorId: result.olid,
    sources: ['openLibrary'],
  };
}
