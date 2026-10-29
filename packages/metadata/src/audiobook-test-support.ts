// Test helpers for the audiobook clients: recorded Audnexus, Audible and OpenLibrary fixtures
// and a router that serves them by host and path. Lives in src so it is typechecked, but is
// not exported from index.ts.

import { jsonResponse } from './test-support.js';

import anxBook from '../fixtures/audnexus/book.json' with { type: 'json' };
import anxBookSeries from '../fixtures/audnexus/book-series.json' with { type: 'json' };
import anxChapters from '../fixtures/audnexus/chapters.json' with { type: 'json' };
import anxAuthor from '../fixtures/audnexus/author.json' with { type: 'json' };
import anxSearchAuthors from '../fixtures/audnexus/search-authors.json' with { type: 'json' };
import anxError404 from '../fixtures/audnexus/error-404.json' with { type: 'json' };
import audSearch from '../fixtures/audible/search.json' with { type: 'json' };
import audSearchSeries from '../fixtures/audible/search-series.json' with { type: 'json' };
import audAuthorPage0 from '../fixtures/audible/author-page-0.json' with { type: 'json' };
import audAuthorPage1 from '../fixtures/audible/author-page-1.json' with { type: 'json' };
import audAuthorPage2 from '../fixtures/audible/author-page-2.json' with { type: 'json' };
import audEmpty from '../fixtures/audible/empty.json' with { type: 'json' };
import olSearchAuthors from '../fixtures/openlibrary/search-authors.json' with { type: 'json' };
import olAuthor from '../fixtures/openlibrary/author.json' with { type: 'json' };
import olWorksPage1 from '../fixtures/openlibrary/works-page-1.json' with { type: 'json' };
import olWorksPage2 from '../fixtures/openlibrary/works-page-2.json' with { type: 'json' };
import olWork from '../fixtures/openlibrary/work.json' with { type: 'json' };
import olEdition from '../fixtures/openlibrary/edition.json' with { type: 'json' };
import olSearchBooks from '../fixtures/openlibrary/search-books.json' with { type: 'json' };
import olSearchBooksOther from '../fixtures/openlibrary/search-books-other.json' with { type: 'json' };

export const audnexusFixtures = {
  book: anxBook,
  bookSeries: anxBookSeries,
  chapters: anxChapters,
  author: anxAuthor,
  searchAuthors: anxSearchAuthors,
  error404: anxError404,
};

export const audibleFixtures = {
  search: audSearch,
  searchSeries: audSearchSeries,
  authorPages: [audAuthorPage0, audAuthorPage1, audAuthorPage2],
  empty: audEmpty,
};

export const openLibraryFixtures = {
  searchAuthors: olSearchAuthors,
  author: olAuthor,
  worksPage1: olWorksPage1,
  worksPage2: olWorksPage2,
  work: olWork,
  edition: olEdition,
  searchBooks: olSearchBooks,
  searchBooksOther: olSearchBooksOther,
};

/** Ids that appear in the recorded fixtures (a well-known public audiobook and its author). */
export const AUDIOBOOK_IDS = {
  bookAsin: 'B08G9PRS1K',
  seriesBookAsin: 'B07341FZDC',
  seriesAsin: 'B01M1RDL6W',
  authorAsin: 'B00G0WYW92',
  authorName: 'Andy Weir',
  /** The audiobook's own ISBN, which OpenLibrary does not have. */
  audioIsbn: '9781603935470',
  /** The hardcover's ISBN, which OpenLibrary has. */
  printIsbn: '9780593135204',
  printIsbn10: '0593135202',
  olAuthor: 'OL7234434A',
  olWork: 'OL21745884W',
  olEdition: 'OL30036715M',
  missingAsin: 'B000000000',
} as const;

export const TEST_USER_AGENT = 'Arclight-test/0.0 ( https://example.invalid/arclight )';

