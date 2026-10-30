import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AddAuthorRequestInput,
  AddBookRequestInput,
  AudiobookMetadataSettingsUpdate,
  Author,
  AuthorDetails,
  Book,
  BookDetails,
  BookSeriesDetails,
  BulkAuthorUpdateRequest,
  UpdateAuthorRequest,
  WantedReleaseFilter,
} from '@arclight/shared';
import { audiobooksApi, type BookLookupInput } from '../api/audiobooks.js';
import type { DeleteMediaOptions } from '../api/library.js';
import { profilesApi } from '../api/profiles.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { audiobookKeys } from './audiobook-keys.js';
import { patchQueries } from './library.js';
import { libraryKeys } from './library-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Authors, books and series (Wave 3). The feature flag lives in hooks/music.ts (useFeatures).

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

export function useAuthorList(enabled = true) {
  return useQuery({ queryKey: audiobookKeys.authors.list(), queryFn: audiobooksApi.authors.list, enabled });
}

/**
 * An author just added has no books until the AuthorAdd job has read the catalogue: true while
 * the author was never refreshed and has no books yet.
 */
export function isLoadingBooks(a: Pick<AuthorDetails, 'books' | 'lastRefreshed'> | undefined): boolean {
  return a !== undefined && a.books.length === 0 && !a.lastRefreshed;
}

/** How often the author page polls while books are still loading. */
export const LOADING_BOOKS_POLL_MS = 3_000;

export function useAuthor(id: number) {
  return useQuery({
    queryKey: audiobookKeys.authors.detail(id),
    queryFn: () => audiobooksApi.authors.get(id),
    enabled: Number.isInteger(id) && id > 0,
    refetchInterval: (query) => (isLoadingBooks(query.state.data) ? LOADING_BOOKS_POLL_MS : false),
  });
}

export function useBook(id: number) {
  return useQuery({
    queryKey: audiobookKeys.books.detail(id),
    queryFn: () => audiobooksApi.books.get(id),
    enabled: Number.isInteger(id) && id > 0,
  });
}

/** GET /book?authorId=: the author's books (cheap title lookups for activity rows and pickers). */
export function useAuthorBooks(authorId: number | null | undefined, enabled = true) {
  return useQuery({
    queryKey: audiobookKeys.books.list(authorId ?? 0),
    queryFn: () => audiobooksApi.books.list(authorId!),
    enabled: enabled && authorId != null && authorId > 0,
    staleTime: 60_000,
  });
}

export function useBookSeriesList(enabled = true) {
  return useQuery({ queryKey: audiobookKeys.series.list(), queryFn: () => audiobooksApi.series.list(), enabled, staleTime: 60_000 });
}

export function useBookSeries(id: number) {
  return useQuery({
    queryKey: audiobookKeys.series.detail(id),
    queryFn: () => audiobooksApi.series.get(id),
    enabled: Number.isInteger(id) && id > 0,
  });
}

export function useAudiobookFiles(query: { authorId?: number; bookId?: number }, enabled = true) {
  return useQuery({ queryKey: audiobookKeys.files(query), queryFn: () => audiobooksApi.audioFiles(query), enabled });
}

export function useAuthorLookup(term: string) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: audiobookKeys.authorLookup(trimmed),
    queryFn: () => audiobooksApi.authors.lookup(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Book search; runs once any field has two characters (an ASIN or ISBN is always long enough). */
export function useBookLookup(input: BookLookupInput) {
  const enabled = Object.values(input).some((v) => typeof v === 'string' && v.trim().length >= 2);
  return useQuery({
    queryKey: audiobookKeys.bookLookup(input),
    queryFn: () => audiobooksApi.books.lookup(input),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useAudiobookQualityProfiles(enabled = true) {
  return useQuery({ queryKey: audiobookKeys.qualityProfiles, queryFn: () => profilesApi.quality.list('audiobook'), staleTime: 60_000, enabled });
}

export function useWantedBooks(mode: 'missing' | 'cutoff', page: number, pageSize = 50, enabled = true, q = '', release: WantedReleaseFilter = {}) {
  return useQuery({
    enabled,
    queryKey: audiobookKeys.wanted(mode, page, pageSize, q, release),
    queryFn: () => {
      const query = { page, pageSize, q: q || undefined, ...release };
      return mode === 'missing' ? audiobooksApi.wanted.missing(query) : audiobooksApi.wanted.cutoff(query);
    },
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------

function storeAuthor(qc: QueryClient, author: Author) {
  qc.setQueryData<AuthorDetails>(audiobookKeys.authors.detail(author.id), (prev) =>
    prev ? { ...prev, ...author, books: prev.books, series: prev.series } : prev,
  );
  qc.setQueryData<Author[]>(audiobookKeys.authors.list(), (prev) => prev?.map((a) => (a.id === author.id ? author : a)));
}

export function useAddAuthor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddAuthorRequestInput) => audiobooksApi.authors.add(body),
    meta: { silent: true },
    onSuccess: (author) => {
      // Seed the details page: the books arrive later (AuthorAdd job), polled by useAuthor.
      qc.setQueryData<AuthorDetails>(audiobookKeys.authors.detail(author.id), { ...author, books: [], series: [] });
      void qc.invalidateQueries({ queryKey: audiobookKeys.authors.list() });
      void qc.invalidateQueries({ queryKey: ['audiobookLookup'] });
    },
  });
}

export function useAddBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddBookRequestInput) => audiobooksApi.books.add(body),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: audiobookKeys.all });
      void qc.invalidateQueries({ queryKey: ['audiobookLookup'] });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

