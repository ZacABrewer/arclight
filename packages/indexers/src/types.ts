/** Download protocol an indexer serves. Torrent indexers speak Torznab, usenet ones Newznab. */
export type IndexerProtocol = 'torrent' | 'usenet';

/** User-configured settings for one Torznab/Newznab endpoint. */
export interface IndexerDefinition {
  name: string;
  /** Scheme + host (+ optional path prefix), e.g. `http://jackett:9117/api/v2.0/indexers/foo/results/torznab`. */
  baseUrl: string;
  /** Path appended to `baseUrl`; defaults to `/api`. */
  apiPath?: string;
  apiKey?: string;
  /** Newznab category ids searched for movies/general searches. */
  categories: number[];
  /** Extra category ids searched for TV (anime) requests. */
  animeCategories?: number[];
  protocol: IndexerProtocol;
  /** Torrent results with fewer known seeders are dropped. */
  minimumSeeders?: number;
  /** Seed ratio target passed on to the download client (not used by the protocol itself). */
  seedRatio?: number;
  /** Seed time target in milliseconds (not used by the protocol itself). */
  seedTime?: number;
  /** Raw query string fragment appended to every search, e.g. `&attrs=poster`. */
  additionalParameters?: string;
  /** Minimum interval between two HTTP requests to this indexer, in milliseconds. */
  rateLimitMs?: number;
}

/** Search parameters a Newznab-family endpoint may advertise. */
export type SearchParam = 'q' | 'tvdbid' | 'tmdbid' | 'imdbid' | 'rid' | 'season' | 'ep' | 'year';

export const SEARCH_PARAMS: readonly SearchParam[] = [
  'q',
  'tvdbid',
  'tmdbid',
  'imdbid',
  'rid',
  'season',
  'ep',
  'year',
];

export interface SearchModeCapabilities {
  available: boolean;
  supportedParams: SearchParam[];
}

export interface CapsSubcategory {
  id: number;
  name: string;
}

export interface CapsCategory {
  id: number;
  name: string;
  subcats: CapsSubcategory[];
}

export interface IndexerCapabilities {
  serverTitle?: string;
  limits: { max: number; default: number };
  searching: {
    search: SearchModeCapabilities;
    tvSearch: SearchModeCapabilities;
    movieSearch: SearchModeCapabilities;
  };
  categories: CapsCategory[];
}

export interface RssRequest {
  kind: 'rss';
}

export interface BasicSearchRequest {
  kind: 'search';
  query: string;
}

export interface TvSearchRequest {
  kind: 'tv';
  query?: string;
  tvdbId?: number;
  imdbId?: string;
  tmdbId?: number;
  season?: number;
  episode?: number;
  /** ISO date (`YYYY-MM-DD`) for daily shows; sent as season=YYYY, ep=MM/DD. */
  airDate?: string;
}

export interface MovieSearchRequest {
  kind: 'movie';
  query?: string;
  imdbId?: string;
  tmdbId?: number;
  year?: number;
}

export type SearchRequest = RssRequest | BasicSearchRequest | TvSearchRequest | MovieSearchRequest;

/** One candidate download returned by an indexer. */
export interface ReleaseInfo {
  guid: string;
  title: string;
  /** Bytes. */
  size: number;
  /** ISO-8601. */
  publishDate: string;
  downloadUrl: string;
  infoUrl?: string;
  magnetUrl?: string;
  /** Lower-case hex info hash. */
  infoHash?: string;
  seeders?: number;
  leechers?: number;
  peers?: number;
  categories: number[];
  indexerId?: number;
  indexerName: string;
  protocol: IndexerProtocol;
  tvdbId?: number;
  tmdbId?: number;
  /** `tt`-prefixed IMDb id. */
  imdbId?: string;
  grabs?: number;
  downloadVolumeFactor?: number;
  uploadVolumeFactor?: number;
  minimumRatio?: number;
  /** Milliseconds. */
  minimumSeedTime?: number;
}

export type IndexerErrorCode =
  | 'auth'
  | 'unreachable'
  | 'bad-response'
  | 'rate-limited'
  | 'unsupported-search'
  | 'caps-failed';

export interface IndexerErrorDetails {
  /** HTTP status, when a response was received. */
  status?: number;
  /** Newznab `<error code>` value, when the indexer reported one. */
  indexerCode?: number;
  cause?: unknown;
}

export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  readonly status: number | undefined;
  readonly indexerCode: number | undefined;

  constructor(code: IndexerErrorCode, message: string, details: IndexerErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'IndexerError';
    this.code = code;
    this.status = details.status;
    this.indexerCode = details.indexerCode;
  }
}

/** Runtime hooks shared by the protocol clients; everything is optional and test-injectable. */
export interface ClientOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds; default 30 000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Awaited before every HTTP request (used for rate limiting). */
  beforeRequest?: () => Promise<void>;
  /** Stamped onto every returned release. */
  indexerId?: number;
  /** Stop paging once this many releases are collected; default 1000. */
  maxResults?: number;
  /** Hard cap on pages per search; default 10. */
  maxPages?: number;
  /** Clock used when a release has no parseable date; defaults to `Date.now`. */
  now?: () => number;
}
