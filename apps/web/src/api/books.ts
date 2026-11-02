import {
  BooksCalendarEntry,
  BooksCommandResult,
  BooksFormatProfile,
  BooksGrabResult,
  BooksLibraryApp,
  BooksLibraryAppTestResult,
  BooksOverview,
  BooksRelease,
  BooksRequest,
  BooksRequestList,
  BooksSettings,
  BooksWantedPage,
  ComicLookupResult,
  ComicSeries,
  ComicSeriesDetails,
  Ebook,
  EbookAuthor,
  EbookAuthorDetails,
  EbookAuthorLookupResult,
  EbookLookupResult,
  EbookSeriesDetails,
  type AddComicSeriesRequest,
  type AddEbookAuthorRequest,
  type AddEbookRequest,
  type BooksCalendarQuery,
  type BooksCommand,
  type BooksFormatProfileInput,
  type BooksGrabRequest,
  type BooksKind,
  type BooksLibraryAppInput,
  type BooksRequestListQuery,
  type BooksSettingsInput,
  type BooksWantedQuery,
  type CreateBooksRequest,
  type SetMonitoredRequest,
  type UpdateComicSeriesRequest,
  type UpdateEbookAuthorRequest,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Ebooks and comics (packages/shared/src/books.ts). Every path sits under /books; the module is
// gated by FeatureSettings.books on the web side only (the routes always answer).

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;
const del = (deleteFiles: boolean) => ({ method: 'DELETE' as const, query: { deleteFiles } });

export const booksApi = {
  overview: () => request('/books/overview', BooksOverview),
  settings: {
    get: () => request('/books/settings', BooksSettings),
    update: (body: BooksSettingsInput) => request('/books/settings', BooksSettings, { method: 'PUT', json: body }),
  },
  lookup: {
    authors: (term: string) => request('/books/lookup/authors', EbookAuthorLookupResult, { query: { term } }),
    ebooks: (term: string) => request('/books/lookup/ebooks', EbookLookupResult, { query: { term } }),
    comics: (term: string) => request('/books/lookup/comics', ComicLookupResult, { query: { term } }),
  },
  authors: {
    list: () => request('/books/authors', EbookAuthor.array()),
    get: (id: number) => request(`/books/authors/${id}`, EbookAuthorDetails),
    add: (body: AddEbookAuthorRequest) => request('/books/authors', EbookAuthor, { method: 'POST', json: body }),
    update: (id: number, body: UpdateEbookAuthorRequest) =>
      request(`/books/authors/${id}`, EbookAuthor, { method: 'PUT', json: body }),
    remove: (id: number, deleteFiles = false) => request(`/books/authors/${id}`, null, del(deleteFiles)),
  },
  ebooks: {
    get: (id: number) => request(`/books/ebooks/${id}`, Ebook),
    /** Adds one book; its author is created when new. */
    add: (body: AddEbookRequest) => request('/books/ebooks', Ebook, { method: 'POST', json: body }),
    remove: (id: number, deleteFiles = false) => request(`/books/ebooks/${id}`, null, del(deleteFiles)),
    monitor: (body: SetMonitoredRequest) => request('/books/ebooks/monitor', null, { method: 'PUT', json: body }),
  },
  series: {
    get: (id: number) => request(`/books/series/${id}`, EbookSeriesDetails),
  },
  comics: {
    list: () => request('/books/comics', ComicSeries.array()),
    get: (id: number) => request(`/books/comics/${id}`, ComicSeriesDetails),
    add: (body: AddComicSeriesRequest) => request('/books/comics', ComicSeries, { method: 'POST', json: body }),
    update: (id: number, body: UpdateComicSeriesRequest) =>
      request(`/books/comics/${id}`, ComicSeries, { method: 'PUT', json: body }),
    remove: (id: number, deleteFiles = false) => request(`/books/comics/${id}`, null, del(deleteFiles)),
  },
  issues: {
    monitor: (body: SetMonitoredRequest) => request('/books/issues/monitor', null, { method: 'PUT', json: body }),
  },
  files: {
    remove: (id: number) => request(`/books/files/${id}`, null, { method: 'DELETE' }),
  },
  wanted: (query: BooksWantedQuery) => request('/books/wanted', BooksWantedPage, { query: q(query) }),
  calendar: (query: BooksCalendarQuery) => request('/books/calendar', BooksCalendarEntry.array(), { query: q(query) }),
  releases: {
    list: (kind: BooksKind, id: number) => request('/books/releases', BooksRelease.array(), { query: { kind, id } }),
    grab: (body: BooksGrabRequest) => request('/books/releases/grab', BooksGrabResult, { method: 'POST', json: body }),
  },
  command: (body: BooksCommand) => request('/books/command', BooksCommandResult, { method: 'POST', json: body }),
  profiles: {
    list: () => request('/books/profiles', BooksFormatProfile.array()),
    add: (body: BooksFormatProfileInput) => request('/books/profiles', BooksFormatProfile, { method: 'POST', json: body }),
    update: (id: number, body: BooksFormatProfileInput) =>
      request(`/books/profiles/${id}`, BooksFormatProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/books/profiles/${id}`, null, { method: 'DELETE' }),
  },
  libraryApps: {
    list: () => request('/books/library-apps', BooksLibraryApp.array()),
    add: (body: BooksLibraryAppInput) => request('/books/library-apps', BooksLibraryApp, { method: 'POST', json: body }),
    update: (id: number, body: BooksLibraryAppInput) =>
      request(`/books/library-apps/${id}`, BooksLibraryApp, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/books/library-apps/${id}`, null, { method: 'DELETE' }),
    /** `id` lets the server reuse the stored (masked) secrets of a saved app. */
    test: (body: BooksLibraryAppInput & { id?: number | undefined }) =>
      request('/books/library-apps/test', BooksLibraryAppTestResult, { method: 'POST', json: body }),
  },
  requests: {
    list: (query: BooksRequestListQuery = {}) => request('/books/requests', BooksRequestList, { query: q(query) }),
    create: (body: CreateBooksRequest) => request('/books/requests', BooksRequest, { method: 'POST', json: body }),
    approve: (id: number) => request(`/books/requests/${id}/approve`, BooksRequest, { method: 'POST', json: {} }),
    decline: (id: number, reason?: string) =>
      request(`/books/requests/${id}/decline`, BooksRequest, { method: 'POST', json: reason ? { reason } : {} }),
    remove: (id: number) => request(`/books/requests/${id}`, null, { method: 'DELETE' }),
    /** Portal-side catalogue search (any user who may request books). */
    lookupEbooks: (term: string) => request('/books/requests/lookup/ebooks', EbookLookupResult, { query: { term } }),
    lookupComics: (term: string) => request('/books/requests/lookup/comics', ComicLookupResult, { query: { term } }),
  },
};
