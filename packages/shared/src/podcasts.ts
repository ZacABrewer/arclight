import { z } from 'zod';
import { SECRET_MASK } from './settings.js';

// The podcast contract (docs/using/podcasts.md): subscriptions to RSS feeds, their episodes,
// per-podcast download and retention settings, the `podcasts` settings section, directory
// search (iTunes Search API, Podcast Index), OPML import/export and podcast suggestions from
// the request portal. Podcasts are their own section: they share no tables with music or
// audiobooks, never touch indexers or download clients, and are fetched over plain HTTP(S) from
// the publisher (through an indexer proxy when one applies). Dates are ISO-8601 strings.

const isoDate = () => z.string().describe('ISO-8601 date or timestamp');
const idList = () => z.array(z.number().int().positive());
/** Query-string boolean: `true`/`false`/`1`/`0` (and real booleans from typed callers). */
const qsBool = () => z.union([z.boolean(), z.stringbool()]);

/** An http(s) URL (feed, enclosure, image). */
export const HttpUrl = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

// ---------------------------------------------------------------------------------------
// Per-podcast settings
// ---------------------------------------------------------------------------------------

/**
 * Which enclosure to download when an episode offers several (the RSS `<enclosure>` plus
 * Podcasting 2.0 `<podcast:alternateEnclosure>`s): `feed` takes the RSS enclosure, `audio` /
 * `video` the first of that kind (falling back to the feed's), `smallest` / `largest` by the
 * advertised length.
 */
export const PodcastEnclosurePreference = z.enum(['feed', 'audio', 'video', 'smallest', 'largest']);
export type PodcastEnclosurePreference = z.infer<typeof PodcastEnclosurePreference>;

export const PodcastSubscriptionSettings = z.object({
  /** New episodes found by a feed poll are downloaded automatically. */
  autoDownload: z.boolean().default(true),
  /** When subscribing, also download this many of the newest existing episodes (0: none). */
  backlog: z.number().int().min(0).max(10_000).default(3),
  /** Keep only the newest N downloaded episodes; older files are deleted (null: keep all). */
  keepLast: z.number().int().min(1).max(10_000).nullable().default(null),
  /** Delete a downloaded episode this many days after it was played (null: never). */
  deletePlayedAfterDays: z.number().int().min(0).max(3650).nullable().default(null),
  enclosure: PodcastEnclosurePreference.default('feed'),
  /** Write title / podcast / date / description tags (ID3 for MP3, MP4 atoms for M4A) with ffmpeg. */
  writeTags: z.boolean().default(true),
  /** Embed the episode (or podcast) artwork into the file and save `cover.jpg` in the podcast folder. */
  embedCover: z.boolean().default(true),
  /** Fetch Podcasting 2.0 chapters (saved as `.chapters.json`, embedded when tags are written). */
  keepChapters: z.boolean().default(true),
  /** Fetch Podcasting 2.0 transcripts (saved next to the episode: `.vtt`, `.srt`, `.json`, `.html`, `.txt`). */
  keepTranscripts: z.boolean().default(true),
});
export type PodcastSubscriptionSettings = z.infer<typeof PodcastSubscriptionSettings>;
export type PodcastSubscriptionSettingsInput = z.input<typeof PodcastSubscriptionSettings>;

// ---------------------------------------------------------------------------------------
// Settings section `podcasts` (GET/PUT /settings/podcasts)
// ---------------------------------------------------------------------------------------

/** Tokens: {Podcast Title} {Podcast Author} {Episode Title} {Episode Date} {Episode Year} {Episode Month} {Episode Day} {Season} {Episode Number}. */
export const DEFAULT_PODCAST_EPISODE_FORMAT = '{Episode Year}/{Episode Date} - {Episode Title}';
export const DEFAULT_PODCAST_FOLDER_FORMAT = '{Podcast Title}';

