import { z } from 'zod';

// The Books contract (docs/books.md): two kinds of reading media in one section, gated by
// `features.books`.
//
// * Ebooks: authors → books (one work each, the best edition's ISBN kept), series shared with
//   the audiobook library (`book_series`), files in `book_files`.
// * Comics (comics, manga, graphic novels): series (a ComicVine "volume" / Metron "series") →
//   issues (or tankōbon volumes, numbered like issues), files in `book_files`.
//
// Metadata comes from several catalogues (OpenLibrary, Google Books, Hardcover; ComicVine and
// Metron for comics), merged and cached so one outage only costs freshness. Releases come from
// the user's own Newznab/Torznab indexers in the standard Books categories. Prefixes: `Ebook*`,
// `Comic*` and `Books*` keep these names apart from the audiobook contract (audiobooks.ts).

const isoDate = () => z.string().describe('ISO-8601 date or timestamp');
const qsBool = () => z.union([z.boolean(), z.stringbool()]);

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

export const BooksKind = z.enum(['ebook', 'comic']);
export type BooksKind = z.infer<typeof BooksKind>;

/** Ebook file formats, best first by default. */
export const EbookFormat = z.enum(['epub', 'azw3', 'mobi', 'pdf']);
export type EbookFormat = z.infer<typeof EbookFormat>;

/** Comic archive formats, best first by default (`pdf` last). */
export const ComicFormat = z.enum(['cbz', 'cbr', 'cb7', 'pdf']);
export type ComicFormat = z.infer<typeof ComicFormat>;

/** Every format a book file can have. */
export const BooksFormat = z.enum(['epub', 'azw3', 'mobi', 'pdf', 'cbz', 'cbr', 'cb7']);
export type BooksFormat = z.infer<typeof BooksFormat>;

export const EBOOK_FORMATS: readonly EbookFormat[] = EbookFormat.options;
export const COMIC_FORMATS: readonly ComicFormat[] = ComicFormat.options;

/** The formats one kind can use. */
export function formatsOfKind(kind: BooksKind): readonly BooksFormat[] {
  return kind === 'ebook' ? EBOOK_FORMATS : COMIC_FORMATS;
}

/** File extension (without the dot, any case) → format; `azw`/`kfx` read as azw3, `cbt` is not supported. */
export function booksFormatOfExtension(ext: string): BooksFormat | null {
  const e = ext.replace(/^\./, '').toLowerCase();
  if (e === 'azw' || e === 'kfx') return 'azw3';
  return (BooksFormat.options as readonly string[]).includes(e) ? (e as BooksFormat) : null;
}

/** Catalogue sources. */
export const BooksSource = z.enum(['openLibrary', 'googleBooks', 'hardcover', 'comicVine', 'metron']);
export type BooksSource = z.infer<typeof BooksSource>;

/** How one source answered a lookup: live, from the local cache, from an expired cache entry, or not at all. */
export const BooksSourceState = z.enum(['ok', 'cached', 'stale', 'failed', 'disabled']);
export type BooksSourceState = z.infer<typeof BooksSourceState>;

export const BooksSourceStatus = z.object({
  source: BooksSource,
  state: BooksSourceState,
  message: z.string().optional(),
});
export type BooksSourceStatus = z.infer<typeof BooksSourceStatus>;

export const MonitorNewEbooks = z.enum(['all', 'none', 'inSeries']);
export type MonitorNewEbooks = z.infer<typeof MonitorNewEbooks>;

/** What to monitor when an author is added (`future`: only books not released yet). */
export const EbookMonitorOption = z.enum(['all', 'future', 'missing', 'existing', 'first', 'latest', 'inSeries', 'none']);
export type EbookMonitorOption = z.infer<typeof EbookMonitorOption>;

/** What to monitor when a comic series is added. */
export const ComicMonitorOption = z.enum(['all', 'future', 'missing', 'existing', 'first', 'latest', 'none']);
export type ComicMonitorOption = z.infer<typeof ComicMonitorOption>;

// ---------------------------------------------------------------------------------------
// Format profiles
// ---------------------------------------------------------------------------------------

/**
 * Which formats a release may have and which ones are preferred (`formats`, best first).
 * Sizes are in MB; null means no limit. A file at the `cutoff` format (or better) stops upgrades.
 */
