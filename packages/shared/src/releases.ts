import { z } from 'zod';
import { ReleaseResource } from './indexers.js';
import { AnyMediaType } from './library.js';
import { ReleaseProtocol } from './profiles.js';
import { QualityModel } from './quality.js';

// Releases contract: decisions the engine reaches about indexer results, grab requests,
// the delayed-release (pending) queue and the search/push request shapes.

/** Where a batch of releases came from; some specs behave differently by source. */
export const ReleaseSource = z.enum(['rss', 'search', 'userInvokedSearch', 'interactiveSearch', 'releasePush']);
export type ReleaseSource = z.infer<typeof ReleaseSource>;

export const RejectionType = z.enum(['permanent', 'temporary']);
export type RejectionType = z.infer<typeof RejectionType>;

/** One failed check. `reason` is the stable code (decision-engine spec §14), `message` is for humans. */
export const ReleaseRejection = z.object({
  reason: z.string(),
  message: z.string(),
  type: RejectionType,
});
export type ReleaseRejection = z.infer<typeof ReleaseRejection>;

/**
 * What the music parser read from a release name (music decisions only). The interactive album
 * search shows it next to the matched album, so the user sees why a release mapped where it did.
 */
export const ReleaseMusicInfo = z.object({
  /** Album artist as written; "Various Artists" for VA releases. */
  artist: z.string().nullable(),
  /** Album title without edition, year and tag brackets; null for packs. */
  album: z.string().nullable(),
  year: z.number().int().nullable(),
  edition: z.string().nullable(),
  isVariousArtists: z.boolean(),
  /** `discography`: an artist's catalogue (or a span of it); `multiAlbum`: a set of albums; null: one album. */
  packType: z.enum(['discography', 'multiAlbum']).nullable(),
  discographyYears: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
  /** EP, Single, Live, Compilation, Soundtrack or Bootleg; null when the name does not say. */
  releaseTypeHint: z.string().nullable(),
  /** CD, WEB, Vinyl, SACD, Cassette, DVD, BD or Unknown. */
  media: z.string(),
  catalogNumber: z.string().nullable(),
  discCount: z.number().int().nullable(),
  codec: z.string(),
  bitrateKbps: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  sampleRateHz: z.number().int().nullable(),
  hasLog: z.boolean(),
  logScore: z.number().int().nullable(),
  hasCue: z.boolean(),
});
export type ReleaseMusicInfo = z.infer<typeof ReleaseMusicInfo>;

/** An album a music decision maps to. */
export const ReleaseAlbumRef = z.object({
  id: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable(),
});
export type ReleaseAlbumRef = z.infer<typeof ReleaseAlbumRef>;

/**
 * What the audiobook parser read from a release name (audiobook decisions only). The
 * interactive book search shows it next to the matched books.
 */
export const ReleaseAudiobookInfo = z.object({
  /** Credited authors as written ("Last, First" turned around). */
  authors: z.array(z.string()),
  /** Null for packs named only by series and range. */
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  series: z.string().nullable(),
  /** `3`, `2.5`, or a range for packs (`1-5`). */
  seriesPosition: z.string().nullable(),
  narrators: z.array(z.string()),
  year: z.number().int().nullable(),
  /** `unabridged`, `abridged`, `dramatized` or `unknown`. */
  formatType: z.string(),
  /** `m4b`, `m4a`, `mp3`, `flac`, `opus` or `unknown`. */
  container: z.string(),
  codec: z.string(),
  bitrateKbps: z.number().int().nullable(),
  asin: z.string().nullable(),
  isbn: z.string().nullable(),
  /** A series pack ("Books 1-5", "Complete Series"). */
  isPack: z.boolean(),
  /** ISO 639-1 code when the name states a language. */
  language: z.string().nullable(),
});
export type ReleaseAudiobookInfo = z.infer<typeof ReleaseAudiobookInfo>;

/** A book an audiobook decision maps to. */
export const ReleaseBookRef = z.object({
  id: z.number().int(),
  title: z.string(),
  /** The book's primary series and position, when it has one. */
  series: z.string().nullable(),
  seriesPosition: z.string().nullable(),
  year: z.number().int().nullable(),
});
export type ReleaseBookRef = z.infer<typeof ReleaseBookRef>;

