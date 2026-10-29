import { z } from 'zod';
import { AudioMediaType, Paged, Ratings, SortOrder } from './library.js';
import { QualityModel } from './quality.js';
import { SECRET_MASK } from './settings.js';

// The music contract (docs/design/music-audiobooks.md sections 4.3, 5.1, 9): artists, albums
// (MusicBrainz release groups), album releases (editions), tracks, audio files, album-type
// profiles, the add/list/details API and the music settings sections. Ids from MusicBrainz are
// lower-case UUID strings (MBIDs). Dates follow the library rules: ISO-8601 strings, date-only
// `YYYY-MM-DD` (or `YYYY` / `YYYY-MM` when MusicBrainz knows no more) for release dates.

const isoDate = () => z.string().describe('ISO-8601 date or timestamp');
const idList = () => z.array(z.number().int().positive());
/**
 * Query-string boolean: `true`/`false`/`1`/`0` (and real booleans from typed callers).
 * `z.coerce.boolean()` would read the string "false" as true.
 */
const qsBool = () => z.union([z.boolean(), z.stringbool()]);

/** A MusicBrainz identifier (UUID). Stored lower-case. */
export const Mbid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a MusicBrainz id (UUID)')
  .transform((s) => s.toLowerCase());
export type Mbid = z.infer<typeof Mbid>;

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

export const ArtistStatus = z.enum(['continuing', 'ended']);
export type ArtistStatus = z.infer<typeof ArtistStatus>;

/** MusicBrainz artist type. */
export const ArtistType = z.enum(['Person', 'Group', 'Orchestra', 'Choir', 'Character', 'Other']);
export type ArtistType = z.infer<typeof ArtistType>;

/** MusicBrainz release-group primary type. Anything else MusicBrainz invents maps to `Other`. */
export const AlbumPrimaryType = z.enum(['Album', 'EP', 'Single', 'Broadcast', 'Other']);
export type AlbumPrimaryType = z.infer<typeof AlbumPrimaryType>;

/** MusicBrainz release-group secondary types. Unknown values are dropped when mapping. */
export const AlbumSecondaryType = z.enum([
  'Compilation',
  'Soundtrack',
  'Spokenword',
  'Interview',
  'Audiobook',
  'Audio drama',
  'Live',
  'Remix',
  'DJ-mix',
  'Mixtape/Street',
  'Demo',
  'Field recording',
]);
export type AlbumSecondaryType = z.infer<typeof AlbumSecondaryType>;

/** MusicBrainz release status. */
export const AlbumReleaseStatus = z.enum(['Official', 'Promotion', 'Bootleg', 'Pseudo-Release', 'Withdrawn', 'Cancelled']);
export type AlbumReleaseStatus = z.infer<typeof AlbumReleaseStatus>;

/** What a metadata refresh does with release groups that are new since the last refresh. */
export const MonitorNewAlbums = z.enum(['all', 'none', 'future']);
export type MonitorNewAlbums = z.infer<typeof MonitorNewAlbums>;

/** How album monitored flags are set when an artist is added or re-monitored (like `MonitorOption`). */
export const MusicMonitorOption = z.enum(['all', 'future', 'missing', 'existing', 'latest', 'first', 'none']);
export type MusicMonitorOption = z.infer<typeof MusicMonitorOption>;

// ---------------------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------------------

export const MusicImageType = z.enum(['cover', 'disc', 'poster', 'fanart', 'banner', 'logo', 'clearlogo']);
export type MusicImageType = z.infer<typeof MusicImageType>;

export const MusicImage = z.object({
  coverType: MusicImageType,
  /** Local cached URL once fetched; remote URL until then. */
  url: z.string(),
  remoteUrl: z.string().nullish(),
});
export type MusicImage = z.infer<typeof MusicImage>;

