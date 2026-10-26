import { baseTag, parseLanguageTag } from '../languages.js';
import {
  ProviderError,
  type LanguageTag,
  type MatchKey,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderErrorCode,
  type ProviderKind,
  type QueryInput,
  type RateLimit,
  type SubtitleCandidate,
  type SubtitleFile,
  type SubtitleProvider,
  type SubtitleQuery,
  type SupportResult,
  type WantedLanguage,
} from '../types.js';
import { detectFormatFromBytes } from '../formats.js';

export const DEFAULT_USER_AGENT = 'Media-Tron/0.1';

export interface HttpOptions {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | Uint8Array | URLSearchParams | FormData | undefined;
  timeoutMs?: number | undefined;
  redirect?: 'follow' | 'manual' | undefined;
}

/** True when the query carries the given input. */
export function hasInput(query: SubtitleQuery, input: QueryInput): boolean {
  switch (input) {
    case 'hash':
      return Boolean(query.hashes?.opensubtitles || query.hashes?.napiprojekt);
    case 'imdb':
      return Boolean(query.mediaType === 'movie' ? query.imdbId : query.seriesImdbId ?? query.imdbId);
    case 'tmdb':
      return query.tmdbId !== undefined;
    case 'tvdb':
      return query.mediaType === 'episode' ? query.seriesTvdbId !== undefined || query.tvdbId !== undefined : false;
    case 'anidb':
      return query.anidbEpisodeId !== undefined;
    case 'anilist':
      return query.anilistId !== undefined;
    case 'title':
      return query.title.trim().length > 0;
    case 'season-episode':
      return query.season !== undefined && query.episode !== undefined;
    case 'file':
      return Boolean(query.filePath);
  }
}

/** Parse a Retry-After header (seconds or HTTP date) to ms. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

/**
 * Shared plumbing for providers: injected fetch/clock/sleep, request spacing, timeouts,
 * default status mapping, language filtering and candidate construction.
 */
export abstract class BaseProvider implements SubtitleProvider {
  abstract readonly kind: ProviderKind;
  abstract readonly needsAuth: boolean;
  abstract readonly rateLimit: RateLimit;
  abstract readonly capabilities: ProviderCapabilities;

  protected readonly fetchImpl: typeof fetch;
  protected readonly now: () => number;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly userAgent: string;
  private lastRequestAt = 0;