/** The verdict on one release. Extends the indexer's resource so the UI can show both at once. */
export const ReleaseDecision = ReleaseResource.omit({ rejections: true, approved: true }).extend({
  rejections: z.array(ReleaseRejection),
  approved: z.boolean(),
  temporarilyRejected: z.boolean(),
  /** True when the release may be grabbed (approved, or the user overrides a rejection interactively). */
  downloadAllowed: z.boolean(),
  source: ReleaseSource,
  mediaType: AnyMediaType.optional(),
  seriesId: z.number().int().optional(),
  seriesTitle: z.string().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  movieTitle: z.string().optional(),
  /** Music: the matched artist. */
  artistId: z.number().int().optional(),
  artistName: z.string().optional(),
  /** Music: the albums the release would fill or upgrade (for a pack, only the wanted ones). */
  albumIds: z.array(z.number().int()).optional(),
  /** Music: `albumIds` with titles and years, same order. */
  albums: z.array(ReleaseAlbumRef).optional(),
  /** Music: what the parser read from the release name. */
  music: ReleaseMusicInfo.optional(),
  /** Audiobooks: the matched author (the books' owner). */
  authorId: z.number().int().optional(),
  authorName: z.string().optional(),
  /** Audiobooks: the books the release would fill or upgrade (for a pack, only the wanted ones). */
  bookIds: z.array(z.number().int()).optional(),
  /** Audiobooks: `bookIds` with titles and series positions, same order. */
  books: z.array(ReleaseBookRef).optional(),
  /** Audiobooks: what the parser read from the release name. */
  audiobook: ReleaseAudiobookInfo.optional(),
  /** Multi-version items: the version slot the release was evaluated for (best-fitting profile). */
  versionTag: z.string().optional(),
  quality: QualityModel,
  languages: z.array(z.string()),
  customFormats: z.array(z.object({ id: z.number().int(), name: z.string() })),
  customFormatScore: z.number().int(),
  releaseGroup: z.string().optional(),
  mappedSeasonNumber: z.number().int().optional(),
  mappedEpisodeNumbers: z.array(z.number().int()).optional(),
  mappedAbsoluteEpisodeNumbers: z.array(z.number().int()).optional(),
  fullSeason: z.boolean(),
  /** Remaining delay in minutes when the release is held back by a delay profile. */
  delayMinutes: z.number().int().optional(),
});
export type ReleaseDecision = z.infer<typeof ReleaseDecision>;

/**
 * POST /release. Grabs a release seen by a recent search (cached by guid + indexer). For
 * interactive grabs whose mapping was ambiguous the caller may pin the library item.
 */
export const ReleaseGrabRequest = z.object({
  guid: z.string().min(1),
  indexerId: z.number().int(),
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  /** Music: pin the artist (and optionally the albums) of an ambiguous release. */
  artistId: z.number().int().optional(),
  albumIds: z.array(z.number().int()).optional(),
  /** Audiobooks: pin the author (and optionally the books) of an ambiguous release. */
  authorId: z.number().int().optional(),
  bookIds: z.array(z.number().int()).optional(),
  downloadClientId: z.number().int().optional(),
});
export type ReleaseGrabRequest = z.infer<typeof ReleaseGrabRequest>;
/** Alias used by the module code. */
export const GrabRequest = ReleaseGrabRequest;
export type GrabRequest = ReleaseGrabRequest;

export const ReleaseGrabResponse = z.object({
  title: z.string(),
  queueItemId: z.number().int(),
  downloadId: z.string(),
  downloadClientId: z.number().int().nullable(),
});
export type ReleaseGrabResponse = z.infer<typeof ReleaseGrabResponse>;

export const PendingReason = z.enum(['delay', 'fallback', 'downloadClientUnavailable']);
export type PendingReason = z.infer<typeof PendingReason>;

