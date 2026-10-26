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
import { BaseProvider } from './base.js';
import { absoluteUrl, anchors, byClass, findElements, getAttr, textContent } from './html.js';

// Subf2m: Subscene-style HTML scraper. Title search -> title page per language -> list
// items -> subtitle page -> download button -> zip. Identity-style matches.

const BASE = 'https://subf2m.co';

/** Site language slugs (including the site's own misspellings) to tags. */
const SLUGS: ReadonlyArray<readonly [string, LanguageTag]> = [
  ['albanian', 'sq'], ['arabic', 'ar'], ['bengali', 'bn'], ['brazillian-portuguese', 'pt-BR'],
  ['bulgarian', 'bg'], ['croatian', 'hr'], ['czech', 'cs'], ['danish', 'da'], ['dutch', 'nl'],
  ['english', 'en'], ['farsi_persian', 'fa'], ['finnish', 'fi'], ['french', 'fr'], ['german', 'de'],
  ['greek', 'el'], ['hebrew', 'he'], ['hungarian', 'hu'], ['indonesian', 'id'], ['italian', 'it'],
  ['malay', 'ms'], ['norwegian', 'no'], ['polish', 'pl'], ['portuguese', 'pt'], ['romanian', 'ro'],
  ['russian', 'ru'], ['serbian', 'sr'], ['slovenian', 'sl'], ['spanish', 'es'], ['swedish', 'sv'],
  ['thai', 'th'], ['turkish', 'tr'], ['urdu', 'ur'], ['vietnamese', 'vi'],
];
const slugByTag = new Map(SLUGS.map(([s, t]) => [t, s]));

export function subf2mLanguageSlug(tag: LanguageTag): string | undefined {
  return slugByTag.get(tag);
}

const ORDINALS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth',
];

/** "First" for 1 ... "Twentieth" for 20; undefined above. */
export function seasonOrdinal(season: number): string | undefined {
  return ORDINALS[season - 1];
}

/** Dice coefficient over character bigrams (0..1). */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}

interface EpisodeInfo {
  season?: number | undefined;
  episode?: number | undefined;
  seasonRange?: [number, number] | undefined;
  completeSeries: boolean;
}

/** Season/episode markers in a release line. */
export function parseEpisodeInfo(text: string): EpisodeInfo {
  const info: EpisodeInfo = { completeSeries: /complete[\s._-]*series/i.test(text) };
  const range = /season[\s._-]*(\d{1,2})[\s._-]*(?:-|to)[\s._-]*(\d{1,2})/i.exec(text);
  if (range) info.seasonRange = [Number(range[1]), Number(range[2])];
  const se = /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]?e(\d{1,3})/i.exec(text);
  if (se) {
    info.season = Number(se[1]);
    info.episode = Number(se[2]);
    return info;
  }
  const s = /(?:^|[^a-z0-9])(?:s(\d{1,2})(?![\d])|season[\s._-]*(\d{1,2}))/i.exec(text);
  if (s) info.season = Number(s[1] ?? s[2]);
  return info;
}

export interface Subf2mConfig {
  userAgent: string;
  verifySsl?: boolean | undefined;
}