export const PodcastSettings = z.object({
  /** Folder new podcasts are created under (each podcast gets `{rootFolder}/{folderFormat}`). */
  rootFolder: z.string().trim().max(1024).default(''),
  folderFormat: z.string().trim().min(1).max(512).default(DEFAULT_PODCAST_FOLDER_FORMAT),
  /** Episode path inside the podcast folder, without extension. */
  episodeFormat: z.string().trim().min(1).max(512).default(DEFAULT_PODCAST_EPISODE_FORMAT),
  /** How often feeds are polled. */
  refreshIntervalMinutes: z.number().int().min(15).max(10_080).default(60),
  /** A feed's `<ttl>` (minutes) stretches its interval when it is longer. */
  respectTtl: z.boolean().default(true),
  maxConcurrentDownloads: z.number().int().min(1).max(5).default(2),
  /** Applied to new subscriptions (each podcast keeps its own copy). */
  defaults: PodcastSubscriptionSettings.default(PodcastSubscriptionSettings.parse({})),
  /**
   * Indexer proxy (Settings → Indexer proxies, http or socks5) used for feeds and downloads.
   * A podcast tagged like a proxy uses that proxy instead. null: direct.
   */
  proxyId: z.number().int().positive().nullable().default(null),
  /** Podcast Index API key and secret (free at podcastindex.org); search falls back to iTunes without them. */
  podcastIndexKey: z.string().trim().max(256).nullable().default(null),
  podcastIndexSecret: z.string().trim().max(256).nullable().default(null),
  /** iTunes Search API storefront (two-letter country code). */
  itunesCountry: z.string().trim().regex(/^[a-z]{2}$/i).default('us'),
});
export type PodcastSettings = z.infer<typeof PodcastSettings>;
export type PodcastSettingsInput = z.input<typeof PodcastSettings>;

/** GET /settings/podcasts: the secret comes back as the mask when set. */
export const PodcastSettingsResponse = PodcastSettings;
export type PodcastSettingsResponse = PodcastSettings;

/** Mask the Podcast Index secret for responses. */
export function maskPodcastSettings(value: PodcastSettings): PodcastSettings {
  return { ...value, podcastIndexSecret: value.podcastIndexSecret ? SECRET_MASK : null };
}

/** Merge a PUT onto the stored section: the mask (or an omitted secret) keeps the stored one. */
export function applyPodcastSettingsUpdate(current: PodcastSettings, update: PodcastSettingsInput): PodcastSettings {
  const merged = PodcastSettings.parse({ ...current, ...update, defaults: { ...current.defaults, ...(update.defaults ?? {}) } });
  const secret = update.podcastIndexSecret;
  if (secret === undefined || secret === SECRET_MASK) merged.podcastIndexSecret = current.podcastIndexSecret;
  else if (secret === null || secret.trim() === '') merged.podcastIndexSecret = null;
  if (merged.podcastIndexKey === '') merged.podcastIndexKey = null;
  return merged;
}

// ---------------------------------------------------------------------------------------
// Podcasts
// ---------------------------------------------------------------------------------------

/** `active`: polled; `error`: the last poll failed (still polled); `gone`: the feed answered 410 / was removed (not polled). */
export const PodcastStatus = z.enum(['active', 'error', 'gone']);
export type PodcastStatus = z.infer<typeof PodcastStatus>;

export const PodcastStatistics = z.object({
  episodeCount: z.number().int(),
  downloadedCount: z.number().int(),
  playedCount: z.number().int(),
  wantedCount: z.number().int(),
  sizeOnDisk: z.number().int(),
  /** Newest episode's publication date. */
  lastEpisodeAt: isoDate().nullable(),
});
export type PodcastStatistics = z.infer<typeof PodcastStatistics>;