export const BooksFormatProfile = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  kind: BooksKind,
  formats: z.array(BooksFormat).min(1),
  cutoff: BooksFormat,
  upgradeAllowed: z.boolean(),
  minSizeMb: z.number().min(0).nullable(),
  maxSizeMb: z.number().min(0).nullable(),
  /** Releases whose title contains one of these words are rejected (case-insensitive). */
  ignoredTerms: z.array(z.string()),
  /** Releases with one of these words are preferred over equal ones (case-insensitive). */
  preferredTerms: z.array(z.string()),
});
export type BooksFormatProfile = z.infer<typeof BooksFormatProfile>;

export const BooksFormatProfileInput = BooksFormatProfile.omit({ id: true })
  .extend({
    upgradeAllowed: z.boolean().default(true),
    minSizeMb: z.number().min(0).nullable().default(null),
    maxSizeMb: z.number().min(0).nullable().default(null),
    ignoredTerms: z.array(z.string()).default([]),
    preferredTerms: z.array(z.string()).default([]),
  })
  .superRefine((p, ctx) => {
    const allowed = formatsOfKind(p.kind);
    for (const f of p.formats) if (!allowed.includes(f)) ctx.addIssue({ code: 'custom', path: ['formats'], message: `${f} is not a ${p.kind} format` });
    if (new Set(p.formats).size !== p.formats.length) ctx.addIssue({ code: 'custom', path: ['formats'], message: 'formats must not repeat' });
    if (!p.formats.includes(p.cutoff)) ctx.addIssue({ code: 'custom', path: ['cutoff'], message: 'the cutoff must be one of the formats' });
    if (p.minSizeMb !== null && p.maxSizeMb !== null && p.minSizeMb > p.maxSizeMb) {
      ctx.addIssue({ code: 'custom', path: ['maxSizeMb'], message: 'maximum size is below the minimum' });
    }
  });
export type BooksFormatProfileInput = z.input<typeof BooksFormatProfileInput>;

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

export const BooksFile = z.object({
  id: z.number().int(),
  kind: BooksKind,
  ebookId: z.number().int().nullable(),
  comicIssueId: z.number().int().nullable(),
  path: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number().int(),
  format: BooksFormat,
  releaseGroup: z.string().nullable(),
  sceneName: z.string().nullable(),
  dateAdded: isoDate(),
});
export type BooksFile = z.infer<typeof BooksFile>;

// ---------------------------------------------------------------------------------------
// Ebooks: authors, books, series
// ---------------------------------------------------------------------------------------

export const EbookAuthorStatistics = z.object({
  bookCount: z.number().int(),
  monitoredCount: z.number().int(),
  availableCount: z.number().int(),
  seriesCount: z.number().int(),
  sizeOnDisk: z.number().int(),
});
export type EbookAuthorStatistics = z.infer<typeof EbookAuthorStatistics>;

export const EbookAuthor = z.object({
  id: z.number().int(),
  name: z.string(),
  sortName: z.string(),
  olAuthorId: z.string().nullable(),
  hardcoverId: z.string().nullable(),
  overview: z.string(),
  imageUrl: z.string().nullable(),
  path: z.string(),
  rootFolderPath: z.string(),
  formatProfileId: z.number().int(),
  monitored: z.boolean(),
  monitorNewBooks: MonitorNewEbooks,
  tags: z.array(z.number().int()),
  /** The same person in the audiobook library, when there is one (matched by OpenLibrary id or name). */
  audiobookAuthorId: z.number().int().nullable(),
  added: isoDate(),
  lastRefreshed: isoDate().nullable(),
  statistics: EbookAuthorStatistics,
});
export type EbookAuthor = z.infer<typeof EbookAuthor>;

export const EbookSeriesLink = z.object({
  seriesId: z.number().int(),
  name: z.string(),
  /** As the catalogue writes it: `3`, `2.5`, `1-3`. */
  position: z.string().nullable(),
});
export type EbookSeriesLink = z.infer<typeof EbookSeriesLink>;

