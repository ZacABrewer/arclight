import type { BookLookupInput } from '../api/audiobooks.js';

// Query keys for the audiobook pages. Everything library-side lives under ['audiobook'] so one
// invalidation (live.ts: a `library`/`import` event with mediaType 'audiobook', or a finished
// author job) refetches authors, books, series and files together. Settings-side keys sit under
// ['settings'] like every other settings page.
export const audiobookKeys = {
  all: ['audiobook'] as const,
  authors: {
    all: ['audiobook', 'author'] as const,
    list: () => ['audiobook', 'author', 'list'] as const,
    detail: (id: number) => ['audiobook', 'author', 'detail', id] as const,
  },
  books: {
    all: ['audiobook', 'book'] as const,
    detail: (id: number) => ['audiobook', 'book', 'detail', id] as const,
    /** One author's books (activity rows resolve book titles through it). */
    list: (authorId: number) => ['audiobook', 'book', 'list', authorId] as const,
  },
  series: {
    list: () => ['audiobook', 'series', 'list'] as const,
    detail: (id: number) => ['audiobook', 'series', 'detail', id] as const,
  },
  files: (query: { authorId?: number; bookId?: number }) => ['audiobook', 'files', query] as const,
  /** Catalogue search results: snapshots, kept out of ['audiobook'] so library events leave them alone. */
  authorLookup: (term: string) => ['audiobookLookup', 'author', term] as const,
  bookLookup: (input: BookLookupInput) => ['audiobookLookup', 'book', input] as const,
  wanted: (mode: 'missing' | 'cutoff', page: number, pageSize: number) => ['wanted', mode, 'books', page, pageSize] as const,
  metadata: ['settings', 'audiobookmetadata'] as const,
  qualityProfiles: ['settings', 'qualityprofiles', 'domain', 'audiobook'] as const,
};

/** Job names whose end changes authors, books or files (AuthorAdd, RefreshAuthor(s), RescanAuthor, BookAdd). */
export function isAudiobookJob(name: string): boolean {
  return /author|book/i.test(name);
}