export const Podcast = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string(),
  author: z.string().nullable(),
  description: z.string(),
  /** The feed URL with any credentials masked (user info, secret query values, token-like path segments). */
  feedUrl: z.string(),
  /** The URL embeds credentials (a private / premium feed); never shown in full. */
  privateFeed: z.boolean(),
  /** Website (`<link>`). */
  link: z.string().nullable(),
  imageUrl: z.string().nullable(),
  language: z.string().nullable(),
  categories: z.array(z.string()),
  explicit: z.boolean(),
  /** `<itunes:type>`: episodic (newest first) or serial (in order). */
  feedType: z.enum(['episodic', 'serial']),
  /** `<podcast:guid>`. */
  podcastGuid: z.string().nullable(),
  itunesId: z.number().int().nullable(),
  podcastIndexId: z.number().int().nullable(),
  /** `<podcast:funding>` links. */
  funding: z.array(z.object({ url: z.string(), title: z.string() })),
  path: z.string(),
  /** Unmonitored podcasts are not polled and download nothing new. */
  monitored: z.boolean(),
  status: PodcastStatus,
  lastError: z.string().nullable(),
  settings: PodcastSubscriptionSettings,
  tags: z.array(z.number().int()),
  added: isoDate(),
  lastRefreshed: isoDate().nullable(),
  nextRefreshAt: isoDate().nullable(),
  /** `<ttl>` in minutes, when the feed sets one. */
  ttlMinutes: z.number().int().nullable(),
  statistics: PodcastStatistics,
});
export type Podcast = z.infer<typeof Podcast>;

export const PodcastListResponse = z.array(Podcast);
export type PodcastListResponse = z.infer<typeof PodcastListResponse>;

/** POST /podcast. `feedUrl` may embed credentials (user:pass@ or a token); it is stored as given. */
export const AddPodcastRequest = z.object({
  feedUrl: HttpUrl,
  /** Overrides of the `podcasts.defaults` settings for this podcast. */
  settings: PodcastSubscriptionSettings.partial().optional(),
  tags: idList().default([]),
  monitored: z.boolean().default(true),
  /** Directory ids from a search result (kept for links and de-duplication). */
  itunesId: z.number().int().positive().nullable().optional(),
  podcastIndexId: z.number().int().positive().nullable().optional(),
});
export type AddPodcastRequest = z.input<typeof AddPodcastRequest>;

/** PUT /podcast/:id. A `feedUrl` containing the mask keeps the stored URL. */
export const UpdatePodcastRequest = z.object({
  feedUrl: HttpUrl.optional(),
  settings: PodcastSubscriptionSettings.partial().optional(),
  tags: idList().optional(),
  monitored: z.boolean().optional(),
});
export type UpdatePodcastRequest = z.input<typeof UpdatePodcastRequest>;

export const DeletePodcastQuery = z.object({ deleteFiles: qsBool().default(false) });
export type DeletePodcastQuery = z.infer<typeof DeletePodcastQuery>;

// ---------------------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------------------

/**
 * `available`: in the feed, not downloaded (auto-download off, or older than the backlog);
 * `wanted`: waiting for the downloader; `downloading`; `downloaded`; `failed` (retried on the next
 * pass up to 3 times); `deleted`: the file was removed (by retention or by hand) and is not
 * fetched again unless asked.
 */
export const PodcastEpisodeStatus = z.enum(['available', 'wanted', 'downloading', 'downloaded', 'failed', 'deleted']);
export type PodcastEpisodeStatus = z.infer<typeof PodcastEpisodeStatus>;

export const PodcastEnclosure = z.object({
  url: z.string(),
  type: z.string().nullable(),
  length: z.number().int().nullable(),
  /** Alternate enclosures: `<podcast:alternateEnclosure title>` or bitrate. */
  title: z.string().nullable().optional(),
  bitrate: z.number().nullable().optional(),
});
export type PodcastEnclosure = z.infer<typeof PodcastEnclosure>;

export const PodcastTranscript = z.object({
  url: z.string(),
  type: z.string(),
  language: z.string().nullable(),
  rel: z.string().nullable(),
});
export type PodcastTranscript = z.infer<typeof PodcastTranscript>;

