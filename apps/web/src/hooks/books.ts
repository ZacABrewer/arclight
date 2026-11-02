import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  AddComicSeriesRequest,
  AddEbookAuthorRequest,
  AddEbookRequest,
  BooksCommand,
  BooksFormatProfileInput,
  BooksGrabRequest,
  BooksKind,
  BooksLibraryAppInput,
  BooksRequestListQuery,
  BooksSettingsInput,
  BooksWantedQuery,
  ComicSeries,
  ComicSeriesDetails,
  CreateBooksRequest,
  EbookAuthor,
  EbookAuthorDetails,
  EbookSeriesDetails,
  UpdateComicSeriesRequest,
  UpdateEbookAuthorRequest,
} from '@arclight/shared';
import { booksApi } from '../api/books.js';
import { useToast } from '../components/toast.js';
import { patchQueries } from './library.js';
import { t } from '../i18n/index.js';

// Ebooks and comics. Library data sits under ['books', ...] so one invalidation of a branch
// refetches the lists, details and wanted rows together; catalogue lookups live under
// ['books', 'lookup'] and are left alone by library changes except after an add.

export const booksKeys = {
  all: ['books'] as const,
  overview: ['books', 'overview'] as const,
  settings: ['books', 'settings'] as const,
  authors: {
    all: ['books', 'authors'] as const,
    list: () => ['books', 'authors', 'list'] as const,
    detail: (id: number) => ['books', 'authors', 'detail', id] as const,
  },
  series: (id: number) => ['books', 'series', id] as const,
  comics: {
    all: ['books', 'comics'] as const,
    list: () => ['books', 'comics', 'list'] as const,
    detail: (id: number) => ['books', 'comics', 'detail', id] as const,
  },
  wanted: (query: BooksWantedQuery) => ['books', 'wanted', query] as const,
  wantedAll: ['books', 'wanted'] as const,
  calendar: (start: string, end: string, unmonitored: boolean) => ['books', 'calendar', start, end, unmonitored] as const,
  calendarAll: ['books', 'calendar'] as const,
  releases: (kind: BooksKind, id: number) => ['books', 'releases', kind, id] as const,
  profiles: ['books', 'profiles'] as const,
  libraryApps: ['books', 'libraryApps'] as const,
  lookup: (kind: 'authors' | 'ebooks' | 'comics', term: string) => ['books', 'lookup', kind, term] as const,
  lookupAll: ['books', 'lookup'] as const,
  requests: (query: BooksRequestListQuery) => ['books', 'requests', query] as const,
  requestsAll: ['books', 'requests'] as const,
  requestLookup: (kind: BooksKind, term: string) => ['books', 'requestLookup', kind, term] as const,
};

/** Everything an ebook change can touch (lists, details, series pages, wanted, calendar, overview). */
const EBOOK_KEYS: readonly QueryKey[] = [booksKeys.authors.all, ['books', 'series'], booksKeys.wantedAll, booksKeys.calendarAll, booksKeys.overview];
const COMIC_KEYS: readonly QueryKey[] = [booksKeys.comics.all, booksKeys.wantedAll, booksKeys.calendarAll, booksKeys.overview];

const LOOKUP_STALE_MS = 5 * 60_000;
/** How often a details page polls while a just-added entry still waits for its catalogue read. */
export const BOOKS_LOADING_POLL_MS = 3_000;

const valid = (id: number) => Number.isInteger(id) && id > 0;

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

export function useBooksOverview(enabled = true) {
  return useQuery({ queryKey: booksKeys.overview, queryFn: booksApi.overview, enabled, meta: { silent: true } });
}

export function useEbookAuthors(enabled = true) {
  return useQuery({ queryKey: booksKeys.authors.list(), queryFn: booksApi.authors.list, enabled });
}

/** True while an entry was never refreshed and has nothing in it yet (the add job is still reading). */
export function isAwaitingCatalogue(entry: { lastRefreshed: string | null } | undefined, childCount: number): boolean {
  return entry !== undefined && childCount === 0 && !entry.lastRefreshed;
}

export function useEbookAuthor(id: number) {
  return useQuery({
    queryKey: booksKeys.authors.detail(id),
    queryFn: () => booksApi.authors.get(id),
    enabled: valid(id),
    refetchInterval: (query) => (isAwaitingCatalogue(query.state.data, query.state.data?.books.length ?? 0) ? BOOKS_LOADING_POLL_MS : false),
  });
}

export function useEbookSeries(id: number) {
  return useQuery({ queryKey: booksKeys.series(id), queryFn: () => booksApi.series.get(id), enabled: valid(id) });
}