export function useSetAuthorMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, monitored }: { id: number; monitored: boolean }) => audiobooksApi.authors.update(id, { monitored }),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onMutate: async ({ id, monitored }) => {
      const a = await patchQueries<AuthorDetails>(qc, audiobookKeys.authors.detail(id), (x) => ({ ...x, monitored }));
      const b = await patchQueries<Author[]>(qc, audiobookKeys.authors.list(), (list) => list.map((x) => (x.id === id ? { ...x, monitored } : x)));
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (author) => storeAuthor(qc, author),
  });
}

export function useUpdateAuthor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateAuthorRequest }) => audiobooksApi.authors.update(id, body),
    meta: { errorTitle: t('audiobooks.hooks.couldNotSaveAuthor') },
    onSuccess: (author, { body }) => {
      storeAuthor(qc, author);
      if (body.monitorOption !== undefined) void qc.invalidateQueries({ queryKey: audiobookKeys.authors.detail(author.id) });
    },
  });
}

export function useBulkUpdateAuthors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkAuthorUpdateRequest) => audiobooksApi.authors.bulk(body),
    meta: { errorTitle: t('audiobooks.hooks.couldNotUpdateAuthors') },
    onSettled: () => void qc.invalidateQueries({ queryKey: audiobookKeys.authors.all }),
  });
}

export function useDeleteAuthor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...opts }: { id: number } & DeleteMediaOptions) => audiobooksApi.authors.remove(id, opts),
    meta: { errorTitle: t('audiobooks.hooks.couldNotDeleteAuthor') },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: audiobookKeys.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

export function useDeleteBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...opts }: { id: number } & DeleteMediaOptions) => audiobooksApi.books.remove(id, opts),
    meta: { errorTitle: t('audiobooks.hooks.couldNotDeleteBook') },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: audiobookKeys.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** Pure helper for the optimistic book toggles (exported for tests). */
export function withBooksMonitored<T extends { books: Book[] }>(holder: T, ids: readonly number[], monitored: boolean): T {
  const set = new Set(ids);
  return { ...holder, books: holder.books.map((b) => (set.has(b.id) ? { ...b, monitored } : b)) };
}

/** One book (PUT /book/:id) or several (PUT /book/monitor), from the author, series or book page. */
export function useSetBooksMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ bookIds, monitored }: { authorId?: number | undefined; seriesId?: number | undefined; bookIds: number[]; monitored: boolean }) => {
      if (bookIds.length === 1) await audiobooksApi.books.update(bookIds[0]!, { monitored });
      else await audiobooksApi.books.monitor({ bookIds, monitored });
    },
    meta: { errorTitle: t('audiobooks.hooks.couldNotChangeBookMonitoring') },
    onMutate: async ({ authorId, seriesId, bookIds, monitored }) => {
      const out: Array<[readonly unknown[], unknown]> = [];
      if (authorId) out.push(...(await patchQueries<AuthorDetails>(qc, audiobookKeys.authors.detail(authorId), (x) => withBooksMonitored(x, bookIds, monitored))));
      if (seriesId) out.push(...(await patchQueries<BookSeriesDetails>(qc, audiobookKeys.series.detail(seriesId), (x) => withBooksMonitored(x, bookIds, monitored))));
      for (const id of bookIds) out.push(...(await patchQueries<BookDetails>(qc, audiobookKeys.books.detail(id), (x) => ({ ...x, monitored }))));
      return out;
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: audiobookKeys.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** RefreshAuthor / RescanAuthor through POST /command: a "started" toast, then the job's events. */
export function useAudiobookCommand() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ name, authorId }: { name: 'RefreshAuthor' | 'RescanAuthor'; authorId: number }) => audiobooksApi.command({ name, authorIds: [authorId] }),
    meta: { errorTitle: t('hooks.library.couldNotStartRefresh') },
    onSuccess: (job, { name, authorId }) => {
      toast.push({
        tone: 'ok',
        title: name === 'RescanAuthor' ? t('music.hooks.rescanStarted') : t('hooks.library.refreshStarted'),
        message: t('hooks.library.runIdIsStatus', { id: job.id, status: job.status }),
        durationMs: 4_000,
      });
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: audiobookKeys.authors.detail(authorId) });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export function useAudiobookMetadataSettings(enabled = true) {
  return useQuery({ queryKey: audiobookKeys.metadata, queryFn: audiobooksApi.settings.metadata.get, retry: false, enabled });
}

export function useSaveAudiobookMetadataSettings() {
  return useInvalidatingMutation((body: AudiobookMetadataSettingsUpdate) => audiobooksApi.settings.metadata.update(body), [audiobookKeys.metadata], {
    errorTitle: t('audiobooks.settings.couldNotSaveMetadata'),
  });
}
