import { baseTag } from '../languages.js';
import type {
  LanguageTag,
  MatchKey,
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleQuery,
} from '../types.js';
import { BaseProvider, parseRetryAfter, type HttpOptions } from './base.js';

// OpenSubtitles.com REST API v1 (spec 2.1). Login gives a JWT and a base host (VIP accounts
// get a "vip-" host); search is GET /subtitles; download is POST /download -> temporary link.

export interface OpenSubtitlesComConfig {
  username: string;
  password: string;
  /** Application API key registered by the operator (never shipped in source). */
  apiKey: string;
  /** Search by file hash when available (default true). */
  useHash?: boolean | undefined;
  includeAiTranslated?: boolean | undefined;
  includeMachineTranslated?: boolean | undefined;
}

export interface OpenSubtitlesQuota {
  requests: number | undefined;
  remaining: number | undefined;
  /** Epoch ms of the quota reset, when the server said. */
  resetAt: number | undefined;
}

const DEFAULT_HOST = 'api.opensubtitles.com';
const TOKEN_TTL_MS = 12 * 3600_000;

const OSC_LANGUAGES = [
  'af', 'ar', 'an', 'hy', 'as', 'at', 'eu', 'be', 'bn', 'bs', 'br', 'bg', 'my', 'ca', 'zh', 'zh-Hans', 'zh-Hant',
  'zh-CN', 'zh-TW', 'hr', 'cs', 'da', 'nl', 'en', 'eo', 'et', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'he', 'hi',
  'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'kk', 'km', 'ko', 'ku', 'lv', 'lt', 'lb', 'mk', 'ms', 'ml', 'mni',
  'mr', 'mn', 'me', 'nv', 'ne', 'se', 'no', 'oc', 'or', 'fa', 'pl', 'pt', 'pt-BR', 'pt-PT', 'ps', 'ro', 'ru',
  'sat', 'sr', 'sd', 'si', 'sk', 'sl', 'so', 'es', 'es-MX', 'sw', 'sv', 'syr', 'tl', 'ta', 'tt', 'te', 'th',
  'tr', 'tk', 'uk', 'ur', 'uz', 'vi', 'cy',
];

/** Internal tag -> wire code (spec: pt -> pt-PT, zh -> zh-CN, es-MX -> ea). */
export function oscWireLanguage(tag: LanguageTag): string {
  switch (tag) {
    case 'pt':
    case 'pt-PT':
      return 'pt-pt';
    case 'pt-BR':
      return 'pt-br';
    case 'zh':
    case 'zh-Hans':
    case 'zh-CN':
      return 'zh-cn';
    case 'zh-Hant':
    case 'zh-TW':
      return 'zh-tw';
    case 'es-MX':
      return 'ea';
    default:
      return baseTag(tag);
  }
}

/** "tt0012345" -> "12345". */
export function oscImdbNumber(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const n = id.replace(/^tt/i, '').replace(/^0+/, '');
  return n || undefined;
}

interface OscFile {
  file_id: number;
  file_name?: string;
}
interface OscItem {
  id: string;
  attributes: {
    subtitle_id?: string;
    language?: string;
    download_count?: number;
    hearing_impaired?: boolean;
    foreign_parts_only?: boolean;
    ai_translated?: boolean;
    machine_translated?: boolean;
    fps?: number;
    ratings?: number;
    release?: string;
    url?: string;
    moviehash_match?: boolean;
    uploader?: { name?: string };
    feature_details?: {
      feature_type?: string;
      year?: number;
      title?: string;
      imdb_id?: number;
      tmdb_id?: number;
      season_number?: number;
      episode_number?: number;
      parent_imdb_id?: number;
      parent_title?: string;
    };
    files?: OscFile[];
  };
}