export const Ebook = z.object({
  id: z.number().int(),
  authorId: z.number().int(),
  authorName: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  sortTitle: z.string(),
  isbn13: z.string().nullable(),
  olWorkId: z.string().nullable(),
  googleVolumeId: z.string().nullable(),
  hardcoverId: z.string().nullable(),
  publisher: z.string().nullable(),
  language: z.string().nullable(),
  /** `YYYY-MM-DD`, or `YYYY` when the catalogues know no more. */
  releaseDate: z.string().nullable(),
  year: z.number().int().nullable(),
  pageCount: z.number().int().nullable(),
  overview: z.string(),
  genres: z.array(z.string()),
  coverUrl: z.string().nullable(),
  rating: z.number().nullable(),
  monitored: z.boolean(),
  hasFile: z.boolean(),
  series: z.array(EbookSeriesLink),
  file: BooksFile.nullable(),
  lastSearchedAt: isoDate().nullable(),
  added: isoDate(),
});
export type Ebook = z.infer<typeof Ebook>;

export const EbookAuthorDetails = EbookAuthor.extend({
  books: z.array(Ebook),
  series: z.array(z.object({ id: z.number().int(), name: z.string(), bookCount: z.number().int(), availableCount: z.number().int() })),
});
export type EbookAuthorDetails = z.infer<typeof EbookAuthorDetails>;

/** A series (shared with audiobooks) with the ebooks in it, in reading order. */
export const EbookSeriesDetails = z.object({
  id: z.number().int(),
  name: z.string(),
  overview: z.string(),
  books: z.array(Ebook.extend({ position: z.string().nullable() })),
  /** Audiobooks of the same series in the audiobook library. */
  audiobookCount: z.number().int(),
});
export type EbookSeriesDetails = z.infer<typeof EbookSeriesDetails>;

export const AddEbookAuthorRequest = z.object({
  /** Catalogue key of the author: `ol:OL23919A`, `hc:<id>` or `name:<name>`. */
  foreignId: z.string().min(1),
  name: z.string().min(1).optional(),
  rootFolderPath: z.string().min(1),
  formatProfileId: z.number().int().positive(),
  monitored: z.boolean().default(true),
  monitorOption: EbookMonitorOption.default('all'),
  monitorNewBooks: MonitorNewEbooks.default('all'),
  tags: z.array(z.number().int()).default([]),
  searchOnAdd: z.boolean().default(false),
});
export type AddEbookAuthorRequest = z.input<typeof AddEbookAuthorRequest>;

/** Add one book (its author is created when new, other books unmonitored). */
export const AddEbookRequest = z.object({
  /** Catalogue key of the book: `isbn:9780…`, `ol:OL82563W`, `gb:<volume id>` or `hc:<id>`. */
  foreignId: z.string().min(1),
  rootFolderPath: z.string().min(1),
  formatProfileId: z.number().int().positive(),
  tags: z.array(z.number().int()).default([]),
  searchOnAdd: z.boolean().default(false),
});
export type AddEbookRequest = z.input<typeof AddEbookRequest>;

export const UpdateEbookAuthorRequest = z.object({
  monitored: z.boolean().optional(),
  monitorNewBooks: MonitorNewEbooks.optional(),
  formatProfileId: z.number().int().positive().optional(),
  rootFolderPath: z.string().min(1).optional(),
  tags: z.array(z.number().int()).optional(),
  monitorOption: EbookMonitorOption.optional(),
});
export type UpdateEbookAuthorRequest = z.input<typeof UpdateEbookAuthorRequest>;

export const SetMonitoredRequest = z.object({ ids: z.array(z.number().int().positive()).min(1), monitored: z.boolean() });
export type SetMonitoredRequest = z.infer<typeof SetMonitoredRequest>;

// ---------------------------------------------------------------------------------------
// Comics: series, issues
// ---------------------------------------------------------------------------------------

export const ComicSeriesStatistics = z.object({
  issueCount: z.number().int(),
  monitoredCount: z.number().int(),
  availableCount: z.number().int(),
  sizeOnDisk: z.number().int(),
});
export type ComicSeriesStatistics = z.infer<typeof ComicSeriesStatistics>;