/** A release held back (delay profile, client down) until it becomes eligible. */
export const PendingRelease = z.object({
  id: z.number().int(),
  guid: z.string(),
  indexerId: z.number().int(),
  indexerName: z.string(),
  title: z.string(),
  protocol: ReleaseProtocol,
  size: z.number().int(),
  publishDate: z.string(),
  mediaType: AnyMediaType,
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  artistId: z.number().int().optional(),
  albumIds: z.array(z.number().int()).optional(),
  authorId: z.number().int().optional(),
  bookIds: z.array(z.number().int()).optional(),
  quality: QualityModel,
  customFormatScore: z.number().int(),
  reason: PendingReason,
  added: z.string(),
  /** ISO-8601 time the release becomes eligible for grabbing. */
  eligibleAt: z.string(),
  /** Whole minutes until eligible (0 when due). */
  remainingMinutes: z.number().int(),
});
export type PendingRelease = z.infer<typeof PendingRelease>;

const OptionalInt = z.coerce.number().int().min(0).optional();

/** GET /release: interactive search for a library item. */
export const ReleaseSearchQuery = z
  .object({
    seriesId: OptionalInt,
    seasonNumber: OptionalInt,
    episodeId: OptionalInt,
    movieId: OptionalInt,
    /** Music: interactive search for one album (its artist is implied). */
    albumId: OptionalInt,
    /** Music: interactive search for an artist (discographies plus every wanted album). */
    artistId: OptionalInt,
    /** Audiobooks: interactive search for one book (its author is implied). */
    bookId: OptionalInt,
    /** Audiobooks: interactive search for an author (series packs plus every wanted book). */
    authorId: OptionalInt,
  })
  .refine(
    (q) =>
      q.seriesId !== undefined ||
      q.episodeId !== undefined ||
      q.movieId !== undefined ||
      q.albumId !== undefined ||
      q.artistId !== undefined ||
      q.bookId !== undefined ||
      q.authorId !== undefined,
    { message: 'seriesId, episodeId, movieId, albumId, artistId, bookId or authorId is required' },
  );
export type ReleaseSearchQuery = z.infer<typeof ReleaseSearchQuery>;

export const ReleaseSearchResponse = z.array(ReleaseDecision);
export type ReleaseSearchResponse = z.infer<typeof ReleaseSearchResponse>;

/** POST /release/push: a release announced by an external tool (Torznab-like fields). */
export const ReleasePushRequest = z.object({
  title: z.string().min(1),
  downloadUrl: z.string().min(1).optional(),
  magnetUrl: z.string().min(1).optional(),
  protocol: ReleaseProtocol,
  publishDate: z.string(),
  size: z.number().int().min(0).default(0),
  guid: z.string().optional(),
  infoUrl: z.string().optional(),
  infoHash: z.string().optional(),
  indexerId: z.number().int().optional(),
  indexer: z.string().optional(),
  seeders: z.number().int().optional(),
  leechers: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  downloadClientId: z.number().int().optional(),
});
export type ReleasePushRequest = z.infer<typeof ReleasePushRequest>;

export const ReleasePushResponse = z.object({
  decision: ReleaseDecision.nullable(),
  grabbed: z.boolean(),
  pending: z.boolean(),
});
export type ReleasePushResponse = z.infer<typeof ReleasePushResponse>;

/** POST /command/search: trigger an automatic search (user invoked). */
export const SearchCommandRequest = z
  .object({
    seriesId: z.number().int().optional(),
    seasonNumber: z.number().int().min(0).optional(),
    episodeIds: z.array(z.number().int()).optional(),
    movieId: z.number().int().optional(),
    /** Music: search the artist's wanted albums (or only `albumIds`). */
    artistId: z.number().int().optional(),
    albumIds: z.array(z.number().int()).optional(),
    /** Audiobooks: search the author's wanted books (or only `bookIds`). */
    authorId: z.number().int().optional(),
    bookIds: z.array(z.number().int()).optional(),
  })
  .refine(
    (q) =>
      q.seriesId !== undefined ||
      q.movieId !== undefined ||
      (q.episodeIds?.length ?? 0) > 0 ||
      q.artistId !== undefined ||
      (q.albumIds?.length ?? 0) > 0 ||
      q.authorId !== undefined ||
      (q.bookIds?.length ?? 0) > 0,
    { message: 'seriesId, episodeIds, movieId, artistId, albumIds, authorId or bookIds is required' },
  );
