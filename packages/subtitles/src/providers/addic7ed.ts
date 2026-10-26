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
import { absoluteUrl, anchors, findElements, getAttr, textContent } from './html.js';

// Addic7ed: HTML scraper (text-style matching). Login may be walled by reCAPTCHA; with no
// solver available that surfaces as a 'captcha' error.

const BASE = 'https://www.addic7ed.com';

/** Addic7ed language names (site spellings) to tags. Several names collapse to one tag. */
const NAME_TO_TAG: ReadonlyArray<readonly [string, LanguageTag]> = [
  ['Albanian', 'sq'], ['Arabic', 'ar'], ['Armenian', 'hy'], ['Azerbaijani', 'az'], ['Bengali', 'bn'],
  ['Bosnian', 'bs'], ['Bulgarian', 'bg'], ['Català', 'ca'], ['Chinese (Simplified)', 'zh'],
  ['Chinese (Traditional)', 'zh'], ['Croatian', 'hr'], ['Czech', 'cs'], ['Danish', 'da'], ['Dutch', 'nl'],
  ['English', 'en'], ['Estonian', 'et'], ['Euskera', 'eu'], ['Finnish', 'fi'], ['French', 'fr'],
  ['French (Canadian)', 'fr-CA'], ['Galego', 'gl'], ['German', 'de'], ['Greek', 'el'], ['Hebrew', 'he'],
  ['Hindi', 'hi'], ['Hungarian', 'hu'], ['Icelandic', 'is'], ['Indonesian', 'id'], ['Italian', 'it'],
  ['Japanese', 'ja'], ['Korean', 'ko'], ['Latvian', 'lv'], ['Lithuanian', 'lt'], ['Macedonian', 'mk'],
  ['Malay', 'ms'], ['Norwegian', 'no'], ['Persian', 'fa'], ['Polish', 'pl'], ['Portuguese', 'pt'],
  ['Portuguese (Brazilian)', 'pt-BR'], ['Romanian', 'ro'], ['Russian', 'ru'], ['Serbian (Cyrillic)', 'sr-Cyrl'],
  ['Serbian (Latin)', 'sr-Latn'], ['Slovak', 'sk'], ['Slovenian', 'sl'], ['Spanish', 'es'],
  ['Spanish (Latin America)', 'es'], ['Spanish (Spain)', 'es'], ['Swedish', 'sv'], ['Tamil', 'ta'],
  ['Thai', 'th'], ['Turkish', 'tr'], ['Ukrainian', 'uk'], ['Vietnamese', 'vi'],
];
const nameMap = new Map(NAME_TO_TAG.map(([n, t]) => [n.toLowerCase(), t]));
const tagMap = new Map<LanguageTag, string>();
for (const [n, t] of NAME_TO_TAG) if (!tagMap.has(t)) tagMap.set(t, n);

/** Addic7ed language name to tag ("Portuguese (Brazilian)" -> "pt-BR"). */
export function addic7edLanguageFromName(name: string): LanguageTag | undefined {
  return nameMap.get(name.trim().toLowerCase());
}

/** Tag to the Addic7ed spelling ("ca" -> "Català"); base tags only for region-less input. */
export function addic7edLanguageName(tag: LanguageTag): string | undefined {
  return tagMap.get(tag);
}

export const ADDIC7ED_LANGUAGES: ReadonlySet<LanguageTag> = new Set(NAME_TO_TAG.map(([, t]) => t));