export const ComicSeries = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string(),
  publisher: z.string().nullable(),
  /** First year of the run ("Saga (2012)"). */
  startYear: z.number().int().nullable(),
  /** `comic` (single issues), `manga` or `graphicNovel` (collected volumes); shapes naming and parsing. */
  seriesType: z.enum(['comic', 'manga', 'graphicNovel']),
  comicVineId: z.string().nullable(),
  metronId: z.string().nullable(),
  overview: z.string(),
  coverUrl: z.string().nullable(),
  status: z.enum(['continuing', 'ended', 'unknown']),
  path: z.string(),
  rootFolderPath: z.string(),
  formatProfileId: z.number().int(),
  monitored: z.boolean(),
  /** New issues found on refresh start monitored. */
  monitorNewIssues: z.boolean(),
  tags: z.array(z.number().int()),
  added: isoDate(),
  lastRefreshed: isoDate().nullable(),
  statistics: ComicSeriesStatistics,
});
export type ComicSeries = z.infer<typeof ComicSeries>;

export const ComicIssue = z.object({
  id: z.number().int(),
  seriesId: z.number().int(),
  seriesTitle: z.string(),
  /** As published: `1`, `12.1`, `0`, `½`, `Annual 1`. */
  issueNumber: z.string(),
  issueSort: z.number().nullable(),
  title: z.string().nullable(),
  /** The date printed on the cover (often months ahead). */
  coverDate: z.string().nullable(),
  /** The on-sale date; the calendar and "released" use this when known. */
  storeDate: z.string().nullable(),
  comicVineId: z.string().nullable(),
  metronId: z.string().nullable(),
  overview: z.string(),
  coverUrl: z.string().nullable(),
  monitored: z.boolean(),
  hasFile: z.boolean(),
  file: BooksFile.nullable(),
  lastSearchedAt: isoDate().nullable(),
});
export type ComicIssue = z.infer<typeof ComicIssue>;

export const ComicSeriesDetails = ComicSeries.extend({ issues: z.array(ComicIssue) });
export type ComicSeriesDetails = z.infer<typeof ComicSeriesDetails>;

export const AddComicSeriesRequest = z.object({
  /** `cv:<volume id>` or `metron:<series id>`. */
  foreignId: z.string().min(1),
  rootFolderPath: z.string().min(1),
  formatProfileId: z.number().int().positive(),
  seriesType: z.enum(['comic', 'manga', 'graphicNovel']).default('comic'),
  monitored: z.boolean().default(true),
  monitorOption: ComicMonitorOption.default('all'),
  monitorNewIssues: z.boolean().default(true),
  tags: z.array(z.number().int()).default([]),
  searchOnAdd: z.boolean().default(false),
});
export type AddComicSeriesRequest = z.input<typeof AddComicSeriesRequest>;

export const UpdateComicSeriesRequest = z.object({
  monitored: z.boolean().optional(),
  monitorNewIssues: z.boolean().optional(),
  seriesType: z.enum(['comic', 'manga', 'graphicNovel']).optional(),
  formatProfileId: z.number().int().positive().optional(),
  rootFolderPath: z.string().min(1).optional(),
  tags: z.array(z.number().int()).optional(),
  monitorOption: ComicMonitorOption.optional(),
});
export type UpdateComicSeriesRequest = z.input<typeof UpdateComicSeriesRequest>;

// ---------------------------------------------------------------------------------------
// Catalogue lookups (add screens, requests)
// ---------------------------------------------------------------------------------------

export const BooksLookupQuery = z.object({ term: z.string().trim().min(1).max(200) });
export type BooksLookupQuery = z.infer<typeof BooksLookupQuery>;

export const EbookAuthorCandidate = z.object({
  foreignId: z.string(),
  name: z.string(),
  overview: z.string(),
  imageUrl: z.string().nullable(),
  topWork: z.string().nullable(),
  workCount: z.number().int().nullable(),
  sources: z.array(BooksSource),
  /** Library id when the author is already in the ebook library. */
  libraryId: z.number().int().nullable(),
});
export type EbookAuthorCandidate = z.infer<typeof EbookAuthorCandidate>;

export const EbookCandidate = z.object({
  foreignId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authorName: z.string().nullable(),
  authorForeignId: z.string().nullable(),
  isbn13: z.string().nullable(),
  year: z.number().int().nullable(),
  publisher: z.string().nullable(),
  overview: z.string(),
  coverUrl: z.string().nullable(),
  series: z.array(z.object({ name: z.string(), position: z.string().nullable() })),
  sources: z.array(BooksSource),
  libraryId: z.number().int().nullable(),
});
export type EbookCandidate = z.infer<typeof EbookCandidate>;