/** An external link from MusicBrainz url-relations (`official homepage`, `wikidata`, `discogs` ...). */
export const ArtistLink = z.object({
  name: z.string(),
  url: z.string(),
});
export type ArtistLink = z.infer<typeof ArtistLink>;

export const ReleaseLabel = z.object({
  name: z.string(),
  catalogNumber: z.string().nullish(),
});
export type ReleaseLabel = z.infer<typeof ReleaseLabel>;

/** One medium (disc, side set, digital medium) of a release. */
export const ReleaseMedium = z.object({
  position: z.number().int().min(1),
  /** MusicBrainz medium format: `CD`, `Digital Media`, `12" Vinyl`, `SACD` ... */
  format: z.string().nullish(),
  name: z.string().nullish(),
  trackCount: z.number().int().min(0),
});
export type ReleaseMedium = z.infer<typeof ReleaseMedium>;

// ---------------------------------------------------------------------------------------
// Album-type profiles: which release groups become album rows
// ---------------------------------------------------------------------------------------

/**
 * A release group is kept when its primary type is listed, every one of its secondary types is
 * listed (so an empty list keeps only groups without secondary types), and at least one of its
 * releases has a listed status.
 */
export const AlbumTypeProfileInput = z.object({
  name: z.string().trim().min(1).max(100),
  primaryTypes: z.array(AlbumPrimaryType).min(1),
  secondaryTypes: z.array(AlbumSecondaryType).default([]),
  releaseStatuses: z.array(AlbumReleaseStatus).min(1).default(['Official']),
  /** The profile new artists get when the add request names none. Exactly one profile is the default. */
  isDefault: z.boolean().default(false),
});
export type AlbumTypeProfileInput = z.infer<typeof AlbumTypeProfileInput>;

export const AlbumTypeProfile = AlbumTypeProfileInput.extend({ id: z.number().int().min(1) });
export type AlbumTypeProfile = z.infer<typeof AlbumTypeProfile>;

/** The profiles every install starts with. */
export function defaultAlbumTypeProfiles(): AlbumTypeProfileInput[] {
  return [
    {
      name: 'Studio albums',
      primaryTypes: ['Album', 'EP'],
      secondaryTypes: [],
      releaseStatuses: ['Official'],
      isDefault: true,
    },
    {
      name: 'Everything',
      primaryTypes: [...AlbumPrimaryType.options],
      secondaryTypes: [...AlbumSecondaryType.options],
      releaseStatuses: [...AlbumReleaseStatus.options],
      isDefault: false,
    },
  ];
}

/** Pure check used by refresh: does this release group pass the profile? */
export function albumPassesTypeProfile(
  profile: Pick<AlbumTypeProfile, 'primaryTypes' | 'secondaryTypes' | 'releaseStatuses'>,
  group: { primaryType: AlbumPrimaryType; secondaryTypes: readonly AlbumSecondaryType[]; releaseStatuses?: readonly AlbumReleaseStatus[] },
): boolean {
  if (!profile.primaryTypes.includes(group.primaryType)) return false;
  if (!group.secondaryTypes.every((t) => profile.secondaryTypes.includes(t))) return false;
  // Statuses are unknown until the releases are browsed; the group is kept until then.
  if (group.releaseStatuses === undefined || group.releaseStatuses.length === 0) return true;
  return group.releaseStatuses.some((s) => profile.releaseStatuses.includes(s));
}

// ---------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------

export const AlbumStatistics = z.object({
  /** Tracks stored for the selected release. The denominator for percent and for "missing". */
  trackCount: z.number().int(),
  trackFileCount: z.number().int(),
  /** Track count MusicBrainz reports for the selected release (tracks are loaded lazily, so it may exceed `trackCount`). */
  totalTrackCount: z.number().int(),
  sizeOnDisk: z.number().int(),
  percentOfTracks: z.number(),
});
export type AlbumStatistics = z.infer<typeof AlbumStatistics>;