  constructor(ctx: ProviderContext = {}) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.now = ctx.now ?? Date.now;
    this.sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.userAgent = ctx.userAgent ?? DEFAULT_USER_AGENT;
  }

  abstract search(query: SubtitleQuery): Promise<SubtitleCandidate[]>;
  abstract download(candidate: SubtitleCandidate, query?: SubtitleQuery): Promise<SubtitleFile>;
  abstract test(): Promise<void>;

  /**
   * Default support check: media type, at least one usable search input (season-episode
   * alone is never enough), required hash, and at least one servable language.
   */
  supports(query: SubtitleQuery): SupportResult {
    const caps = this.capabilities;
    if (!caps.mediaTypes.includes(query.mediaType)) {
      return { ok: false, reason: `${this.kind} does not serve ${query.mediaType}s` };
    }
    if (caps.requiredHash && !query.hashes?.[caps.requiredHash]) {
      return { ok: false, reason: `${this.kind} needs the ${caps.requiredHash} hash` };
    }
    const keys = caps.inputs.filter((i) => i !== 'season-episode');
    if (keys.length > 0 && !keys.some((i) => hasInput(query, i))) {
      return { ok: false, reason: `${this.kind} needs one of: ${keys.join(', ')}` };
    }
    if (query.mediaType === 'episode' && caps.inputs.includes('season-episode') && !hasInput(query, 'season-episode')) {
      return { ok: false, reason: `${this.kind} needs season and episode numbers` };
    }
    if (this.wantedLanguages(query).length === 0) {
      return { ok: false, reason: `${this.kind} serves none of the requested languages` };
    }
    return { ok: true };
  }

  /** Requested languages this provider can serve (language set, forced and HI support). */
  protected wantedLanguages(query: SubtitleQuery): WantedLanguage[] {
    const caps = this.capabilities;
    return query.languages.filter((w) => {
      if (w.forced && !caps.forced) return false;
      if (w.hi === 'required' && !caps.hi) return false;
      return this.servesLanguage(w.tag);
    });
  }

  protected servesLanguage(tag: LanguageTag): boolean {
    const langs = this.capabilities.languages;
    if (langs === 'any') return parseLanguageTag(tag) !== undefined;
    return langs.has(tag) || (!tag.includes('-') && langs.has(baseTag(tag)));
  }

  /** Whether a result language/flags pair answers one of the wanted entries. */
  protected isWanted(query: SubtitleQuery, tag: LanguageTag, forced: boolean): boolean {
    return this.wantedLanguages(query).some((w) => w.tag === tag && w.forced === forced);
  }

  protected error(
    code: ProviderErrorCode,
    message: string,
    extra: { retryAfterMs?: number | undefined; resetAt?: number | undefined; cause?: unknown } = {},
  ): ProviderError {
    return new ProviderError(code, `${this.kind}: ${message}`, { provider: this.kind, ...extra });
  }

  /** fetch with spacing, timeout and network-error mapping. Status codes are not checked. */
  protected async request(url: string, opts: HttpOptions = {}): Promise<Response> {
    const gap = this.rateLimit.minIntervalMs - (this.now() - this.lastRequestAt);
    if (this.lastRequestAt > 0 && gap > 0) await this.sleep(gap);
    this.lastRequestAt = this.now();
    const headers: Record<string, string> = { 'User-Agent': this.userAgent, ...opts.headers };
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
      redirect: opts.redirect ?? 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.rateLimit.requestTimeoutMs),
    };
    if (opts.body !== undefined) init.body = opts.body as NonNullable<RequestInit["body"]>;
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw this.error('unreachable', `request failed: ${(err as Error).message ?? String(err)}`, { cause: err });
    }
  }

  /** Default mapping of a non-OK response to a typed error. */
  protected statusError(res: Response, context = ''): ProviderError {
    const where = context ? ` (${context})` : '';
    const s = res.status;
    if (s === 401) return this.error('auth', `unauthorized${where}`);
    if (s === 403) return this.error('auth', `forbidden${where}`);
    if (s === 404) return this.error('not-found', `not found${where}`);
    if (s === 429) {
      return this.error('rate-limited', `too many requests${where}`, {
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
      });
    }
    if (s >= 500) return this.error('unreachable', `server error ${s}${where}`);
    return this.error('bad-response', `unexpected status ${s}${where}`);
  }

  protected async getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
    const res = await this.request(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
    if (!res.ok) throw this.statusError(res, url);
    return this.parseJson<T>(res);
  }

  protected async parseJson<T = unknown>(res: Response): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw this.error('bad-response', 'response is not JSON');
    }
  }

  protected async getText(url: string, opts: HttpOptions = {}): Promise<string> {
    const res = await this.request(url, opts);
    if (!res.ok) throw this.statusError(res, url);
    return res.text();
  }

  protected async getBytes(url: string, opts: HttpOptions = {}): Promise<Uint8Array> {
    const res = await this.request(url, opts);
    if (!res.ok) throw this.statusError(res, url);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Build a candidate with defaults from this provider's capabilities. */
  protected candidate(
    fields: Omit<SubtitleCandidate, 'provider' | 'matches' | 'score' | 'scoreWithoutHash' | 'hashVerifiable' | 'hiVerifiable'> & {
      matches?: Iterable<MatchKey> | undefined;
    },
  ): SubtitleCandidate {
    const { matches, ...rest } = fields;
    return {
      ...rest,
      provider: this.kind,
      matches: new Set(matches ?? []),
      score: 0,
      scoreWithoutHash: 0,
      hashVerifiable: this.capabilities.hashVerifiable,
      hiVerifiable: this.capabilities.hiVerifiable,
    };
  }

  /** Wrap downloaded bytes; archives are left for the searcher to unpack. */
  protected file(bytes: Uint8Array, fileName?: string, encoding?: string): SubtitleFile {
    return {
      bytes,
      format: detectFormatFromBytes(bytes, fileName),
      encoding: encoding ?? 'unknown',
      ...(fileName !== undefined ? { fileName } : {}),
    };
  }
}

/** Build a language set from tags, optionally restricted. */
export function languageSet(tags: Iterable<string>): ReadonlySet<LanguageTag> {
  return new Set(tags);
}