/** Lowercase, drop apostrophes, punctuation to spaces, collapse. */
export function sanitizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[-:()._,!?/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Addic7edConfig {
  username?: string | undefined;
  password?: string | undefined;
  /** Raw cookie string; overrides login. */
  cookies?: string | undefined;
  vip?: boolean | undefined;
}

const DAY = 24 * 3600 * 1000;
const SHOW_LIST_TTL = 7 * DAY;

export class Addic7edProvider extends BaseProvider {
  readonly kind = 'addic7ed' as const;
  readonly needsAuth = true;
  readonly rateLimit: RateLimit = {
    minIntervalMs: 1000,
    requestTimeoutMs: 10_000,
    throttle: {
      'daily-limit': { kind: 'duration', ms: 3 * 3600_000 },
      'rate-limited': { kind: 'duration', ms: 5 * 60_000 },
      captcha: { kind: 'duration', ms: 3600_000 },
    },
  };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['title', 'season-episode'],
    languages: ADDIC7ED_LANGUAGES,
    forced: false,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };

  private readonly config: Addic7edConfig;
  private cookie: string | undefined;
  private sessionChecked = false;
  private shows: Map<string, number> | undefined;
  private showsFetchedAt = 0;
  private readonly downloadsLog: number[] = [];

  constructor(config: Addic7edConfig, ctx?: ProviderContext) {
    super(ctx);
    const hasCookies = Boolean(config.cookies?.trim());
    const hasLogin = Boolean(config.username?.trim() && config.password);
    if (!hasCookies && !hasLogin) {
      throw this.error('config', 'either cookies or username and password are required');
    }
    this.config = config;
    this.cookie = hasCookies ? config.cookies!.trim() : undefined;
  }

  get dailyCap(): number {
    return this.config.vip ? 80 : 40;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra };
  }

  /** Make sure we hold a valid session (cookie check or password login). */
  async ensureSession(): Promise<void> {
    if (this.sessionChecked) return;
    if (this.cookie) {
      const res = await this.request(`${BASE}/panel.php`, { headers: this.headers(), redirect: 'manual' });
      if (res.status === 302 || res.status === 301) {
        if (this.config.cookies) throw this.error('auth', 'cookies not valid anymore');
        this.cookie = undefined;
      } else {
        this.sessionChecked = true;
        return;
      }
    }
    await this.login();
    this.sessionChecked = true;
  }

  private async login(): Promise<void> {
    const page = await this.request(`${BASE}/login.php`, { headers: this.headers() });
    const html = await page.text();
    if (/g-recaptcha|data-sitekey/i.test(html)) {
      throw this.error('captcha', 'login page requires a reCAPTCHA (no solver configured)');
    }
    const body = new URLSearchParams({
      username: this.config.username ?? '',
      password: this.config.password ?? '',
      remember: 'true',
      url: '',
      Submit: 'Log in',
    });
    const res = await this.request(`${BASE}/dologin.php`, {
      method: 'POST',
      body,
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/login.php` }),
      redirect: 'manual',
    });
    const text = res.status === 302 ? '' : await res.text();
    if (/relax, slow down/i.test(text)) throw this.error('rate-limited', 'login throttled by the site');
    if (/wrong password|doesn't exist/i.test(text)) throw this.error('auth', 'login rejected');
    if (res.status !== 302) throw this.error('auth', `login failed (status ${res.status})`);
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).filter(Boolean);
    this.cookie = cookies.length > 0 ? cookies.join('; ') : this.cookie;
    await this.sleep(2000);
  }

  async test(): Promise<void> {
    await this.ensureSession();
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok) return [];
    await this.ensureSession();
    return query.mediaType === 'episode' ? this.searchEpisode(query) : this.searchMovie(query);
  }

  // ---- shows ----------------------------------------------------------------------------

  private async loadShows(force = false): Promise<Map<string, number>> {
    if (!force && this.shows && this.now() - this.showsFetchedAt < SHOW_LIST_TTL) return this.shows;
    const html = await this.getText(`${BASE}/shows.php`, { headers: this.headers() });
    const map = new Map<string, number>();
    for (const a of anchors(html)) {
      const m = /^\/?show\/(\d+)/.exec(a.href);
      if (!m || !a.text) continue;
      const id = Number(m[1]);
      const key = sanitizeName(a.text);
      if (!map.has(key)) map.set(key, id);
      // "Show (2019)" and "Show (US)": also index without the suffix.
      const stripped = sanitizeName(a.text.replace(/\s*\((?:\d{4}|[A-Z]{2})\)\s*$/, ''));
      if (stripped !== key && !map.has(stripped)) map.set(stripped, id);
    }
    if (map.size === 0) throw this.error('bad-response', 'no show ids found');
    this.shows = map;
    this.showsFetchedAt = this.now();
    return map;
  }

  private nameVariants(title: string): string[] {
    const out = [title, title.replace(/\./g, ''), title.replace(/&/g, 'and'), title.replace(/\band\b/gi, '&')];
    return [...new Set(out.map(sanitizeName).filter(Boolean))];
  }

  private lookup(map: Map<string, number>, title: string, year?: number): { id: number; withYear: boolean } | undefined {
    for (const name of this.nameVariants(title)) {
      if (year !== undefined) {
        const y = map.get(`${name} ${year}`);
        if (y !== undefined) return { id: y, withYear: true };
      }
      const plain = map.get(name);
      if (plain !== undefined) return { id: plain, withYear: false };
    }
    return undefined;
  }

  /** Resolve a show id from the cached list, refreshing once if stale, else via site search. */
  async resolveShowId(title: string, year?: number): Promise<{ id: number; withYear: boolean } | undefined> {
    let map: Map<string, number>;
    try {
      map = await this.loadShows();
    } catch {
      return this.searchShow(title);
    }
    const hit = this.lookup(map, title, year);
    if (hit) return hit;
    if (this.now() - this.showsFetchedAt > DAY) {
      map = await this.loadShows(true);
      return this.lookup(map, title, year);
    }
    return undefined;
  }

  private async searchShow(title: string): Promise<{ id: number; withYear: boolean } | undefined> {
    const wanted = sanitizeName(title);
    const html = await this.getText(`${BASE}/srch.php?search=${encodeURIComponent(title)}&Submit=Search`, {
      headers: this.headers(),
    });
    for (const a of anchors(html)) {
      const m = /^\/?show\/(\d+)/.exec(a.href);
      if (m && sanitizeName(a.text) === wanted) return { id: Number(m[1]), withYear: false };
    }
    return undefined;
  }

  private async searchEpisode(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const titles = [query.title, ...(query.alternativeTitles ?? []).slice(0, 5)];
    let show: { id: number; withYear: boolean } | undefined;
    for (const t of titles) {
      show = await this.resolveShowId(t, query.year);
      if (show) break;
    }
    if (!show) return [];
    const season = query.season!;
    const episode = query.episode!;
    const url = `${BASE}/ajax_loadShow.php?show=${show.id}&season=${season}&langs=&hd=0&hi=0`;
    const html = await this.getText(url, {
      headers: this.headers({ Referer: `${BASE}/show/${show.id}`, 'X-Requested-With': 'XMLHttpRequest' }),
    });
    const out: SubtitleCandidate[] = [];
    for (const row of findElements(html, 'tr')) {
      const cells = findElements(row.inner, 'td');
      if (cells.length < 10) continue;
      const rowSeason = Number(textContent(cells[0]!.inner));
      const rowEpisode = Number(textContent(cells[1]!.inner));
      if (rowSeason !== season || rowEpisode !== episode) continue;
      const status = textContent(cells[5]!.inner);
      if (/%/.test(status)) continue;
      const tag = addic7edLanguageFromName(textContent(cells[3]!.inner));
      if (!tag || !this.isWanted(query, tag, false)) continue;
      const link = anchors(cells[9]!.inner).find((a) => /^\/?(?:original|updated)\//.test(a.href));
      if (!link) continue;
      const pageHref = anchors(cells[2]!.inner)[0]?.href;
      const hi = textContent(cells[6]!.inner).length > 0 || /<img/i.test(cells[6]!.inner);
      const matches: MatchKey[] = ['series', 'season', 'episode'];
      if (show.withYear || query.originalSeries) matches.push('year');
      out.push(
        this.candidate({
          id: link.href.replace(/^\//, ''),
          language: tag,
          forced: false,
          hi,
          releaseInfo: textContent(cells[4]!.inner),
          downloadUrl: absoluteUrl(link.href, BASE),
          pageUrl: pageHref ? absoluteUrl(pageHref, BASE) : `${BASE}/show/${show.id}`,
          matches,
          season: rowSeason,
          episode: rowEpisode,
        }),
      );
    }
    return out;
  }

  private async searchMovie(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const html = await this.getText(`${BASE}/srch.php?search=${encodeURIComponent(query.title)}&Submit=Search`, {
      headers: this.headers(),
    });
    const wanted = sanitizeName(query.title);
    let movieId: number | undefined;
    for (const a of anchors(html)) {
      const m = /^\/?movie\/(\d+)/.exec(a.href);
      if (!m) continue;
      const tm = /^(.*?)\s*\((\d{4})\)\s*$/.exec(a.text);
      const name = sanitizeName(tm ? tm[1]! : a.text);
      const year = tm ? Number(tm[2]) : undefined;
      if (name === wanted && (query.year === undefined || year === query.year)) {
        movieId = Number(m[1]);
        break;
      }
    }
    if (movieId === undefined) return [];
    const pageUrl = `${BASE}/movie/${movieId}`;
    const page = await this.getText(pageUrl, { headers: this.headers() });
    const out: SubtitleCandidate[] = [];
    const blocks = page.split(/<div id="container95m"/i).slice(1);
    for (const block of blocks) {
      const version = /Version\s+(.*?),/i.exec(textContent(block))?.[1]?.trim() ?? '';
      const hi = /title="Hearing Impaired"/i.test(block) || /hi\.jpg/i.test(block);
      const uploader = anchors(block).find((a) => /^\/?user\//.test(a.href))?.text;
      const langCells = [...block.matchAll(/<td[^>]*class="language"[^>]*>([\s\S]*?)<\/td>/gi)];
      langCells.forEach((cell, i) => {
        const start = cell.index;
        const end = langCells[i + 1]?.index ?? block.length;
        const slice = block.slice(start, end);
        const tag = addic7edLanguageFromName(textContent(cell[1]!));
        if (!tag || !this.isWanted(query, tag, false)) return;
        if (/\d+(?:\.\d+)?%\s*Completed/i.test(textContent(slice))) return;
        const link = findElements(slice, 'a', (o) => /buttonDownload/.test(getAttr(o, 'class') ?? ''))[0];
        const href = link ? getAttr(link.open, 'href') : undefined;
        if (!href) return;
        out.push(
          this.candidate({
            id: href.replace(/^\//, ''),
            language: tag,
            forced: false,
            hi,
            releaseInfo: version,
            downloadUrl: absoluteUrl(href, BASE),
            pageUrl,
            uploader,
            matches: ['title', 'year'],
          }),
        );
      });
    }
    return out;
  }

  // ---- download -------------------------------------------------------------------------

  /** Downloads in the trailing 24 hours. */
  downloadsToday(): number {
    const cutoff = this.now() - DAY;
    while (this.downloadsLog.length > 0 && this.downloadsLog[0]! <= cutoff) this.downloadsLog.shift();
    return this.downloadsLog.length;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    if (!candidate.downloadUrl) throw this.error('bad-response', 'candidate has no download link');
    if (this.downloadsToday() >= this.dailyCap) {
      throw this.error('daily-limit', `local daily cap of ${this.dailyCap} downloads reached`);
    }
    await this.ensureSession();
    const res = await this.request(candidate.downloadUrl, {
      headers: this.headers(candidate.pageUrl ? { Referer: candidate.pageUrl } : {}),
    });
    if (res.status === 304) throw this.error('rate-limited', 'download answered 304');
    if (!res.ok) throw this.statusError(res, 'download');
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      throw this.error('daily-limit', 'download returned an HTML page (daily quota used)');
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Counted after success; the content is returned even when this download hits the cap.
    this.downloadsLog.push(this.now());
    return this.file(bytes, 'addic7ed.srt');
  }
}