export const ArtistStatistics = AlbumStatistics.extend({
  albumCount: z.number().int(),
  monitoredAlbumCount: z.number().int(),
  /** Albums with every track of the selected release on disk. */
  completeAlbumCount: z.number().int(),
});
export type ArtistStatistics = z.infer<typeof ArtistStatistics>;

// ---------------------------------------------------------------------------------------
// Artists / albums / releases / tracks
// ---------------------------------------------------------------------------------------

export const Artist = z.object({
  id: z.number().int(),
  mbArtistId: z.string(),
  name: z.string(),
  sortName: z.string(),
  cleanName: z.string(),
  disambiguation: z.string().nullish(),
  artistType: ArtistType.nullish(),
  status: ArtistStatus,
  overview: z.string(),
  genres: z.array(z.string()),
  images: z.array(MusicImage),
  links: z.array(ArtistLink),
  aliases: z.array(z.string()),
  path: z.string(),
  rootFolderPath: z.string(),
  /** A `music` domain quality profile. */
  qualityProfileId: z.number().int(),
  albumTypeProfileId: z.number().int(),
  monitored: z.boolean(),
  monitorNewAlbums: MonitorNewAlbums,
  tags: z.array(z.number().int()),
  added: isoDate(),
  lastRefreshed: isoDate().nullish(),
  nextRefreshAt: isoDate().nullish(),
  statistics: ArtistStatistics.nullish(),
});
export type Artist = z.infer<typeof Artist>;

export const AlbumRelease = z.object({
  id: z.number().int(),
  albumId: z.number().int(),
  mbReleaseId: z.string(),
  title: z.string(),
  status: AlbumReleaseStatus.nullish(),
  /** ISO 3166-1 alpha-2, or MusicBrainz `XW` (worldwide) / `XE` (Europe). */
  country: z.string().nullish(),
  date: z.string().nullish(),
  labels: z.array(ReleaseLabel),
  catalogNumber: z.string().nullish(),
  barcode: z.string().nullish(),
  /** Distinct medium formats, e.g. `["CD"]`, `["Digital Media"]`. */
  formats: z.array(z.string()),
  mediumCount: z.number().int().min(0),
  trackCount: z.number().int().min(0),
  durationMs: z.number().int().nullish(),
  media: z.array(ReleaseMedium),
  disambiguation: z.string().nullish(),
});
export type AlbumRelease = z.infer<typeof AlbumRelease>;

export const Album = z.object({
  id: z.number().int(),
  artistId: z.number().int(),
  mbReleaseGroupId: z.string(),
  title: z.string(),
  cleanTitle: z.string(),
  disambiguation: z.string().nullish(),
  primaryType: AlbumPrimaryType,
  secondaryTypes: z.array(AlbumSecondaryType),
  /** First release date of the group (`YYYY-MM-DD`, or shorter when MusicBrainz knows no more). */
  releaseDate: z.string().nullish(),
  year: z.number().int().nullish(),
  overview: z.string(),
  genres: z.array(z.string()),
  images: z.array(MusicImage),
  ratings: Ratings,
  monitored: z.boolean(),
  /** An import may switch `selectedReleaseId` to a release that fits the files better. */
  anyReleaseOk: z.boolean(),
  /** The edition whose tracks are stored. Null until releases have been fetched. */
  selectedReleaseId: z.number().int().nullish(),
  added: isoDate(),
  lastRefreshed: isoDate().nullish(),
  statistics: AlbumStatistics.nullish(),
});
export type Album = z.infer<typeof Album>;