export const ComicSeriesCandidate = z.object({
  foreignId: z.string(),
  title: z.string(),
  publisher: z.string().nullable(),
  startYear: z.number().int().nullable(),
  issueCount: z.number().int().nullable(),
  overview: z.string(),
  coverUrl: z.string().nullable(),
  sources: z.array(BooksSource),
  libraryId: z.number().int().nullable(),
});
export type ComicSeriesCandidate = z.infer<typeof ComicSeriesCandidate>;

export const BooksLookupResult = <T extends z.ZodType>(item: T) => z.object({ results: z.array(item), sources: z.array(BooksSourceStatus) });
export const EbookAuthorLookupResult = BooksLookupResult(EbookAuthorCandidate);
export type EbookAuthorLookupResult = z.infer<typeof EbookAuthorLookupResult>;
export const EbookLookupResult = BooksLookupResult(EbookCandidate);
export type EbookLookupResult = z.infer<typeof EbookLookupResult>;
export const ComicLookupResult = BooksLookupResult(ComicSeriesCandidate);
export type ComicLookupResult = z.infer<typeof ComicLookupResult>;

// ---------------------------------------------------------------------------------------
// Wanted, calendar
// ---------------------------------------------------------------------------------------

export const BooksWantedItem = z.object({
  kind: BooksKind,
  /** Ebook id or comic issue id. */
  id: z.number().int(),
  /** Author id or comic series id. */
  parentId: z.number().int(),
  title: z.string(),
  /** Author name, or "Series (Year)". */
  parentTitle: z.string(),
  releaseDate: z.string().nullable(),
  coverUrl: z.string().nullable(),
  lastSearchedAt: isoDate().nullable(),
  /** `missing`: no file; `cutoff`: a file below the profile's cutoff. */
  reason: z.enum(['missing', 'cutoff']),
});
export type BooksWantedItem = z.infer<typeof BooksWantedItem>;

export const BooksWantedQuery = z.object({
  kind: z.enum(['all', 'ebook', 'comic']).default('all'),
  reason: z.enum(['missing', 'cutoff']).default('missing'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type BooksWantedQuery = z.input<typeof BooksWantedQuery>;

export const BooksWantedPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(BooksWantedItem),
});
export type BooksWantedPage = z.infer<typeof BooksWantedPage>;

export const BooksCalendarQuery = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  unmonitored: qsBool().optional(),
});
export type BooksCalendarQuery = z.input<typeof BooksCalendarQuery>;

/** A book or comic issue on its release day (`date`, YYYY-MM-DD). */
export const BooksCalendarEntry = z.object({
  kind: BooksKind,
  id: z.number().int(),
  parentId: z.number().int(),
  date: z.string(),
  title: z.string(),
  parentTitle: z.string(),
  coverUrl: z.string().nullable(),
  monitored: z.boolean(),
  hasFile: z.boolean(),
});
export type BooksCalendarEntry = z.infer<typeof BooksCalendarEntry>;

// ---------------------------------------------------------------------------------------
// Releases (interactive search and grab)
// ---------------------------------------------------------------------------------------

export const BooksReleaseTarget = z.object({
  kind: BooksKind,
  /** Ebook id or comic issue id. */
  id: z.number().int().positive(),
});
export type BooksReleaseTarget = z.infer<typeof BooksReleaseTarget>;

export const BooksRelease = z.object({
  guid: z.string(),
  indexerId: z.number().int(),
  indexer: z.string(),
  title: z.string(),
  sizeBytes: z.number(),
  protocol: z.enum(['torrent', 'usenet']),
  seeders: z.number().int().nullable(),
  publishDate: z.string(),
  categories: z.array(z.number().int()),
  format: BooksFormat.nullable(),
  releaseGroup: z.string().nullable(),
  approved: z.boolean(),
  rejections: z.array(z.string()),
  /** Higher is better among approved releases. */
  score: z.number(),
});
export type BooksRelease = z.infer<typeof BooksRelease>;