export const PodcastPerson = z.object({ name: z.string(), role: z.string().nullable(), href: z.string().nullable(), img: z.string().nullable() });
export type PodcastPerson = z.infer<typeof PodcastPerson>;

export const PodcastEpisode = z.object({
  id: z.number().int(),
  podcastId: z.number().int(),
  guid: z.string(),
  title: z.string(),
  description: z.string(),
  publishedAt: isoDate().nullable(),
  durationSeconds: z.number().int().nullable(),
  season: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  episodeType: z.enum(['full', 'trailer', 'bonus']),
  explicit: z.boolean(),
  imageUrl: z.string().nullable(),
  link: z.string().nullable(),
  /** The RSS enclosure; credentials masked like the feed URL. */
  enclosure: PodcastEnclosure.nullable(),
  alternateEnclosures: z.array(PodcastEnclosure),
  /** Podcasting 2.0 `<podcast:chapters>` URL. */
  chaptersUrl: z.string().nullable(),
  transcripts: z.array(PodcastTranscript),
  persons: z.array(PodcastPerson),
  status: PodcastEpisodeStatus,
  /** Downloaded file (absolute). */
  path: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  downloadedAt: isoDate().nullable(),
  /** Chapters were saved / embedded; transcripts saved (file names next to the episode). */
  hasChapters: z.boolean(),
  transcriptFiles: z.array(z.string()),
  played: z.boolean(),
  playedAt: isoDate().nullable(),
  /** Where `played` came from: marked by hand or read from a media server's listen history. */
  playedSource: z.enum(['manual', 'mediaServer']).nullable(),
  error: z.string().nullable(),
  /** Failed download attempts since the last success. */
  attempts: z.number().int(),
  added: isoDate(),
});
export type PodcastEpisode = z.infer<typeof PodcastEpisode>;

export const PodcastEpisodeSortKey = z.enum(['publishedAt', 'title', 'status', 'downloadedAt']);
export type PodcastEpisodeSortKey = z.infer<typeof PodcastEpisodeSortKey>;

/** GET /podcast/episode (every podcast) and GET /podcast/:id/episode. */
export const PodcastEpisodeQuery = z.object({
  podcastId: z.coerce.number().int().positive().optional(),
  status: PodcastEpisodeStatus.optional(),
  played: qsBool().optional(),
  /** Case-insensitive title match. */
  term: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sortKey: PodcastEpisodeSortKey.default('publishedAt'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
});
export type PodcastEpisodeQuery = z.input<typeof PodcastEpisodeQuery>;

/** An episode with its podcast's title and image (the all-episodes view). */
export const PodcastEpisodeRow = PodcastEpisode.extend({ podcastTitle: z.string(), podcastImageUrl: z.string().nullable() });
export type PodcastEpisodeRow = z.infer<typeof PodcastEpisodeRow>;

export const PodcastEpisodePage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(PodcastEpisodeRow),
});
export type PodcastEpisodePage = z.infer<typeof PodcastEpisodePage>;

/** PUT /podcast/episode/:id. */
export const UpdatePodcastEpisodeRequest = z.object({ played: z.boolean() });
export type UpdatePodcastEpisodeRequest = z.infer<typeof UpdatePodcastEpisodeRequest>;

export const PodcastEpisodeBulkAction = z.enum(['download', 'markPlayed', 'markUnplayed', 'deleteFile', 'skip']);
export type PodcastEpisodeBulkAction = z.infer<typeof PodcastEpisodeBulkAction>;

/** POST /podcast/episode/bulk. */
export const PodcastEpisodeBulkRequest = z.object({ ids: idList().min(1).max(1000), action: PodcastEpisodeBulkAction });
export type PodcastEpisodeBulkRequest = z.infer<typeof PodcastEpisodeBulkRequest>;

export const PodcastEpisodeBulkResult = z.object({ updated: z.number().int() });
export type PodcastEpisodeBulkResult = z.infer<typeof PodcastEpisodeBulkResult>;