export function useComicSeriesList(enabled = true) {
  return useQuery({ queryKey: booksKeys.comics.list(), queryFn: booksApi.comics.list, enabled });
}

export function useComicSeries(id: number) {
  return useQuery({
    queryKey: booksKeys.comics.detail(id),
    queryFn: () => booksApi.comics.get(id),
    enabled: valid(id),
    refetchInterval: (query) => (isAwaitingCatalogue(query.state.data, query.state.data?.issues.length ?? 0) ? BOOKS_LOADING_POLL_MS : false),
  });
}

export function useBooksWanted(query: BooksWantedQuery, enabled = true) {
  return useQuery({ queryKey: booksKeys.wanted(query), queryFn: () => booksApi.wanted(query), enabled, placeholderData: keepPreviousData });
}

export function useBooksCalendar(start: string, end: string, unmonitored: boolean, enabled = true) {
  return useQuery({
    queryKey: booksKeys.calendar(start, end, unmonitored),
    queryFn: () => booksApi.calendar({ start, end, unmonitored }),
    enabled,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });
}

/** Interactive search: runs only when asked (enabled), never retried, results kept for a minute. */
export function useBooksReleases(kind: BooksKind, id: number, enabled: boolean) {
  return useQuery({
    queryKey: booksKeys.releases(kind, id),
    queryFn: () => booksApi.releases.list(kind, id),
    enabled: enabled && valid(id),
    retry: false,
    staleTime: 60_000,
    meta: { errorTitle: t('common.searchFailed') },
  });
}

export function useBooksFormatProfiles(enabled = true) {
  return useQuery({ queryKey: booksKeys.profiles, queryFn: booksApi.profiles.list, enabled, staleTime: 60_000 });
}

export function useBooksLibraryApps(enabled = true) {
  return useQuery({ queryKey: booksKeys.libraryApps, queryFn: booksApi.libraryApps.list, enabled });
}

export function useBooksSettings(enabled = true) {
  return useQuery({ queryKey: booksKeys.settings, queryFn: booksApi.settings.get, enabled });
}

function lookupOptions<T>(kind: 'authors' | 'ebooks' | 'comics', term: string, fn: (term: string) => Promise<T>) {
  const trimmed = term.trim();
  return {
    queryKey: booksKeys.lookup(kind, trimmed),
    queryFn: () => fn(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: LOOKUP_STALE_MS,
    retry: false,
    meta: { errorTitle: t('common.searchFailed') },
  };
}

/** Catalogue lookups for the add page; the term is already debounced by the caller. */
export function useEbookAuthorLookup(term: string) {
  return useQuery(lookupOptions('authors', term, booksApi.lookup.authors));
}

export function useEbookLookup(term: string) {
  return useQuery(lookupOptions('ebooks', term, booksApi.lookup.ebooks));
}

export function useComicLookup(term: string) {
  return useQuery(lookupOptions('comics', term, booksApi.lookup.comics));
}

export function useBooksRequests(query: BooksRequestListQuery, enabled = true) {
  return useQuery({ queryKey: booksKeys.requests(query), queryFn: () => booksApi.requests.list(query), enabled });
}

/** Portal-side lookups (any user allowed to request the kind). */
export function useBooksRequestEbookLookup(term: string, enabled = true) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: booksKeys.requestLookup('ebook', trimmed),
    queryFn: () => booksApi.requests.lookupEbooks(trimmed),
    enabled: enabled && trimmed.length >= 2,
    staleTime: LOOKUP_STALE_MS,
    retry: false,
    meta: { errorTitle: t('common.searchFailed') },
  });
}

export function useBooksRequestComicLookup(term: string, enabled = true) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: booksKeys.requestLookup('comic', trimmed),
    queryFn: () => booksApi.requests.lookupComics(trimmed),
    enabled: enabled && trimmed.length >= 2,
    staleTime: LOOKUP_STALE_MS,
    retry: false,
    meta: { errorTitle: t('common.searchFailed') },
  });
}

// ---------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------

function useInvalidate() {
  const qc = useQueryClient();
  return (keys: readonly QueryKey[]) => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

export function useAddEbookAuthor() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: AddEbookAuthorRequest) => booksApi.authors.add(body),
    meta: { silent: true },
    onSuccess: (author) => {
      qc.setQueryData<EbookAuthorDetails>(booksKeys.authors.detail(author.id), { ...author, books: [], series: [] });
      void invalidate([booksKeys.authors.list(), booksKeys.lookupAll, booksKeys.overview]);
    },
  });
}