export const BooksGrabRequest = BooksReleaseTarget.extend({
  indexerId: z.number().int().positive(),
  guid: z.string().min(1),
  /** Grab even when the decision rejected the release. */
  force: z.boolean().default(false),
});
export type BooksGrabRequest = z.input<typeof BooksGrabRequest>;

export const BooksGrabResult = z.object({ title: z.string(), downloadId: z.string() });
export type BooksGrabResult = z.infer<typeof BooksGrabResult>;

/** POST /books/command: background work over library ids. */
export const BooksCommand = z.discriminatedUnion('name', [
  z.object({ name: z.literal('EbookSearch'), ebookIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ name: z.literal('EbookAuthorSearch'), authorIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ name: z.literal('ComicIssueSearch'), issueIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ name: z.literal('ComicSeriesSearch'), seriesIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ name: z.literal('RefreshEbookAuthor'), authorIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ name: z.literal('RefreshComicSeries'), seriesIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ name: z.literal('BooksMissingSearch'), kind: z.enum(['all', 'ebook', 'comic']).default('all') }),
  z.object({ name: z.literal('RescanBooks') }),
]);
export type BooksCommand = z.input<typeof BooksCommand>;

export const BooksCommandResult = z.object({ name: z.string(), message: z.string() });
export type BooksCommandResult = z.infer<typeof BooksCommandResult>;

// ---------------------------------------------------------------------------------------
// Library apps (refresh after import)
// ---------------------------------------------------------------------------------------

export const BooksLibraryAppImplementation = z.enum(['calibreWeb', 'kavita', 'komga', 'audiobookshelf']);
export type BooksLibraryAppImplementation = z.infer<typeof BooksLibraryAppImplementation>;

/** Which kinds an app is told about (`audiobook`: audiobook imports, for Audiobookshelf). */
export const BooksLibraryAppKind = z.enum(['ebook', 'comic', 'audiobook']);
export type BooksLibraryAppKind = z.infer<typeof BooksLibraryAppKind>;

/**
 * A reading server Arclight asks to rescan after an import. `apiKey` / `password` are
 * SECRET_MASK on reads when stored; sending the mask back keeps them. `libraryId` empty: every
 * library the app has (Komga, Audiobookshelf) or the imported folder (Kavita).
 */
export const BooksLibraryApp = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  implementation: BooksLibraryAppImplementation,
  enabled: z.boolean(),
  url: z.string().url(),
  apiKey: z.string(),
  username: z.string(),
  password: z.string(),
  libraryId: z.string(),
  kinds: z.array(BooksLibraryAppKind).min(1),
});
export type BooksLibraryApp = z.infer<typeof BooksLibraryApp>;

export const BooksLibraryAppInput = BooksLibraryApp.omit({ id: true }).extend({
  enabled: z.boolean().default(true),
  apiKey: z.string().default(''),
  username: z.string().default(''),
  password: z.string().default(''),
  libraryId: z.string().default(''),
});
export type BooksLibraryAppInput = z.input<typeof BooksLibraryAppInput>;

export const BooksLibraryAppTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type BooksLibraryAppTestResult = z.infer<typeof BooksLibraryAppTestResult>;

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

export const BooksRequestStatus = z.enum(['pending', 'approved', 'declined', 'completed', 'failed']);
export type BooksRequestStatus = z.infer<typeof BooksRequestStatus>;

export const CreateBooksRequest = z.object({
  kind: BooksKind,
  /** Ebook: a book key (`isbn:…`, `ol:…W`, `gb:…`, `hc:…`); comic: a series key (`cv:…`, `metron:…`). */
  foreignId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  subtitle: z.string().max(500).nullable().default(null),
  year: z.number().int().nullable().default(null),
  coverUrl: z.string().max(2000).nullable().default(null),
});
export type CreateBooksRequest = z.input<typeof CreateBooksRequest>;

export const BooksRequest = z.object({
  id: z.number().int(),
  kind: BooksKind,
  status: BooksRequestStatus,
  foreignId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  year: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  requestedBy: z.object({ id: z.number().int(), username: z.string() }),
  modifiedBy: z.object({ id: z.number().int(), username: z.string() }).nullable(),
  declineReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** Ebook id or comic series id once approved. */
  libraryId: z.number().int().nullable(),
  available: z.boolean(),
  canRemove: z.boolean(),
  createdAt: isoDate(),
  updatedAt: isoDate(),
});
export type BooksRequest = z.infer<typeof BooksRequest>;