// ---------------------------------------------------------------------------------------
// Directory search and feed preview
// ---------------------------------------------------------------------------------------

export const PodcastSearchSource = z.enum(['itunes', 'podcastindex']);
export type PodcastSearchSource = z.infer<typeof PodcastSearchSource>;

/** GET /podcast/lookup (admins) and /podcast/search (request portal). */
export const PodcastSearchQuery = z.object({
  term: z.string().trim().min(1).max(200),
  /** Default: Podcast Index when its key is set, else iTunes. */
  source: PodcastSearchSource.optional(),
});
export type PodcastSearchQuery = z.infer<typeof PodcastSearchQuery>;

export const PodcastSearchResult = z.object({
  source: PodcastSearchSource,
  title: z.string(),
  author: z.string().nullable(),
  feedUrl: z.string(),
  imageUrl: z.string().nullable(),
  description: z.string().nullable(),
  categories: z.array(z.string()),
  episodeCount: z.number().int().nullable(),
  itunesId: z.number().int().nullable(),
  podcastIndexId: z.number().int().nullable(),
  explicit: z.boolean(),
  /** Already subscribed: the podcast's id. */
  podcastId: z.number().int().nullable(),
});
export type PodcastSearchResult = z.infer<typeof PodcastSearchResult>;

export const PodcastSearchResponse = z.array(PodcastSearchResult);
export type PodcastSearchResponse = z.infer<typeof PodcastSearchResponse>;

/** POST /podcast/preview: fetch and parse a feed without subscribing. */
export const PodcastPreviewRequest = z.object({ feedUrl: HttpUrl });
export type PodcastPreviewRequest = z.infer<typeof PodcastPreviewRequest>;

export const PodcastPreview = z.object({
  title: z.string(),
  author: z.string().nullable(),
  description: z.string(),
  imageUrl: z.string().nullable(),
  link: z.string().nullable(),
  /** The URL the feed was finally read from (after redirects / `<itunes:new-feed-url>`), masked. */
  feedUrl: z.string(),
  episodeCount: z.number().int(),
  latestEpisodes: z.array(z.object({ title: z.string(), publishedAt: isoDate().nullable(), durationSeconds: z.number().int().nullable() })),
  podcastId: z.number().int().nullable(),
});
export type PodcastPreview = z.infer<typeof PodcastPreview>;

// ---------------------------------------------------------------------------------------
// OPML
// ---------------------------------------------------------------------------------------

/** POST /podcast/opml (import). */
export const PodcastOpmlImportRequest = z.object({
  opml: z.string().min(1).max(5_000_000),
  settings: PodcastSubscriptionSettings.partial().optional(),
  tags: idList().default([]),
});
export type PodcastOpmlImportRequest = z.input<typeof PodcastOpmlImportRequest>;

export const PodcastOpmlImportResult = z.object({
  added: z.array(z.object({ id: z.number().int(), title: z.string() })),
  existing: z.array(z.object({ id: z.number().int(), title: z.string() })),
  failed: z.array(z.object({ feedUrl: z.string(), title: z.string().nullable(), error: z.string() })),
});
export type PodcastOpmlImportResult = z.infer<typeof PodcastOpmlImportResult>;

/** GET /podcast/opml?includePrivate=true keeps credentials in private feed URLs (off by default). */
export const PodcastOpmlExportQuery = z.object({ includePrivate: qsBool().default(false) });
export type PodcastOpmlExportQuery = z.infer<typeof PodcastOpmlExportQuery>;

// ---------------------------------------------------------------------------------------
// Suggestions (request portal)
// ---------------------------------------------------------------------------------------

export const PodcastSuggestionStatus = z.enum(['pending', 'approved', 'declined']);
export type PodcastSuggestionStatus = z.infer<typeof PodcastSuggestionStatus>;

