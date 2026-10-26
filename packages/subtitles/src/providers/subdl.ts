import { baseTag } from '../languages.js';
import {
  ProviderError,
  type LanguageTag,
  type MatchKey,
  type ProviderCapabilities,
  type ProviderContext,
  type RateLimit,
  type SubtitleCandidate,
  type SubtitleFile,
  type SubtitleQuery,
} from '../types.js';
import { BaseProvider, parseRetryAfter } from './base.js';

// Subdl (spec 2.2): API key in the query string, JSON search with at most two pages,
// downloads from a separate host (normally a zip; the searcher unpacks).

export interface SubdlConfig {
  apiKey: string;
  /** Accept items the service marks as AI translated (default false). */
  includeAiTranslated?: boolean | undefined;
}

const API = 'https://api.subdl.com/api/v1/subtitles';
const DL = 'https://dl.subdl.com';

/** Internal tag -> Subdl language code. */
export function subdlLanguageCode(tag: LanguageTag): string {
  switch (tag) {
    case 'pt-BR':
      return 'BR_PT';
    case 'zh-Hant':
    case 'zh-TW':
      return 'ZH_BG';
    case 'zh-Hans':
    case 'zh-CN':
      return 'ZH';
    default:
      return baseTag(tag).toUpperCase();
  }
}

const SUBDL_LANGUAGES = [
  'ar', 'pt-BR', 'da', 'nl', 'en', 'fa', 'fi', 'fr', 'id', 'it', 'no', 'ro', 'es', 'sv', 'vi', 'sq', 'az', 'be',
  'bn', 'zh', 'zh-Hant', 'bs', 'bg', 'my', 'ca', 'hr', 'cs', 'eo', 'et', 'ka', 'de', 'el', 'kl', 'he', 'hi', 'hu',
  'is', 'ja', 'ko', 'ku', 'lv', 'lt', 'mk', 'ms', 'ml', 'pl', 'pt', 'ru', 'sr', 'si', 'sk', 'sl', 'tl', 'ta',
  'te', 'th', 'tr', 'uk', 'ur',
];

const HI_KEYWORDS = /(?:^|[^a-z])(?:hearing[ ._-]?impaired|sdh|cc|hi)(?:[^a-z]|$)/i;
const NON_HI_KEYWORDS = /(?:non|no|without)[ ._-]?(?:hi|sdh)(?:[^a-z]|$)|hi[ ._-]?remove/i;
const FORCED_KEYWORDS = /(?:^|[^a-z])(?:forced|foreign[ ._-]?parts?)(?:[^a-z]|$)/i;

interface SubdlItem {
  release_name?: string;
  name?: string;
  lang?: string;
  language?: string;
  author?: string;
  url?: string;
  subtitlePage?: string;
  season?: number | null;
  episode?: number | null;
  hi?: boolean;
  forced?: boolean;
  episode_from?: number | null;
  episode_end?: number | null;
  full_season?: boolean;
  releases?: string[];
  comment?: string;
  ai_translated?: boolean;
}
interface SubdlPolicy {
  disable_provider?: boolean;
  disable_fallbacks?: boolean;
  max_pages?: number;
}
interface SubdlResponse {
  status?: boolean;
  error?: string;
  subtitles?: SubdlItem[];
  totalPages?: number;
  currentPage?: number;
  policy?: SubdlPolicy;
}

type MatchedBy = 'imdb' | 'tmdb' | 'title';

/** Next 00:15 UTC after `now`. */
export function nextSubdlReset(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 15);
  return t > now ? t : t + 86_400_000;
}