function notFoundHtml(): Response {
  return new Response('<!DOCTYPE html><html><body>Not found</body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });
}

export function audnexusRoute(url: URL): Response {
  const path = url.pathname;
  switch (true) {
    case path === `/books/${AUDIOBOOK_IDS.bookAsin}`:
      return jsonResponse(anxBook);
    case path === `/books/${AUDIOBOOK_IDS.seriesBookAsin}`:
      return jsonResponse(anxBookSeries);
    case path === `/books/${AUDIOBOOK_IDS.bookAsin}/chapters`:
      return jsonResponse(anxChapters);
    case path === `/authors/${AUDIOBOOK_IDS.authorAsin}`:
      return jsonResponse(anxAuthor);
    case path === '/authors' && /weir/i.test(url.searchParams.get('name') ?? ''):
      return jsonResponse(anxSearchAuthors);
    case path === '/authors':
      return jsonResponse([]);
    default:
      return jsonResponse(anxError404, 404);
  }
}

export function audibleRoute(url: URL): Response {
  if (url.pathname !== '/1.0/catalog/products') return jsonResponse({ message: 'Not found' }, 404);
  const q = url.searchParams;
  const all = `${q.get('title') ?? ''} ${q.get('keywords') ?? ''}`;
  if (q.get('author') === AUDIOBOOK_IDS.authorName && !q.get('title')) {
    const page = audibleFixtures.authorPages[Number(q.get('page') ?? '0')];
    return jsonResponse(page ?? { ...audEmpty, total_results: 25 });
  }
  if (/project hail mary/i.test(all) && q.get('page') === '0') return jsonResponse(audSearch);
  if (/legion|bobiverse/i.test(all) && q.get('page') === '0') return jsonResponse(audSearchSeries);
  // Browse (Discover): no search terms, only an order.
  if (!q.get('author') && !all.trim() && q.get('products_sort_by') && q.get('page') === '0') {
    return jsonResponse(q.get('products_sort_by') === 'BestSellers' ? audSearch : audSearchSeries);
  }
  return jsonResponse(audEmpty);
}

export function openLibraryRoute(url: URL): Response {
  const path = url.pathname;
  const q = url.searchParams;
  switch (true) {
    case path === '/search/authors.json':
      return /weir/i.test(q.get('q') ?? '')
        ? jsonResponse(olSearchAuthors)
        : jsonResponse({ numFound: 0, start: 0, docs: [] });
    case path === `/authors/${AUDIOBOOK_IDS.olAuthor}.json`:
      return jsonResponse(olAuthor);
    case path === `/authors/${AUDIOBOOK_IDS.olAuthor}/works.json`:
      return jsonResponse(q.get('offset') === '10' ? olWorksPage2 : olWorksPage1);
    case path === `/works/${AUDIOBOOK_IDS.olWork}.json`:
      return jsonResponse(olWork);
    case path === `/books/${AUDIOBOOK_IDS.olEdition}.json`:
    case path === `/isbn/${AUDIOBOOK_IDS.printIsbn}.json`:
    case path === `/isbn/${AUDIOBOOK_IDS.printIsbn10}.json`:
      return jsonResponse(olEdition);
    case path === '/search.json': {
      const all = `${q.get('title') ?? ''} ${q.get('q') ?? ''}`;
      if (/hail mary/i.test(all)) return jsonResponse(olSearchBooks);
      if (/casey/i.test(all)) return jsonResponse(olSearchBooksOther);
      return jsonResponse({ numFound: 0, start: 0, docs: [] });
    }
    default:
      return notFoundHtml();
  }
}

/** Serves all three providers by host. */
export function audiobookRoute(url: URL): Response {
  if (url.hostname === 'api.audnex.us') return audnexusRoute(url);
  if (url.hostname.startsWith('api.audible.')) return audibleRoute(url);
  if (url.hostname === 'openlibrary.org') return openLibraryRoute(url);
  return jsonResponse({ error: `unexpected host ${url.hostname}` }, 404);
}