export const PodcastSuggestion = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  username: z.string(),
  /** Masked for everyone but admins. */
  feedUrl: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  imageUrl: z.string().nullable(),
  itunesId: z.number().int().nullable(),
  podcastIndexId: z.number().int().nullable(),
  note: z.string().nullable(),
  status: PodcastSuggestionStatus,
  /** The subscription it became (approved). */
  podcastId: z.number().int().nullable(),
  declineReason: z.string().nullable(),
  createdAt: isoDate(),
  updatedAt: isoDate(),
});
export type PodcastSuggestion = z.infer<typeof PodcastSuggestion>;

export const PodcastSuggestionListQuery = z.object({
  status: PodcastSuggestionStatus.optional(),
  /** Admins / request managers: only their own when true. */
  mine: qsBool().default(false),
});
export type PodcastSuggestionListQuery = z.input<typeof PodcastSuggestionListQuery>;

export const PodcastSuggestionList = z.array(PodcastSuggestion);
export type PodcastSuggestionList = z.infer<typeof PodcastSuggestionList>;

/** POST /podcast/suggestion. */
export const CreatePodcastSuggestion = z.object({
  feedUrl: HttpUrl,
  title: z.string().trim().max(500).optional(),
  itunesId: z.number().int().positive().nullable().optional(),
  podcastIndexId: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});
export type CreatePodcastSuggestion = z.input<typeof CreatePodcastSuggestion>;

export const DeclinePodcastSuggestion = z.object({ reason: z.string().trim().max(1000).optional() });
export type DeclinePodcastSuggestion = z.infer<typeof DeclinePodcastSuggestion>;

// ---------------------------------------------------------------------------------------
// Feed URL masking (shared by the api's logs and responses and the web)
// ---------------------------------------------------------------------------------------

const SECRET_QUERY_NAME = /(?:auth|token|key|secret|pass|pwd|sig|signature|session|access|credential|login|user|uid|hash|code|subscriber|premium|private)/i;
/** Path segments that look like credentials: long, opaque, letters mixed with digits. */
const TOKEN_SEGMENT = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{20,}$/i;

/**
 * True when the URL carries credentials: user info, a secret-looking query parameter, or a
 * long opaque path segment (premium hosts put the subscriber token in the path).
 */
export function feedUrlHasCredentials(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return true;
    let secretQuery = false;
    u.searchParams.forEach((_v, name) => {
      if (SECRET_QUERY_NAME.test(name)) secretQuery = true;
    });
    if (secretQuery) return true;
    return u.pathname.split('/').some((seg) => TOKEN_SEGMENT.test(seg.replace(/\.[a-z0-9]{2,5}$/i, '')));
  } catch {
    return false;
  }
}

/**
 * The URL with credentials masked: user info, secret-looking query values and token-like
 * path segments become `********`. Safe for logs, responses and notifications. Text that is
 * not a URL comes back unchanged.
 */
export function redactFeedUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const mask = SECRET_MASK;
  const hadUser = u.username !== '' || u.password !== '';
  const path = u.pathname
    .split('/')
    .map((seg) => {
      const m = /^(.*?)(\.[a-z0-9]{2,5})?$/i.exec(seg);
      const stem = m?.[1] ?? seg;
      return TOKEN_SEGMENT.test(stem) ? `${mask}${m?.[2] ?? ''}` : seg;
    })
    .join('/');
  const pairs: string[] = [];
  u.searchParams.forEach((v, k) => {
    pairs.push(`${encodeURIComponent(k)}=${SECRET_QUERY_NAME.test(k) ? mask : encodeURIComponent(v)}`);
  });
  const query = pairs.join('&');
  // Premium hosts often put the token in the user name, so both halves are masked.
  const userinfo = hadUser ? `${mask}${u.password ? `:${mask}` : ''}@` : '';
  return `${u.protocol}//${userinfo}${u.host}${path}${query ? `?${query}` : ''}${u.hash}`;
}

/** Mask feed / enclosure URLs inside free text (error messages from fetch carry the URL). */
export function redactUrlsInText(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => redactFeedUrl(m));
}