export class Subf2mProvider extends BaseProvider {
  readonly kind = 'subf2m' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 1000, requestTimeoutMs: 10_000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['title', 'imdb'],
    languages: new Set(SLUGS.map(([, t]) => t)),
    forced: false,
    hi: false,
    hashVerifiable: false,
    hiVerifiable: false,
  };
  private readonly ua: string;

  constructor(config: Subf2mConfig, ctx?: ProviderContext) {
    super(ctx);
    if (!config.userAgent?.trim()) throw this.error('config', 'a user agent is required');
    this.ua = config.userAgent.trim();
  }

  private headers(referer?: string): Record<string, string> {
    return {
      'User-Agent': this.ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
      'Upgrade-Insecure-Requests': '1',
      ...(referer ? { Referer: referer } : {}),
    };
  }

  /**
   * GET a page: 403 = blocked (captcha when it is a challenge page, else null); 404 = null;
   * 503 retried up to 3 times with a 3 s pause.
   */
  private async page(url: string, referer?: string): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.request(url, { headers: this.headers(referer) });
      if (res.ok) return res.text();
      if (res.status === 403) {
        const body = await res.text();
        if (/cf-chl|challenge-platform|just a moment|captcha/i.test(body)) {
          throw this.error('captcha', 'blocked by a browser challenge');
        }
        return null;
      }
      if (res.status === 404) return null;
      if (res.status === 503 && attempt < 3) {
        await this.sleep(3000);
        continue;
      }
      throw this.statusError(res, url);
    }
  }

  async test(): Promise<void> {
    await this.page(`${BASE}/`);
  }

  private async searchTitles(q: string): Promise<{ path: string; text: string }[]> {
    const html = await this.page(`${BASE}/subtitles/searchbytitle?query=${encodeURIComponent(q)}&l=`);
    if (!html) return [];
    const scope = byClass(html, 'div', 'search-result')[0]?.inner ?? html;
    const seen = new Set<string>();
    const out: { path: string; text: string }[] = [];
    for (const a of anchors(scope)) {
      const m = /^(?:https?:\/\/[^/]+)?(\/subtitles\/[^/?#]+)\/?$/.exec(a.href);
      if (!m || m[1] === '/subtitles/searchbytitle' || seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      out.push({ path: m[1]!, text: a.text });
    }
    return out;
  }

  private async moviePaths(query: SubtitleQuery): Promise<string[]> {
    const rank = (results: { path: string; text: string }[]) =>
      results
        .map((r) => {
          const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(r.text);
          return { ...r, title: m ? m[1]! : r.text, year: m ? Number(m[2]) : undefined };
        })
        .filter((r) => query.year === undefined || r.year === query.year)
        .map((r) => ({ path: r.path, score: similarity(r.title, query.title) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((r) => r.path);
    let paths = rank(await this.searchTitles(query.title));
    if (paths.length === 0 && query.imdbId) paths = rank(await this.searchTitles(query.imdbId));
    return paths;
  }

  private async episodePaths(query: SubtitleQuery): Promise<string[]> {
    const season = query.season!;
    const ordinal = seasonOrdinal(season);
    const results = await this.searchTitles(query.title);
    return results
      .filter((r) => {
        const t = r.text.toLowerCase();
        if (/complete/.test(t)) return true;
        if (ordinal && new RegExp(`\\b${ordinal} season\\b`).test(t)) return true;
        return new RegExp(`\\bseason ${season}\\b`).test(t);
      })
      .map((r) => {
        const show = r.text.split(/\s+-\s+|\s*\(/)[0] ?? r.text;
        const bonus = query.year !== undefined && r.text.includes(String(query.year)) ? 0.1 : 0;
        return { path: r.path, score: similarity(show, query.title) + bonus };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((r) => r.path);
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok) return [];
    const isEpisode = query.mediaType === 'episode';
    const paths = isEpisode ? await this.episodePaths(query) : await this.moviePaths(query);
    const wantedImdb = isEpisode ? query.seriesImdbId : query.imdbId;
    const langs = this.wantedLanguages(query).filter((w) => !w.forced);

    for (const path of paths) {
      const found: SubtitleCandidate[] = [];
      for (const w of langs) {
        const slug = subf2mLanguageSlug(w.tag);
        if (!slug) continue;
        const listUrl = `${BASE}${path}/${slug}`;
        const html = await this.page(listUrl);
        if (!html) continue;
        const pageImdb = /imdb\.com\/title\/(tt\d+)/i.exec(html)?.[1];
        if (pageImdb && wantedImdb && pageImdb !== wantedImdb) continue;
        for (const item of byClass(html, 'li', 'item')) {
          const c = this.parseItem(item.inner, query, w.tag, `${path}/${slug}/`, Boolean(pageImdb && pageImdb === wantedImdb));
          if (c) found.push(c);
        }
      }
      // First productive path wins.
      if (found.length > 0) return found;
    }
    return [];
  }

  private parseItem(
    html: string,
    query: SubtitleQuery,
    tag: LanguageTag,
    linkPrefix: string,
    imdbVerified: boolean,
  ): SubtitleCandidate | undefined {
    const link = anchors(html).find((a) => a.href.startsWith(linkPrefix) || a.href.includes(linkPrefix));
    if (!link) return undefined;
    const scroll = byClass(html, 'ul', 'scrolllist')[0]?.inner ?? '';
    const releases = findElements(scroll, 'li').map((li) => textContent(li.inner)).filter(Boolean);
    const commentCol = byClass(html, 'div', 'comment-col')[0]?.inner ?? '';
    const uploader = anchors(commentCol)[0]?.text || undefined;
    const comment = textContent(findElements(commentCol, 'p')[0]?.inner ?? '');
    const releaseInfo = [...releases, ...(comment ? [comment] : [])].join('\n');

    const matches: MatchKey[] = [];
    let isPack = false;
    let episode: number | undefined;
    if (query.mediaType === 'episode') {
      const season = query.season!;
      const infos = releases.map(parseEpisodeInfo);
      const exact = infos.some((i) => i.season === season && i.episode === query.episode);
      const pack =
        infos.some((i) => i.season === season && i.episode === undefined) ||
        infos.some((i) => i.completeSeries) ||
        infos.some((i) => i.seasonRange !== undefined && i.seasonRange[0] <= season && season <= i.seasonRange[1]);
      if (!exact && !pack) return undefined;
      isPack = !exact;
      episode = query.episode;
      matches.push('series', 'season', 'episode');
      if (query.year !== undefined) matches.push('year');
      if (imdbVerified) matches.push('series_imdb_id');
    } else {
      matches.push('title');
      if (query.year !== undefined) matches.push('year');
      if (imdbVerified) matches.push('imdb_id');
    }
    const id = link.href.replace(/^https?:\/\/[^/]+/, '');
    return this.candidate({
      id,
      language: tag,
      forced: false,
      hi: false,
      releaseInfo,
      pageUrl: absoluteUrl(link.href, BASE),
      uploader,
      matches,
      isPack,
      season: query.season,
      episode,
    });
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    if (!candidate.pageUrl) throw this.error('bad-response', 'candidate has no page link');
    const html = await this.page(candidate.pageUrl);
    if (!html) throw this.error('not-found', 'subtitle page is gone');
    const button =
      findElements(html, 'a', (o) => getAttr(o, 'id') === 'downloadButton')[0] ??
      findElements(html, 'a', (o) => /\/download\/?$/.test(getAttr(o, 'href') ?? ''))[0];
    const href = button ? getAttr(button.open, 'href') : undefined;
    if (!href) throw this.error('api-throttled', 'download button not found');
    const res = await this.request(absoluteUrl(href, BASE), { headers: this.headers(candidate.pageUrl) });
    if (!res.ok) throw this.statusError(res, 'download');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const isRar = bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21;
    if (!isZip && !isRar) throw this.error('api-throttled', 'download is not a valid archive');
    return this.file(bytes, isZip ? 'subf2m.zip' : 'subf2m.rar');
  }
}