export const Track = z.object({
  id: z.number().int(),
  albumId: z.number().int(),
  albumReleaseId: z.number().int(),
  mbTrackId: z.string().nullish(),
  mbRecordingId: z.string().nullish(),
  mediumNumber: z.number().int().min(1),
  /** Position across all media of the release (1-based). */
  absoluteNumber: z.number().int().min(1),
  /** Position on its medium (1-based). */
  trackNumber: z.number().int().min(1),
  title: z.string(),
  durationMs: z.number().int().nullish(),
  /** Credited artist(s) when they differ from the album artist (features, VA). */
  artistCredit: z.string().nullish(),
  hasFile: z.boolean(),
  audioFileId: z.number().int().nullish(),
});
export type Track = z.infer<typeof Track>;

// ---------------------------------------------------------------------------------------
// Audio files (shared by music and audiobooks; table `audio_files`)
// ---------------------------------------------------------------------------------------

/** Text tags as read from the file (normalised by the tag reader); all optional. */
export const AudioFileTags = z.object({
  title: z.string().nullish(),
  artist: z.string().nullish(),
  albumArtist: z.string().nullish(),
  album: z.string().nullish(),
  date: z.string().nullish(),
  trackNo: z.number().int().nullish(),
  trackOf: z.number().int().nullish(),
  discNo: z.number().int().nullish(),
  discOf: z.number().int().nullish(),
  mbRecordingId: z.string().nullish(),
  mbReleaseId: z.string().nullish(),
  mbReleaseGroupId: z.string().nullish(),
  mbArtistId: z.string().nullish(),
  asin: z.string().nullish(),
  isbn: z.string().nullish(),
  narrator: z.string().nullish(),
  series: z.string().nullish(),
  seriesPart: z.string().nullish(),
  genre: z.array(z.string()).nullish(),
});
export type AudioFileTags = z.infer<typeof AudioFileTags>;

/** Technical details beyond the indexed columns of `audio_files`. */
export const AudioMediaInfo = z.object({
  /** Which reader produced the row. */
  source: z.enum(['music-metadata', 'ffprobe']).nullish(),
  codecProfile: z.string().nullish(),
  encoder: z.string().nullish(),
  lossless: z.boolean().nullish(),
  vbr: z.boolean().nullish(),
  replayGainTrackDb: z.number().nullish(),
  replayGainAlbumDb: z.number().nullish(),
  /** Audiobooks: chapter titles and start offsets. */
  chapters: z.array(z.object({ title: z.string(), startMs: z.number().int().min(0) })).nullish(),
});
export type AudioMediaInfo = z.infer<typeof AudioMediaInfo>;

export const AudioFile = z.object({
  id: z.number().int(),
  mediaType: AudioMediaType,
  artistId: z.number().int().nullish(),
  albumId: z.number().int().nullish(),
  authorId: z.number().int().nullish(),
  bookId: z.number().int().nullish(),
  path: z.string(),
  relativePath: z.string().describe('relative to the artist/author folder'),
  sizeBytes: z.number().int(),
  dateAdded: isoDate(),
  /** File modified time when it was last read; a rescan re-reads tags when it changes. */
  mtime: isoDate().nullish(),
  quality: QualityModel,
  releaseGroup: z.string().nullish(),
  sceneName: z.string().nullish(),
  codec: z.string().nullish(),
  container: z.string().nullish(),
  bitrateKbps: z.number().int().nullish(),
  sampleRateHz: z.number().int().nullish(),
  bitDepth: z.number().int().nullish(),
  channels: z.number().int().nullish(),
  durationMs: z.number().int().nullish(),
  discNumber: z.number().int().nullish(),
  trackNumber: z.number().int().nullish(),
  /** Audiobooks: part number of a multi-file book. */
  partNumber: z.number().int().nullish(),
  chapterCount: z.number().int().nullish(),
  tags: AudioFileTags.nullish(),
  mediaInfo: AudioMediaInfo.nullish(),
});
export type AudioFile = z.infer<typeof AudioFile>;

export const AudioFileListQuery = z
  .object({
    artistId: z.coerce.number().int().optional(),
    albumId: z.coerce.number().int().optional(),
  })
  .refine((q) => q.artistId !== undefined || q.albumId !== undefined, { message: 'artistId or albumId is required' });