export type SearchCommandRequest = z.infer<typeof SearchCommandRequest>;

export const SearchCommandResponse = z.object({
  releases: z.number().int(),
  approved: z.number().int(),
  grabbed: z.array(z.string()),
  pending: z.number().int(),
  /** Items of the target left out because they are not released yet (release-dates.ts). */
  skippedUnreleased: z.number().int().optional(),
});
export type SearchCommandResponse = z.infer<typeof SearchCommandResponse>;

export const ReleasesErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type ReleasesErrorResponse = z.infer<typeof ReleasesErrorResponse>;

// ---- decision log -----------------------------------------------------------------------

/** Where a logged evaluation batch came from (coarser than `ReleaseSource`; `pending` = re-decided held releases). */
export const DecisionLogSource = z.enum(['rss', 'search', 'interactive', 'push', 'pending']);
export type DecisionLogSource = z.infer<typeof DecisionLogSource>;

/** One release as the engine judged it in one batch. */
export const DecisionLogEntry = z.object({
  id: z.number().int(),
  batchId: z.string(),
  /** ISO-8601 time of the batch. */
  time: z.string(),
  source: DecisionLogSource,
  mediaType: AnyMediaType.nullable(),
  seriesId: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  movieId: z.number().int().nullable(),
  /** Music rows: the artist and the albums the release mapped to (absent on video rows). */
  artistId: z.number().int().nullable().optional(),
  albumIds: z.array(z.number().int()).optional(),
  /** Audiobook rows: the author and the books the release mapped to (absent on other rows). */
  authorId: z.number().int().nullable().optional(),
  bookIds: z.array(z.number().int()).optional(),
  guid: z.string(),
  indexerId: z.number().int(),
  title: z.string(),
  quality: QualityModel,
  formats: z.array(z.object({ id: z.number().int(), name: z.string() })),
  score: z.number().int(),
  approved: z.boolean(),
  rejections: z.array(ReleaseRejection),
  /** The release was grabbed from this batch. */
  chosen: z.boolean(),
  /** 1-based position in the engine's preference order among the batch's releases for the same item; null when unranked (unmatched). */
  rank: z.number().int().nullable(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;

/** One evaluation batch, decisions in rank order. */
export const DecisionLogBatch = z.object({
  batchId: z.string(),
  time: z.string(),
  source: DecisionLogSource,
  /** Rows in this batch (for the item when listed per item). */
  total: z.number().int(),
  approved: z.number().int(),
  /** True when a release of this batch was grabbed. */
  grabbed: z.boolean(),
  /** The grabbed row, else the best-ranked approved row; null when nothing qualified. */
  winnerId: z.number().int().nullable(),
  decisions: z.array(DecisionLogEntry),
});
export type DecisionLogBatch = z.infer<typeof DecisionLogBatch>;

/** GET /release/decisions: exactly one of seriesId, episodeId, movieId, artistId, albumId, authorId, bookId. */
export const DecisionLogQuery = z
  .object({
    seriesId: z.coerce.number().int().min(1).optional(),
    episodeId: z.coerce.number().int().min(1).optional(),
    movieId: z.coerce.number().int().min(1).optional(),
    artistId: z.coerce.number().int().min(1).optional(),
    albumId: z.coerce.number().int().min(1).optional(),
    authorId: z.coerce.number().int().min(1).optional(),
    bookId: z.coerce.number().int().min(1).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
  })
  .refine((q) => [q.seriesId, q.episodeId, q.movieId, q.artistId, q.albumId, q.authorId, q.bookId].filter((v) => v !== undefined).length === 1, {
    message: 'exactly one of seriesId, episodeId, movieId, artistId, albumId, authorId or bookId is required',
  });
export type DecisionLogQuery = z.infer<typeof DecisionLogQuery>;

export const DecisionLogPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(DecisionLogBatch),
});
export type DecisionLogPage = z.infer<typeof DecisionLogPage>;

// ---------------------------------------------------------------------------------------
// Search status (GET /release/searchstatus): when an episode / movie was last searched, what
// came of it, and when the scheduled searches will look for it next.
// ---------------------------------------------------------------------------------------

/** Episode, movie, album or book: the units the scheduled searches track. */
export const SearchItemType = z.enum(['episode', 'movie', 'album', 'book']);
export type SearchItemType = z.infer<typeof SearchItemType>;

/** `automatic`: a scheduled job (Missing, Cutoff unmet, profile migration); `manual`: a user's "Search". */
export const SearchRunSource = z.enum(['automatic', 'manual', 'interactive']);
export type SearchRunSource = z.infer<typeof SearchRunSource>;

/**
 * What one search did for one item: `grabbed` a release went to the download client;
 * `pending` an approved release is held (delay profile, client unavailable); `found` approved
 * releases but nothing grabbed (interactive search: the user picks); `rejected` releases came
 * back for the item but every one was rejected (`detail` = the most common reason);
 * `noResults` nothing came back for the item; `error` the search failed (`detail` = message).
 */
export const SearchOutcome = z.enum(['grabbed', 'pending', 'found', 'rejected', 'noResults', 'error']);
export type SearchOutcome = z.infer<typeof SearchOutcome>;

export const LastSearch = z.object({
  /** ISO-8601. */
  time: z.string(),
  source: SearchRunSource,
  outcome: SearchOutcome,
  /** Releases evaluated for the item, and how many of them were approved. */
  releases: z.number().int(),
  approved: z.number().int(),
  /** grabbed / pending: the release title; rejected: the top rejection reason; error: the message. */
  detail: z.string().nullable(),
});
export type LastSearch = z.infer<typeof LastSearch>;

/**
 * Whether the scheduled searches will look for the item: `scheduled` (missing or below the
 * cutoff; `nextSearchAt` is an estimate), `unmonitored` (never searched automatically),
 * `notAvailable` (not aired, or not released under its minimum availability, yet), `special`
 * (season 0: the scheduled searches skip specials), `satisfied` (has a file that meets the
 * cutoff), `jobDisabled` (the job that would search it is switched off).
 */
export const AutomaticSearchState = z.enum(['scheduled', 'unmonitored', 'notAvailable', 'special', 'satisfied', 'jobDisabled']);
export type AutomaticSearchState = z.infer<typeof AutomaticSearchState>;

export const AutomaticSearchPlan = z.object({
  state: AutomaticSearchState,
  /** The job that searches the item: MissingEpisodeSearch, MissingMovieSearch, MissingAlbumSearch, CutoffUnmetSearch or CutoffUnmetAudioSearch. */
  job: z.string().nullable(),
  /**
   * ISO-8601 estimate of the run that will search the item, from the job's schedule, the
   * per-item back-off and the per-run limit; null when not scheduled or more than two weeks out.
   */
  nextSearchAt: z.string().nullable(),
  /** Automatic searches since the last grab; each adds a day of back-off (at most 7). */
  searchCount: z.number().int(),
  /** Due runs of the job that pass before this item's turn because of the per-run limit (0 = the first due run). */
  runsAhead: z.number().int(),
});
export type AutomaticSearchPlan = z.infer<typeof AutomaticSearchPlan>;

export const ItemSearchStatus = z.object({
  mediaType: SearchItemType,
  id: z.number().int(),
  monitored: z.boolean(),
  lastSearch: LastSearch.nullable(),
  automatic: AutomaticSearchPlan,
});
export type ItemSearchStatus = z.infer<typeof ItemSearchStatus>;

/** GET /release/searchstatus?mediaType=episode&ids=1,2,3 (1–500 ids; unknown ids are left out). */
export const SearchStatusQuery = z.object({
  mediaType: SearchItemType,
  ids: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter((s) => s.trim() !== '') : v),
    z.array(z.coerce.number().int().min(1)).min(1).max(500),
  ),
});
export type SearchStatusQuery = z.infer<typeof SearchStatusQuery>;