export class SubdlProvider extends BaseProvider {
  readonly kind = 'subdl' as const;
  readonly needsAuth = true;
  readonly rateLimit: RateLimit = {
    minIntervalMs: 200,
    requestTimeoutMs: 30_000,
    throttle: {
      'daily-limit': { kind: 'until-utc', hour: 0, minute: 15 },
      'api-throttled': { kind: 'duration', ms: 15 * 60_000 },
      'bad-response': { kind: 'duration', ms: 3600_000 },
      unreachable: { kind: 'duration', ms: 3600_000 },
    },
  };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['imdb', 'tmdb', 'title', 'season-episode'],
    languages: new Set(SUBDL_LANGUAGES),
    forced: true,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };

  private readonly config: SubdlConfig;
  private maxPages = 2;
  private fallbacksAllowed = true;
  /** Set when the service's policy told us to stop using the provider. */
  disabledByPolicy = false;

  constructor(config: SubdlConfig, ctx: ProviderContext = {}) {
    super(ctx);
    if (!config.apiKey) throw this.error('config', 'apiKey is required');
    this.config = config;
  }

  async test(): Promise<void> {
    await this.fetchPage({ film_name: 'test', type: 'movie' }, 1, []);
  }

  private applyPolicy(policy: SubdlPolicy | undefined): void {
    if (!policy) return;
    if (policy.disable_provider) this.disabledByPolicy = true;
    if (policy.disable_fallbacks) this.fallbacksAllowed = false;
    if (typeof policy.max_pages === 'number' && policy.max_pages >= 1) this.maxPages = Math.min(2, Math.floor(policy.max_pages));
  }

  private async fetchPage(params: Record<string, string>, page: number, langs: string[]): Promise<SubdlResponse> {
    const qs = new URLSearchParams({
      api_key: this.config.apiKey,
      client: 'media-tron',
      comment: '1',
      releases: '1',
      unpack: '1',
      subs_per_page: '30',
      ...params,
    });
    if (langs.length) qs.set('languages', langs.join(','));
    if (page > 1) qs.set('page', String(page));
    let rateRetries = 0;
    let busyRetries = 0;
    for (;;) {
      const res = await this.request(`${API}?${qs.toString()}`, { headers: { Accept: 'application/json' } });
      const text = await res.text();
      let body: SubdlResponse | undefined;
      try {
        body = JSON.parse(text) as SubdlResponse;
      } catch {
        body = undefined;
      }
      const message = (body?.error ?? text).toString();
      if (res.status === 429) {
        if (/daily|download limit/i.test(message)) {
          throw this.error('daily-limit', message, { resetAt: nextSubdlReset(this.now()) });
        }
        if (/busy/i.test(message)) {
          if (++busyRetries > 5) throw this.error('unreachable', 'service busy');
          await this.sleep(parseRetryAfter(res.headers.get('retry-after')) ?? 5000);
          continue;
        }
        if (++rateRetries >= 6) throw this.error('api-throttled', 'rate limit retries exhausted');
        const wait = Math.min(60_000, Math.max(0, parseRetryAfter(res.headers.get('retry-after')) ?? 15_000));
        await this.sleep(wait);
        continue;
      }
      if (res.status === 402) throw this.error('bad-response', `payment required: ${message}`);
      if (res.status === 403) {
        if (/key|auth|forbidden/i.test(message)) throw this.error('auth', message);
        throw this.error('api-throttled', message);
      }
      if (res.status === 404) {
        if (/resource not found/i.test(message)) throw this.error('unreachable', message);
        throw this.error('not-found', message);
      }
      if (res.status === 401) throw this.error('auth', message);
      if (res.status >= 500) throw this.error('unreachable', `server error ${res.status}`);
      if (res.status >= 400) throw this.error('bad-response', `request rejected ${res.status}: ${message}`);
      if (!body) throw this.error('bad-response', 'response is not JSON');
      if (body.status === false) {
        if (/api[_ ]?key|auth/i.test(message)) throw this.error('auth', message);
        // "can't find movie or tv" and similar: an empty result for this request.
        return { subtitles: [], totalPages: 1 };
      }
      this.applyPolicy(body.policy);
      return body;
    }
  }

  private async fetchAll(params: Record<string, string>, langs: string[]): Promise<SubdlItem[]> {
    const first = await this.fetchPage(params, 1, langs);
    const items = [...(first.subtitles ?? [])];
    const pages = Math.min(this.maxPages, first.totalPages ?? 1);
    for (let p = 2; p <= pages; p++) {
      const next = await this.fetchPage(params, p, langs);
      items.push(...(next.subtitles ?? []));
    }
    return items;
  }

  /** Sub-searches after the first absorb per-request failures, keeping earlier results. */
  private async subSearch(params: Record<string, string>, langs: string[], haveResults: boolean): Promise<SubdlItem[]> {
    try {
      return await this.fetchAll(params, langs);
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.code === 'not-found' || err.code === 'bad-response') return [];
        if (err.code === 'unreachable' && haveResults && /request failed/.test(err.message)) return [];
      }
      throw err;
    }
  }

  static cleanTitle(title: string): string {
    return title.replace(/[<>{}[\]"'`;/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const wanted = this.wantedLanguages(query);
    if (wanted.length === 0 || this.disabledByPolicy) return [];
    const codeToTags = new Map<string, LanguageTag[]>();
    for (const w of wanted) {
      const c = subdlLanguageCode(w.tag);
      codeToTags.set(c, [...new Set([...(codeToTags.get(c) ?? []), w.tag])]);
    }
    const langs = [...codeToTags.keys()].sort();
    const collected: Array<{ item: SubdlItem; by: MatchedBy; byAbsolute: boolean }> = [];
    const seen = new Set<string>();
    const add = (items: SubdlItem[], by: MatchedBy, byAbsolute = false) => {
      for (const item of items) {
        const key = item.url || item.name || item.release_name || '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push({ item, by, byAbsolute });
      }
    };

    if (query.mediaType === 'movie') {
      let by: MatchedBy;
      const base: Record<string, string> = { type: 'movie' };
      if (query.imdbId) {
        base.imdb_id = query.imdbId;
        by = 'imdb';
      } else {
        base.film_name = SubdlProvider.cleanTitle(query.title);
        if (query.year !== undefined) base.year = String(query.year);
        by = 'title';
      }
      add(await this.fetchAll(base, langs), by);
      if (collected.length === 0 && query.tmdbId !== undefined) {
        add(await this.subSearch({ type: 'movie', tmdb_id: String(query.tmdbId) }, langs, false), 'tmdb');
      }
    } else {
      const idParams: Record<string, string> = { type: 'tv' };
      let by: MatchedBy;
      if (query.seriesImdbId) {
        idParams.imdb_id = query.seriesImdbId;
        by = 'imdb';
      } else if (query.tmdbId !== undefined) {
        idParams.tmdb_id = String(query.tmdbId);
        by = 'tmdb';
      } else {
        idParams.film_name = SubdlProvider.cleanTitle(query.title);
        by = 'title';
      }
      add(await this.fetchAll({ ...idParams, season_number: String(query.season), episode_number: String(query.episode) }, langs), by);
      if (query.absoluteEpisode !== undefined && query.absoluteEpisode !== query.episode) {
        add(await this.subSearch({ ...idParams, episode_number: String(query.absoluteEpisode) }, langs, collected.length > 0), by, true);
      }
      if (this.fallbacksAllowed) {
        add(await this.subSearch({ ...idParams, season_number: String(query.season) }, langs, collected.length > 0), by);
      }
      if (collected.length === 0 && this.fallbacksAllowed && by !== 'title') {
        add(await this.subSearch({ type: 'tv', film_name: SubdlProvider.cleanTitle(query.title) }, langs, false), 'title');
      }
    }

    const out: SubtitleCandidate[] = [];
    for (const { item, by, byAbsolute } of collected) {
      const c = this.toCandidate(query, item, by, byAbsolute, codeToTags);
      if (c) out.push(c);
    }
    return out;
  }

  private toCandidate(
    query: SubtitleQuery,
    item: SubdlItem,
    by: MatchedBy,
    byAbsolute: boolean,
    codeToTags: Map<string, LanguageTag[]>,
  ): SubtitleCandidate | undefined {
    if (!item.url) return undefined;
    if (item.ai_translated && !this.config.includeAiTranslated) return undefined;
    const code = (item.language ?? '').toUpperCase();
    const tags = codeToTags.get(code);
    if (!tags) return undefined;

    const releases = item.releases?.length ? item.releases : [item.release_name ?? item.name ?? ''];
    const text = [...releases, item.comment ?? ''].join('\n');
    const hi = NON_HI_KEYWORDS.test(text) ? false : Boolean(item.hi) || HI_KEYWORDS.test(text);
    const forced = Boolean(item.forced) || FORCED_KEYWORDS.test(text);
    const wanted = this.wantedLanguages(query).filter((w) => tags.includes(w.tag));
    const match = wanted.find((w) => w.forced === forced);
    if (!match) return undefined;

    const matches = new Set<MatchKey>();
    let isPack = false;
    let episodeRange: [number, number] | undefined;
    if (query.mediaType === 'episode') {
      const from = item.episode_from ?? undefined;
      const end = item.episode_end ?? undefined;
      if (from !== undefined && end !== undefined && end > from) episodeRange = [from, end];
      else {
        const m = /E(\d{1,4})\s*-\s*E?(\d{1,4})/i.exec(releases.join(' '));
        if (m && Number(m[2]) > Number(m[1])) episodeRange = [Number(m[1]), Number(m[2])];
      }
      isPack = Boolean(item.full_season) || episodeRange !== undefined || (item.episode == null && item.season != null);
      // Season-wide searches return sibling episodes: drop explicit other-episode items.
      if (!isPack && item.episode != null && item.episode !== query.episode && item.episode !== query.absoluteEpisode) {
        return undefined;
      }
      if (by === 'imdb') {
        matches.add('series').add('series_imdb_id');
        if (query.year !== undefined) matches.add('year');
      } else matches.add('series');
      const ep = item.episode ?? undefined;
      if (ep !== undefined && ep === query.episode) matches.add('episode');
      else if (ep !== undefined && query.absoluteEpisode !== undefined && ep === query.absoluteEpisode) matches.add('episode');
      else if (isPack) {
        if (!episodeRange || (query.episode !== undefined && query.episode >= episodeRange[0] && query.episode <= episodeRange[1])) {
          matches.add('episode');
        }
      }
      const season = item.season ?? undefined;
      if ((season !== undefined && season === query.season) || (isPack && query.absoluteEpisode !== undefined) || byAbsolute) {
        matches.add('season');
      }
    } else if (by === 'title') {
      matches.add('title');
    } else {
      matches.add('title');
      if (query.imdbId) matches.add('imdb_id');
      if (query.tmdbId !== undefined) matches.add('tmdb_id');
      if (query.year !== undefined) matches.add('year');
    }

    return this.candidate({
      id: item.url,
      language: match.tag,
      forced,
      hi,
      releaseInfo: releases.filter(Boolean).join('\n'),
      matches,
      downloadUrl: `${DL}${item.url.startsWith('/') ? '' : '/'}${item.url}`,
      pageUrl: item.subtitlePage ? `https://subdl.com${item.subtitlePage}` : undefined,
      uploader: item.author,
      isPack: isPack || undefined,
      season: item.season ?? query.season,
      episode: isPack ? query.episode : item.episode ?? undefined,
    });
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    const url = candidate.downloadUrl ?? `${DL}${candidate.id}`;
    const res = await this.request(url);
    if (res.status === 429) throw this.error('daily-limit', 'download limit', { resetAt: nextSubdlReset(this.now()) });
    if (!res.ok) throw this.statusError(res, 'download');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      throw this.error('bad-response', 'download returned an HTML page');
    }
    return this.file(bytes, url.split('/').pop());
  }
}