export type AudioFileListQuery = z.infer<typeof AudioFileListQuery>;

// ---------------------------------------------------------------------------------------
// API: add / update / list / details
// ---------------------------------------------------------------------------------------

export const AddArtistRequest = z.object({
  mbArtistId: Mbid,
  rootFolderPath: z.string().min(1),
  /** Must be a `music` domain quality profile. */
  qualityProfileId: z.number().int(),
  /** Omitted: the default album-type profile ("Studio albums" on a fresh install). */
  albumTypeProfileId: z.number().int().optional(),
  monitored: z.boolean().default(true),
  monitorOption: MusicMonitorOption.default('all'),
  monitorNewAlbums: MonitorNewAlbums.default('all'),
  tags: z.array(z.number().int()).default([]),
  /** Wave 2: search for monitored missing albums once tracks are loaded. Ignored before that. */
  searchOnAdd: z.boolean().default(false),
});
export type AddArtistRequest = z.infer<typeof AddArtistRequest>;
export type AddArtistRequestInput = z.input<typeof AddArtistRequest>;

export const UpdateArtistRequest = z.object({
  monitored: z.boolean().optional(),
  monitorNewAlbums: MonitorNewAlbums.optional(),
  /** Re-applies this option to every album of the artist. */
  monitorOption: MusicMonitorOption.optional(),
  qualityProfileId: z.number().int().optional(),
  albumTypeProfileId: z.number().int().optional(),
  rootFolderPath: z.string().min(1).optional(),
  /** Set explicitly to override the generated `<root>/<Artist Name>` folder. */
  path: z.string().min(1).optional(),
  tags: z.array(z.number().int()).optional(),
});
export type UpdateArtistRequest = z.infer<typeof UpdateArtistRequest>;

export const UpdateAlbumRequest = z.object({
  monitored: z.boolean().optional(),
  anyReleaseOk: z.boolean().optional(),
  /** Switch the edition; tracks are re-fetched and re-linked by recording id, then position. */
  selectedReleaseId: z.number().int().optional(),
});
export type UpdateAlbumRequest = z.infer<typeof UpdateAlbumRequest>;

export const BulkAlbumMonitorRequest = z.object({
  albumIds: idList().min(1),
  monitored: z.boolean(),
});
export type BulkAlbumMonitorRequest = z.infer<typeof BulkAlbumMonitorRequest>;

export const BulkArtistUpdateRequest = z.object({
  ids: idList().min(1),
  monitored: z.boolean().optional(),
  monitorOption: MusicMonitorOption.optional(),
  monitorNewAlbums: MonitorNewAlbums.optional(),
  qualityProfileId: z.number().int().optional(),
  albumTypeProfileId: z.number().int().optional(),
  rootFolderPath: z.string().min(1).optional(),
  tags: z
    .object({ add: z.array(z.number().int()).optional(), remove: z.array(z.number().int()).optional() })
    .optional(),
  refresh: z.boolean().optional(),
});
export type BulkArtistUpdateRequest = z.infer<typeof BulkArtistUpdateRequest>;

export const DeleteArtistQuery = z.object({
  deleteFiles: qsBool().default(false),
  addExclusion: qsBool().default(false),
});
export type DeleteArtistQuery = z.infer<typeof DeleteArtistQuery>;

export const ArtistSortKey = z.enum(['sortName', 'added', 'status', 'qualityProfileId', 'path', 'sizeOnDisk']);
export type ArtistSortKey = z.infer<typeof ArtistSortKey>;