export function useAddEbook() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: AddEbookRequest) => booksApi.ebooks.add(body),
    meta: { silent: true },
    onSuccess: () => void invalidate([...EBOOK_KEYS, booksKeys.lookupAll]),
  });
}

export function useAddComicSeries() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: AddComicSeriesRequest) => booksApi.comics.add(body),
    meta: { silent: true },
    onSuccess: (series) => {
      qc.setQueryData<ComicSeriesDetails>(booksKeys.comics.detail(series.id), { ...series, issues: [] });
      void invalidate([booksKeys.comics.list(), booksKeys.lookupAll, booksKeys.overview]);
    },
  });
}

export function useUpdateEbookAuthor() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateEbookAuthorRequest }) => booksApi.authors.update(id, body),
    meta: { errorTitle: t('books.hooks.couldNotSave') },
    onMutate: async ({ id, body }) => {
      if (body.monitored === undefined) return [];
      const monitored = body.monitored;
      const a = await patchQueries<EbookAuthorDetails>(qc, booksKeys.authors.detail(id), (x) => ({ ...x, monitored }));
      const b = await patchQueries<EbookAuthor[]>(qc, booksKeys.authors.list(), (list) => list.map((x) => (x.id === id ? { ...x, monitored } : x)));
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: (_d, _e, { id, body }) => {
      // A monitor option or monitored change reaches the books: refetch details and wanted too.
      const keys: QueryKey[] = [booksKeys.authors.list(), booksKeys.authors.detail(id)];
      if (body.monitorOption !== undefined || body.monitored !== undefined) keys.push(booksKeys.wantedAll, booksKeys.calendarAll);
      void invalidate(keys);
    },
  });
}

export function useUpdateComicSeries() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateComicSeriesRequest }) => booksApi.comics.update(id, body),
    meta: { errorTitle: t('books.hooks.couldNotSave') },
    onMutate: async ({ id, body }) => {
      if (body.monitored === undefined) return [];
      const monitored = body.monitored;
      const a = await patchQueries<ComicSeriesDetails>(qc, booksKeys.comics.detail(id), (x) => ({ ...x, monitored }));
      const b = await patchQueries<ComicSeries[]>(qc, booksKeys.comics.list(), (list) => list.map((x) => (x.id === id ? { ...x, monitored } : x)));
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: (_d, _e, { id, body }) => {
      const keys: QueryKey[] = [booksKeys.comics.list(), booksKeys.comics.detail(id)];
      if (body.monitorOption !== undefined || body.monitored !== undefined) keys.push(booksKeys.wantedAll, booksKeys.calendarAll);
      void invalidate(keys);
    },
  });
}

export function useDeleteEbookAuthor() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) => booksApi.authors.remove(id, deleteFiles),
    meta: { errorTitle: t('books.hooks.couldNotDelete') },
    onSuccess: (_d, { id }) => {
      qc.removeQueries({ queryKey: booksKeys.authors.detail(id) });
      void invalidate(EBOOK_KEYS);
    },
  });
}

export function useDeleteComicSeries() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) => booksApi.comics.remove(id, deleteFiles),
    meta: { errorTitle: t('books.hooks.couldNotDelete') },
    onSuccess: (_d, { id }) => {
      qc.removeQueries({ queryKey: booksKeys.comics.detail(id) });
      void invalidate(COMIC_KEYS);
    },
  });
}

export function useDeleteEbook() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) => booksApi.ebooks.remove(id, deleteFiles),
    meta: { errorTitle: t('books.hooks.couldNotDelete') },
    onSuccess: () => void invalidate(EBOOK_KEYS),
  });
}

export function useDeleteBooksFile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id }: { id: number; kind: BooksKind }) => booksApi.files.remove(id),
    meta: { errorTitle: t('books.hooks.couldNotDelete') },
    onSuccess: (_d, { kind }) => void invalidate(kind === 'ebook' ? EBOOK_KEYS : COMIC_KEYS),
  });
}

/** Monitor or unmonitor ebooks; optimistic on the author and series pages that hold them. */
export function useSetEbooksMonitored() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { ids: number[]; monitored: boolean }) => booksApi.ebooks.monitor(body),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onMutate: async ({ ids, monitored }) => {
      const set = new Set(ids);
      const a = await patchQueries<EbookAuthorDetails>(
        qc,
        booksKeys.authors.all,
        (x) => (Array.isArray((x as Partial<EbookAuthorDetails>).books) ? { ...x, books: x.books.map((b) => (set.has(b.id) ? { ...b, monitored } : b)) } : x),
        false,
      );
      const b = await patchQueries<EbookSeriesDetails>(qc, ['books', 'series'], (x) => ({ ...x, books: x.books.map((bk) => (set.has(bk.id) ? { ...bk, monitored } : bk)) }), false);
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => void invalidate(EBOOK_KEYS),
  });
}