export class OpenSubtitlesComProvider extends BaseProvider {
  readonly kind = 'opensubtitlescom' as const;
  readonly needsAuth = true;
  readonly rateLimit: RateLimit = {
    minIntervalMs: 250,
    requestTimeoutMs: 30_000,
    throttle: {
      'rate-limited': { kind: 'duration', ms: 60_000 },
      'daily-limit': { kind: 'duration', ms: 6 * 3600_000 },
      'bad-response': { kind: 'duration', ms: 60_000 },
    },
  };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['hash', 'imdb', 'tmdb', 'title', 'season-episode'],
    languages: new Set(OSC_LANGUAGES),
    forced: true,
    hi: true,
    hashVerifiable: true,
    hiVerifiable: true,
  };

  /** Quota reported by the last download call. */
  lastQuota: OpenSubtitlesQuota | undefined;

  private readonly config: Required<OpenSubtitlesComConfig>;
  private token: string | undefined;
  private host = DEFAULT_HOST;
  private tokenAt = 0;

  constructor(config: OpenSubtitlesComConfig, ctx: ProviderContext = {}) {
    super(ctx);
    if (!config.apiKey) throw this.error('config', 'apiKey is required');
    if (!config.username || !config.password) throw this.error('config', 'username and password are required');
    this.config = {
      username: config.username,
      password: config.password,
      apiKey: config.apiKey,
      useHash: config.useHash ?? true,
      includeAiTranslated: config.includeAiTranslated ?? false,
      includeMachineTranslated: config.includeMachineTranslated ?? false,
    };
  }

  /** False once the cached token is older than 12 hours. */
  ping(): boolean {
    return this.token !== undefined && this.now() - this.tokenAt < TOKEN_TTL_MS;
  }

  async test(): Promise<void> {
    this.token = undefined;
    await this.login();
  }

  private get vip(): boolean {
    return this.host.startsWith('vip');
  }

  private baseHeaders(withAuth: boolean): Record<string, string> {
    const h: Record<string, string> = { 'Api-Key': this.config.apiKey, Accept: 'application/json' };
    if (withAuth && this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async login(): Promise<void> {
    const res = await this.request(`https://${DEFAULT_HOST}/api/v1/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...this.baseHeaders(false), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
    });
    if (res.status === 401) throw this.error('auth', 'login rejected');
    if (!res.ok) throw await this.mapError(res);
    const body = await this.parseJson<{ token?: string; base_url?: string }>(res);
    if (!body.token) throw this.error('bad-response', 'login response has no token');
    this.token = body.token;
    this.host = (body.base_url || DEFAULT_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.tokenAt = this.now();
  }

  private async ensureLogin(): Promise<void> {
    if (!this.ping()) await this.login();
  }

  private async mapError(res: Response): Promise<Error> {
    const s = res.status;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await res.text()) as Record<string, unknown>;
    } catch {
      // non-JSON error body
    }
    const msg = typeof body.message === 'string' ? body.message : typeof body.errors === 'object' ? JSON.stringify(body.errors) : '';
    if (s === 400) return this.error('config', `bad request: ${msg}`);
    if (s === 401) return this.error('auth', 'unauthorized');
    if (s === 403) return this.error('auth', `forbidden (api key rejected) ${msg}`.trim());
    if (s === 406) {
      const reset = typeof body.reset_time_utc === 'string' ? Date.parse(body.reset_time_utc) : NaN;
      return this.error('daily-limit', `download quota exceeded ${msg}`.trim(), {
        resetAt: Number.isNaN(reset) ? undefined : reset,
      });
    }
    if (s === 410) return this.error('bad-response', 'download link expired');
    if (s === 429) {
      return this.error('rate-limited', 'too many requests', {
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
      });
    }
    if (s === 502) return this.error('api-throttled', 'api throttled (502)');
    if (s >= 500) return this.error('unreachable', `server error ${s}`);
    return this.error('bad-response', `unexpected status ${s}`);
  }

  /**
   * One API call with the spec's recovery rules: 401 -> re-login once and return the
   * retried response; api-throttled -> wait 15 s and retry once.
   */
  private async call(path: string, opts: HttpOptions, auth: boolean): Promise<Response> {
    let relogged = false;
    let throttled = false;
    for (;;) {
      const res = await this.request(`https://${this.host}/api/v1${path}`, {
        ...opts,
        headers: { ...this.baseHeaders(auth || this.vip), ...opts.headers },
      });
      if (res.ok) return res;
      if (res.status === 401 && !relogged) {
        relogged = true;
        this.token = undefined;
        await this.sleep(1000);
        await this.login();
        continue;
      }
      const err = await this.mapError(res);
      if ((err as { code?: string }).code === 'api-throttled' && !throttled) {
        throttled = true;
        await this.sleep(15_000);
        continue;
      }
      throw err;
    }
  }

  buildSearchParams(query: SubtitleQuery): URLSearchParams | undefined {
    const params: Record<string, string> = {};
    const wanted = this.wantedLanguages(query);
    params.languages = [...new Set(wanted.map((w) => oscWireLanguage(w.tag)))].sort().join(',');
    const hash = query.hashes?.opensubtitles;
    if (this.config.useHash && hash) params.moviehash = hash;
    if (query.mediaType === 'movie') {
      const imdb = oscImdbNumber(query.imdbId);
      if (imdb) params.imdb_id = imdb;
      else if (query.tmdbId !== undefined) params.tmdb_id = String(query.tmdbId);
    } else {
      const parent = oscImdbNumber(query.seriesImdbId);
      if (parent) params.parent_imdb_id = parent;
      if (query.season !== undefined) params.season_number = String(query.season);
      if (query.episode !== undefined) params.episode_number = String(query.episode);
    }
    const hasId = params.imdb_id || params.tmdb_id || params.parent_imdb_id;
    if (!hasId) {
      if (!query.title.trim()) return undefined;
      params.query = query.title.trim().toLowerCase();
      if (query.mediaType === 'movie' && query.year !== undefined) params.year = String(query.year);
    }
    if (!this.config.includeAiTranslated) params.ai_translated = 'exclude';
    if (this.config.includeMachineTranslated) params.machine_translated = 'include';
    const sorted = new URLSearchParams();
    for (const k of Object.keys(params).sort()) sorted.set(k, params[k]!);
    return sorted;
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const wanted = this.wantedLanguages(query);
    if (wanted.length === 0) return [];
    const params = this.buildSearchParams(query);
    if (!params) return [];
    await this.ensureLogin();
    const res = await this.call(`/subtitles?${params.toString()}`, {}, false);
    const body = await this.parseJson<{ data?: OscItem[] }>(res);
    if (!body || !Array.isArray(body.data)) throw this.error('bad-response', 'search response has no data');

    // wire code -> requested tags
    const byWire = new Map<string, LanguageTag[]>();
    for (const w of wanted) {
      const k = oscWireLanguage(w.tag);
      byWire.set(k, [...new Set([...(byWire.get(k) ?? []), w.tag])]);
    }

    const out: SubtitleCandidate[] = [];
    for (const item of body.data) {
      const a = item.attributes ?? {};
      if (!this.config.includeAiTranslated && a.ai_translated) continue;
      if (!this.config.includeMachineTranslated && a.machine_translated) continue;
      const file = a.files?.[0];
      if (!file) continue;
      const wire = (a.language ?? '').toLowerCase();
      const tags = byWire.get(wire);
      if (!tags) continue;
      const hi = Boolean(a.hearing_impaired);
      const realForced = Boolean(a.foreign_parts_only) && !hi;
      const flavours = wanted.filter((w) => tags.includes(w.tag));
      const allForced = flavours.every((w) => w.forced);
      const anyForced = flavours.some((w) => w.forced);
      if (allForced && !realForced) continue;
      if (!anyForced && realForced) continue;
      const tag = flavours.find((w) => w.forced === realForced)?.tag ?? tags[0]!;

      const fd = a.feature_details ?? {};
      const matches = new Set<MatchKey>();
      let imdbMatched = false;
      if (query.mediaType === 'episode') {
        matches.add('series');
        if (fd.season_number !== undefined && fd.season_number === query.season) matches.add('season');
        if (fd.episode_number !== undefined && fd.episode_number === query.episode) matches.add('episode');
        const parent = oscImdbNumber(query.seriesImdbId);
        if (parent && fd.parent_imdb_id !== undefined && String(fd.parent_imdb_id) === parent) {
          matches.add('series_imdb_id');
          imdbMatched = true;
        }
      } else {
        matches.add('title');
        const imdb = oscImdbNumber(query.imdbId);
        if (imdb && fd.imdb_id !== undefined && String(fd.imdb_id) === imdb) {
          matches.add('imdb_id');
          imdbMatched = true;
        }
      }
      if (imdbMatched || (fd.year !== undefined && query.year !== undefined && fd.year === query.year)) matches.add('year');
      if (a.moviehash_match) matches.add('hash');

      out.push(
        this.candidate({
          id: String(file.file_id),
          language: tag,
          forced: realForced,
          hi,
          releaseInfo: a.release ?? file.file_name ?? '',
          matches,
          pageUrl: a.url,
          token: { fileId: file.file_id, fileName: file.file_name },
          uploader: a.uploader?.name,
          rating: a.ratings,
          downloads: a.download_count,
          fps: a.fps || undefined,
          season: fd.season_number,
          episode: fd.episode_number,
        }),
      );
    }
    return out;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    const fileId = Number(candidate.token?.fileId ?? candidate.id);
    await this.ensureLogin();
    const res = await this.call(
      '/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
      },
      true,
    );
    const body = await this.parseJson<{ link?: string; file_name?: string; requests?: number; remaining?: number; reset_time_utc?: string }>(res);
    const reset = body.reset_time_utc ? Date.parse(body.reset_time_utc) : NaN;
    this.lastQuota = { requests: body.requests, remaining: body.remaining, resetAt: Number.isNaN(reset) ? undefined : reset };
    if (!body.link) throw this.error('bad-response', 'download response has no link');
    const linkRes = await this.request(body.link);
    if (!linkRes.ok) throw await this.mapError(linkRes);
    const bytes = new Uint8Array(await linkRes.arrayBuffer());
    return this.file(bytes, body.file_name ?? (typeof candidate.token?.fileName === 'string' ? candidate.token.fileName : undefined));
  }
}