export const ArtistListQuery = z.object({
  monitored: qsBool().optional(),
  status: ArtistStatus.optional(),
  qualityProfileId: z.coerce.number().int().optional(),
  albumTypeProfileId: z.coerce.number().int().optional(),
  rootFolderPath: z.string().optional(),
  tag: z.coerce.number().int().optional(),
  mbArtistId: z.string().optional(),
  /** Case-insensitive substring match on name and aliases. */
  search: z.string().optional(),
  includeStatistics: qsBool().default(true),
  sortKey: ArtistSortKey.default('sortName'),
  sortOrder: SortOrder.default('asc'),
});
export type ArtistListQuery = z.infer<typeof ArtistListQuery>;

/** GET /api/v1/artist. */
export const ArtistListResponse = z.array(Artist);
export type ArtistListResponse = z.infer<typeof ArtistListResponse>;

export const AlbumListQuery = z.object({
  artistId: z.coerce.number().int().optional(),
  monitored: qsBool().optional(),
  mbReleaseGroupId: z.string().optional(),
  includeStatistics: qsBool().default(true),
});
export type AlbumListQuery = z.infer<typeof AlbumListQuery>;

/** GET /api/v1/album. */
export const AlbumListResponse = z.array(Album);
export type AlbumListResponse = z.infer<typeof AlbumListResponse>;

/** GET /api/v1/artist/:id: the artist with its albums (grouped by type in the UI). */
export const ArtistDetails = Artist.extend({
  albums: z.array(Album),
});
export type ArtistDetails = z.infer<typeof ArtistDetails>;

/** The artist fields an album page needs. */
export const ArtistSummary = Artist.pick({ id: true, mbArtistId: true, name: true, sortName: true, path: true, images: true });
export type ArtistSummary = z.infer<typeof ArtistSummary>;

/** GET /api/v1/album/:id: the album with its editions, the selected edition's tracks and files. */
export const AlbumDetails = Album.extend({
  artist: ArtistSummary,
  releases: z.array(AlbumRelease),
  tracks: z.array(Track),
  files: z.array(AudioFile),
});
export type AlbumDetails = z.infer<typeof AlbumDetails>;

// ---------------------------------------------------------------------------------------
// Wanted (read-only in Wave 1)
// ---------------------------------------------------------------------------------------

export const WantedAlbumsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type WantedAlbumsQuery = z.infer<typeof WantedAlbumsQuery>;

export const WantedAlbum = Album.extend({
  artistName: z.string(),
  mbArtistId: z.string(),
  qualityProfileId: z.number().int(),
});
export type WantedAlbum = z.infer<typeof WantedAlbum>;

export const WantedAlbumsPage = Paged(WantedAlbum);
export type WantedAlbumsPage = z.infer<typeof WantedAlbumsPage>;

// ---------------------------------------------------------------------------------------
// Commands (POST /api/v1/command, answered 202 with the started Job)
// ---------------------------------------------------------------------------------------

/**
 * Music commands. `RefreshArtist` re-fetches metadata (and new release groups) for the
 * artists; `RescanArtist` re-reads their folders into `audio_files`. `ArtistSearch` /
 * `AlbumSearch` are accepted but only report "not available yet" until Wave 2.
 */
export const MusicCommand = z.discriminatedUnion('name', [
  z.object({ name: z.literal('RefreshArtist'), artistIds: idList().min(1) }),
  z.object({ name: z.literal('RescanArtist'), artistIds: idList().min(1) }),
  z.object({ name: z.literal('ArtistSearch'), artistIds: idList().min(1) }),
  z.object({ name: z.literal('AlbumSearch'), albumIds: idList().min(1) }),
]);
export type MusicCommand = z.infer<typeof MusicCommand>;
export type MusicCommandName = MusicCommand['name'];

// ---------------------------------------------------------------------------------------
// Lookup (MusicBrainz search)
// ---------------------------------------------------------------------------------------

export const ArtistLookupQuery = z.object({
  term: z.string().trim().min(1),
});
export type ArtistLookupQuery = z.infer<typeof ArtistLookupQuery>;