export function useSetIssuesMonitored() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { ids: number[]; monitored: boolean }) => booksApi.issues.monitor(body),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onMutate: async ({ ids, monitored }) => {
      const set = new Set(ids);
      return patchQueries<ComicSeriesDetails>(
        qc,
        booksKeys.comics.all,
        (x) => (Array.isArray((x as Partial<ComicSeriesDetails>).issues) ? { ...x, issues: x.issues.map((i) => (set.has(i.id) ? { ...i, monitored } : i)) } : x),
        false,
      );
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => void invalidate(COMIC_KEYS),
  });
}

/** POST /books/command; toasts the server's message (the work runs in the background). */
export function useBooksCommand() {
  const toast = useToast();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BooksCommand) => booksApi.command(body),
    meta: { errorTitle: t('books.hooks.commandFailed') },
    onSuccess: (res, body) => {
      toast.push({ tone: 'ok', title: t('books.hooks.commandQueued'), message: res.message, durationMs: 4_000 });
      if (body.name === 'RefreshEbookAuthor') void invalidate([booksKeys.authors.all]);
      if (body.name === 'RefreshComicSeries') void invalidate([booksKeys.comics.all]);
    },
  });
}

export function useGrabBooksRelease() {
  const toast = useToast();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BooksGrabRequest) => booksApi.releases.grab(body),
    meta: { errorTitle: t('books.hooks.grabFailed') },
    onSuccess: (res) => {
      toast.push({ tone: 'ok', title: t('books.hooks.grabbed'), message: res.title, durationMs: 4_000 });
      void invalidate([booksKeys.wantedAll]);
    },
  });
}

export function useSaveBooksSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BooksSettingsInput) => booksApi.settings.update(body),
    meta: { errorTitle: t('hooks.settingsKeys.couldNotSave') },
    onSuccess: (data) => qc.setQueryData(booksKeys.settings, data),
  });
}

export function useSaveBooksFormatProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number | null; body: BooksFormatProfileInput }) =>
      id === null ? booksApi.profiles.add(body) : booksApi.profiles.update(id, body),
    meta: { errorTitle: t('hooks.settingsKeys.couldNotSave') },
    onSettled: () => void invalidate([booksKeys.profiles]),
  });
}

export function useDeleteBooksFormatProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => booksApi.profiles.remove(id),
    // 409 (still in use) is shown inline by the caller.
    meta: { silent: true },
    onSettled: () => void invalidate([booksKeys.profiles]),
  });
}

export function useSaveBooksLibraryApp() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number | null; body: BooksLibraryAppInput }) =>
      id === null ? booksApi.libraryApps.add(body) : booksApi.libraryApps.update(id, body),
    meta: { errorTitle: t('hooks.settingsKeys.couldNotSave') },
    onSettled: () => void invalidate([booksKeys.libraryApps]),
  });
}

export function useDeleteBooksLibraryApp() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => booksApi.libraryApps.remove(id),
    meta: { errorTitle: t('books.hooks.couldNotDelete') },
    onSettled: () => void invalidate([booksKeys.libraryApps]),
  });
}

export function useTestBooksLibraryApp() {
  return useMutation({
    mutationFn: (body: BooksLibraryAppInput & { id?: number | undefined }) => booksApi.libraryApps.test(body),
    meta: { silent: true },
  });
}

export function useCreateBooksRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateBooksRequest) => booksApi.requests.create(body),
    meta: { silent: true },
    onSettled: () => void invalidate([booksKeys.requestsAll, ['books', 'requestLookup']]),
  });
}

export function useBooksRequestAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, action, reason }: { id: number; action: 'approve' | 'decline' | 'remove'; reason?: string | undefined }): Promise<void> => {
      await (action === 'approve' ? booksApi.requests.approve(id) : action === 'decline' ? booksApi.requests.decline(id, reason) : booksApi.requests.remove(id));
    },
    meta: { errorTitle: t('books.hooks.requestActionFailed') },
    onSettled: (_d, _e, { action }) => {
      const keys: QueryKey[] = [booksKeys.requestsAll];
      if (action === 'approve') keys.push(booksKeys.authors.all, booksKeys.comics.all, booksKeys.overview);
      void invalidate(keys);
    },
  });
}
