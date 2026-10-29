import {
  AudioFile,
  AudiobookMetadataSettingsResponse,
  Author,
  AuthorDetails,
  AuthorListResponse,
  AuthorSearchResponse,
  Book,
  BookDetails,
  BookListResponse,
  BookSearchResponse,
  BookSeriesDetails,
  BookSeriesListResponse,
  Job,
  WantedBooksPage,
  type AddAuthorRequestInput,
  type AddBookRequestInput,
  type AudibleRegion,
  type AudiobookCommand,
  type AudiobookMetadataSettingsUpdate,
  type BulkAuthorUpdateRequest,
  type BulkBookMonitorRequest,
  type UpdateAuthorRequest,
  type UpdateBookRequest,
  type WantedBooksQuery,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';
import type { DeleteMediaOptions } from './library.js';

// Audiobooks (docs/design/music-audiobooks.md, Wave 3). Paths mirror apps/api/src/modules/audiobooks;
// shapes come from packages/shared/src/audiobooks.ts. Calendar book items ride on the shared
// CalendarItem union (api/library.ts calendar.list).

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

/** GET /book/lookup: free text, title/author, or an exact ASIN / ISBN. */
export interface BookLookupInput {
  term?: string | undefined;
  title?: string | undefined;
  author?: string | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  region?: AudibleRegion | undefined;
}

/** Drop empty fields so the query string only carries what the user typed. */
function compact(input: BookLookupInput): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  return out;
}

export const audiobooksApi = {
  authors: {
    list: () => request('/author', AuthorListResponse, { query: { includeStatistics: true } }),
    get: (id: number) => request(`/author/${id}`, AuthorDetails),
    /** Answers with the author at once; books fill in through the background AuthorAdd job. */
    add: (body: AddAuthorRequestInput) => request('/author', Author, { method: 'POST', json: body }),
    update: (id: number, body: UpdateAuthorRequest) => request(`/author/${id}`, Author, { method: 'PUT', json: body }),
    bulk: (body: BulkAuthorUpdateRequest) => request('/author/editor', null, { method: 'PUT', json: body }),
    remove: (id: number, opts: DeleteMediaOptions = {}) =>
      request(`/author/${id}`, null, {
        method: 'DELETE',
        query: { deleteFiles: opts.deleteFiles ?? false, addExclusion: opts.addExclusion ?? false },
      }),
    /** Audible / Audnexus / OpenLibrary search; results already in the library carry `authorId`. */
    lookup: (term: string) => request('/author/lookup', AuthorSearchResponse, { query: { term } }),
  },
  books: {
    list: (authorId: number) => request('/book', BookListResponse, { query: { authorId } }),
    get: (id: number) => request(`/book/${id}`, BookDetails),
    /** POST /book: one book by ASIN or ISBN (its author is created when needed). */
    add: (body: AddBookRequestInput) => request('/book', Book, { method: 'POST', json: body }),
    update: (id: number, body: UpdateBookRequest) => request(`/book/${id}`, Book, { method: 'PUT', json: body }),
    monitor: (body: BulkBookMonitorRequest) => request('/book/monitor', null, { method: 'PUT', json: body }),
    remove: (id: number, opts: DeleteMediaOptions = {}) =>
      request(`/book/${id}`, null, {
        method: 'DELETE',
        query: { deleteFiles: opts.deleteFiles ?? false, addExclusion: opts.addExclusion ?? false },
      }),
    lookup: (input: BookLookupInput) => request('/book/lookup', BookSearchResponse, { query: compact(input) }),
  },
  series: {
    list: (authorId?: number) => request('/bookseries', BookSeriesListResponse, authorId ? { query: { authorId } } : undefined),
    get: (id: number) => request(`/bookseries/${id}`, BookSeriesDetails),
  },
  /** GET /audiofile?authorId=&bookId=: the shared audio_files rows of a book or author. */
  audioFiles: (query: { authorId?: number; bookId?: number }) => request('/audiofile', AudioFile.array(), { query: q(query) }),
  wanted: {
    missing: (query?: Partial<WantedBooksQuery>) => request('/wanted/missing/books', WantedBooksPage, { query: q(query) }),
    cutoff: (query?: Partial<WantedBooksQuery>) => request('/wanted/cutoff/books', WantedBooksPage, { query: q(query) }),
  },
  /** POST /command (shared AudiobookCommand): answered 202 with the started job. */
  command: (body: AudiobookCommand) => request('/command', Job, { method: 'POST', json: body }),
  settings: {
    metadata: {
      get: () => request('/settings/audiobookmetadata', AudiobookMetadataSettingsResponse),
      update: (body: AudiobookMetadataSettingsUpdate) =>
        request('/settings/audiobookmetadata', AudiobookMetadataSettingsResponse, { method: 'PUT', json: body }),
    },
  },
};