export const ArtistSearchResult = z.object({
  mbArtistId: z.string(),
  name: z.string(),
  sortName: z.string(),
  disambiguation: z.string().nullish(),
  artistType: ArtistType.nullish(),
  /** ISO 3166-1 alpha-2 of the artist's area, when known. */
  country: z.string().nullish(),
  /** Life span / active years as MusicBrainz gives them. */
  beginDate: z.string().nullish(),
  endDate: z.string().nullish(),
  ended: z.boolean().nullish(),
  genres: z.array(z.string()),
  images: z.array(MusicImage),
  /** MusicBrainz search score, 0-100. */
  score: z.number().int().min(0).max(100),
  /** Set when the artist is already in the library. */
  artistId: z.number().int().nullish(),
});
export type ArtistSearchResult = z.infer<typeof ArtistSearchResult>;

export const ArtistSearchResponse = z.array(ArtistSearchResult);
export type ArtistSearchResponse = z.infer<typeof ArtistSearchResponse>;

export const ReleaseGroupLookupQuery = z
  .object({
    /** Free text. */
    term: z.string().trim().min(1).optional(),
    artist: z.string().trim().min(1).optional(),
    album: z.string().trim().min(1).optional(),
  })
  .refine((q) => q.term !== undefined || q.album !== undefined, { message: 'term or album is required' });
export type ReleaseGroupLookupQuery = z.infer<typeof ReleaseGroupLookupQuery>;

export const ReleaseGroupSearchResult = z.object({
  mbReleaseGroupId: z.string(),
  title: z.string(),
  disambiguation: z.string().nullish(),
  primaryType: AlbumPrimaryType.nullish(),
  secondaryTypes: z.array(AlbumSecondaryType),
  firstReleaseDate: z.string().nullish(),
  year: z.number().int().nullish(),
  /** The credited artist (first credit). */
  artistName: z.string(),
  mbArtistId: z.string().nullish(),
  images: z.array(MusicImage),
  score: z.number().int().min(0).max(100),
  /** Set when the album is already in the library. */
  albumId: z.number().int().nullish(),
  artistId: z.number().int().nullish(),
});
export type ReleaseGroupSearchResult = z.infer<typeof ReleaseGroupSearchResult>;

export const ReleaseGroupSearchResponse = z.array(ReleaseGroupSearchResult);
export type ReleaseGroupSearchResponse = z.infer<typeof ReleaseGroupSearchResponse>;

// ---------------------------------------------------------------------------------------
// Settings: musicMetadata, audio
// ---------------------------------------------------------------------------------------

export const MUSICBRAINZ_DEFAULT_BASE_URL = 'https://musicbrainz.org/ws/2/';

/**
 * Stored form of the `musicMetadata` section. The MusicBrainz client is locked to 1 request per
 * second against the default host whatever `rateLimitPerSecond` says; a self-hosted mirror
 * (custom `baseUrl`) may go faster.
 */
export const MusicMetadataSettings = z.object({
  baseUrl: z.string().url().default(MUSICBRAINZ_DEFAULT_BASE_URL),
  /** Contact address in the User-Agent MusicBrainz asks for. Optional; the project URL is always sent. */
  contactEmail: z.string().email().optional(),
  rateLimitPerSecond: z.number().min(0.1).max(50).default(1),
  /** Fanart.tv personal API key; artist images fall back to Wikidata/Commons without it. */
  fanartApiKey: z.string().min(1).optional(),
  /** Release choice: preferred countries in order (ISO 3166-1 alpha-2, plus `XW` worldwide). */
  preferredCountries: z.array(z.string().trim().min(2).max(2).toUpperCase()).default(['XW', 'US', 'GB']),
  /** Release choice: preferred medium formats in order (MusicBrainz names). */
  preferredFormats: z.array(z.string().trim().min(1)).default(['Digital Media', 'CD']),
});
export type MusicMetadataSettings = z.infer<typeof MusicMetadataSettings>;
export type MusicMetadataSettingsInput = z.input<typeof MusicMetadataSettings>;