export const BooksRequestListQuery = z.object({
  kind: z.enum(['all', 'ebook', 'comic']).default('all'),
  status: z.enum(['all', 'pending', 'approved', 'declined', 'completed', 'failed']).default('all'),
  mine: qsBool().optional(),
});
export type BooksRequestListQuery = z.input<typeof BooksRequestListQuery>;

export const BooksRequestList = z.object({ records: z.array(BooksRequest) });
export type BooksRequestList = z.infer<typeof BooksRequestList>;

export const BooksDeclineRequest = z.object({ reason: z.string().max(1000).optional() });

// ---------------------------------------------------------------------------------------
// Settings (section `books`)
// ---------------------------------------------------------------------------------------

/** Folder and file formats; tokens are listed in docs/books.md. */
export const BooksNamingSettings = z.object({
  renameFiles: z.boolean().default(true),
  ebookFolderFormat: z.string().min(1).default('{Author Name}/{Series Title}/{Book Title} ({Release Year})'),
  ebookFileFormat: z.string().min(1).default('{Book Title} - {Author Name}'),
  comicFolderFormat: z.string().min(1).default('{Publisher}/{Series Title} ({Series Year})'),
  comicFileFormat: z.string().min(1).default('{Series Title} #{Issue Number:000} ({Release Year})'),
});
export type BooksNamingSettings = z.infer<typeof BooksNamingSettings>;

export const BooksMetadataSettings = z.object({
  openLibrary: z.boolean().default(true),
  googleBooks: z.boolean().default(true),
  /** Optional: Google Books works without a key at a lower quota. */
  googleBooksApiKey: z.string().default(''),
  hardcover: z.boolean().default(false),
  /** Hardcover API token (Settings → API on hardcover.app); without it the source is skipped. */
  hardcoverApiKey: z.string().default(''),
  comicVine: z.boolean().default(false),
  comicVineApiKey: z.string().default(''),
  metron: z.boolean().default(false),
  metronUsername: z.string().default(''),
  metronPassword: z.string().default(''),
  /** Keep books in these languages (ISO 639 codes or names); empty keeps every language. */
  languages: z.array(z.string()).default(['en']),
});
export type BooksMetadataSettings = z.infer<typeof BooksMetadataSettings>;

export const BooksSearchSettings = z.object({
  /** Newznab/Torznab categories searched for ebooks (7000 Books, 7020 EBook). */
  ebookCategories: z.array(z.number().int()).default([7020, 7000]),
  /** Categories searched for comics (7030 Comics). */
  comicCategories: z.array(z.number().int()).default([7030]),
  /** Automatic searches for wanted items, hours between runs (0: off). */
  missingSearchIntervalHours: z.number().int().min(0).max(168).default(24),
  /** Skip an item searched less than this many hours ago in the automatic search. */
  itemSearchCooldownHours: z.number().int().min(0).max(720).default(12),
});
export type BooksSearchSettings = z.infer<typeof BooksSearchSettings>;

export const BooksSettings = z.object({
  metadata: BooksMetadataSettings.default(BooksMetadataSettings.parse({})),
  naming: BooksNamingSettings.default(BooksNamingSettings.parse({})),
  search: BooksSearchSettings.default(BooksSearchSettings.parse({})),
});
export type BooksSettings = z.infer<typeof BooksSettings>;
export type BooksSettingsInput = z.input<typeof BooksSettings>;

/** Secret fields of the `books` section (masked on reads). */
export const BOOKS_SECRET_FIELDS = ['googleBooksApiKey', 'hardcoverApiKey', 'comicVineApiKey', 'metronPassword'] as const;

// ---------------------------------------------------------------------------------------
// Overview (library landing page)
// ---------------------------------------------------------------------------------------

export const BooksOverview = z.object({
  ebookAuthors: z.number().int(),
  ebooks: z.number().int(),
  ebooksAvailable: z.number().int(),
  comicSeries: z.number().int(),
  comicIssues: z.number().int(),
  comicIssuesAvailable: z.number().int(),
  sizeOnDisk: z.number().int(),
  wanted: z.number().int(),
});
export type BooksOverview = z.infer<typeof BooksOverview>;