/** GET /api/v1/settings/musicmetadata. `fanartApiKey` is SECRET_MASK when a key is stored, null otherwise. */
export const MusicMetadataSettingsResponse = MusicMetadataSettings.omit({ fanartApiKey: true, contactEmail: true }).extend({
  contactEmail: z.string().nullable(),
  fanartApiKey: z.string().nullable(),
});
export type MusicMetadataSettingsResponse = z.infer<typeof MusicMetadataSettingsResponse>;

/**
 * PUT /api/v1/settings/musicmetadata. `fanartApiKey`: SECRET_MASK or omitted keeps the stored
 * key, null or '' clears it, any other string replaces it. `contactEmail`: null or '' clears it.
 */
export const MusicMetadataSettingsUpdate = z.object({
  baseUrl: z.string().url().optional(),
  contactEmail: z.union([z.string().email(), z.literal('')]).nullable().optional(),
  rateLimitPerSecond: z.number().min(0.1).max(50).optional(),
  fanartApiKey: z.string().nullable().optional(),
  preferredCountries: z.array(z.string().trim().min(2).max(2).toUpperCase()).optional(),
  preferredFormats: z.array(z.string().trim().min(1)).optional(),
});
export type MusicMetadataSettingsUpdate = z.infer<typeof MusicMetadataSettingsUpdate>;

/** Mask the stored section for the API. */
export function maskMusicMetadataSettings(value: MusicMetadataSettings): MusicMetadataSettingsResponse {
  return {
    baseUrl: value.baseUrl,
    contactEmail: value.contactEmail ?? null,
    rateLimitPerSecond: value.rateLimitPerSecond,
    fanartApiKey: value.fanartApiKey ? SECRET_MASK : null,
    preferredCountries: value.preferredCountries,
    preferredFormats: value.preferredFormats,
  };
}

/** Merge a client update onto the stored section (mask keeps the stored key). */
export function applyMusicMetadataUpdate(current: MusicMetadataSettings, update: MusicMetadataSettingsUpdate): MusicMetadataSettings {
  const next: MusicMetadataSettings = {
    baseUrl: update.baseUrl ?? current.baseUrl,
    rateLimitPerSecond: update.rateLimitPerSecond ?? current.rateLimitPerSecond,
    preferredCountries: update.preferredCountries ?? current.preferredCountries,
    preferredFormats: update.preferredFormats ?? current.preferredFormats,
  };
  const email = update.contactEmail === undefined ? current.contactEmail : update.contactEmail || undefined;
  if (email) next.contactEmail = email;
  const key = update.fanartApiKey;
  if (key === undefined || key === SECRET_MASK) {
    if (current.fanartApiKey) next.fanartApiKey = current.fanartApiKey;
  } else if (key !== null && key.trim() !== '') {
    next.fanartApiKey = key.trim();
  }
  return next;
}

/** Stored form of the `audio` section (audio import knobs); also the GET/PUT body of /settings/audio. */
export const AudioImportSettings = z.object({
  /** A file group maps to a release when its match score (0-1) reaches this. Below it: manual import. */
  trackMatchThreshold: z.number().min(0).max(1).default(0.8),
  /** Audiobooks: the files' total duration may differ from the book's runtime by this many percent. */
  audiobookDurationTolerance: z.number().min(0).max(100).default(5),
  /** Audiobooks: multi-file books are renamed with `bookPartFormat` even when `renameAudiobooks` is off. */
  renameAudiobookParts: z.boolean().default(true),
  /** Audiobooks: write `desc.txt`, `reader.txt` and `cover.jpg` (Audiobookshelf sidecars) into the book folder. */
  writeAbsSidecars: z.boolean().default(false),
});
export type AudioImportSettings = z.infer<typeof AudioImportSettings>;
export type AudioImportSettingsInput = z.input<typeof AudioImportSettings>;
