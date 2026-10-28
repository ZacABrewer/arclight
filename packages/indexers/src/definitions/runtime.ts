/**
 * Definition runtime: executes a parsed site definition (spec S8 login, S9 search,
 * S10 field mapping, S11 download, S12 test, S13 request lifecycle).
 *
 * All HTTP goes through one `request()` helper that follows redirects manually so cookies
 * set on intermediate 3xx responses (typical for login submits) land in the jar.
 */
import {
  getAttribute,
  matches,
  parseHtml,
  parseXml,
  previousElementSibling,
  querySelector,
  querySelectorAll,
  removeMatching,
  textContent,
  appendChild,
  detach,
  type HtmlDocument,
  type HtmlElement,
  type HtmlParent,
} from '../html/index.js';
import { createProxiedFetch, isChallengeResponse, isFlareSolverr, type ProxyConfig } from '../proxy.js';
import { createRateLimiter, defaultSleep } from '../rate-limit.js';
import { IndexerError, type ReleaseInfo, type SearchRequest } from '../types.js';
import { buildCategoryMap, mapFromDesc, mapFromTracker, mapToTracker, type CategoryMap } from './categories.js';
import { CookieJar } from './cookies.js';
import { parseDateValue, toIsoString } from './dates.js';
import { decodeBytes, formEncode, pathEncode, serializePairs } from './encoding.js';
import { applyFilters, type FilterContext, type FilterSpec } from './filters.js';
import { jsonQuery, jsonSelectRows, jsonToString, type JsonValue } from './jsonpath.js';
import { extractId, parseDecimal, parseInteger, parseSize } from './numbers.js';
import type { Definition, DownloadSelector, ErrorBlock, SearchPathDefinition, SelectorBlock } from './schema.js';
import { renderTemplate, type TemplateValue, type TemplateVars } from './template.js';

export type SettingsValue = string | number | boolean | null | undefined | readonly string[];
export type SettingsValues = Record<string, SettingsValue>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeOptions {
  /** Base fetch (tests inject fakes). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Outgoing proxies (HTTP/SOCKS5 tunnel and/or FlareSolverr). */
  proxy?: ProxyConfig | readonly ProxyConfig[];
  /** Cookie jar to use (e.g. restored from storage); a fresh one otherwise. */
  jar?: CookieJar;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum spacing between requests; the effective delay is max(this, requestDelay). */
  rateLimitMs?: number;
  /** Per-request timeout; default 100 s. */
  timeoutMs?: number;
  userAgent?: string;
  indexerId?: number;
  /** Interactive searches keep releases without size/categories (S10.7). */
  interactive?: boolean;
  signal?: AbortSignal;
  log?: (level: LogLevel, message: string) => void;
}

/** Torznab categories may be attached to any request. */
export type DefinitionSearchRequest = SearchRequest & { categories?: readonly number[] };

/** Account statistics scraped through a definition's `account` block (absent fields were not found). */
export interface AccountStats {
  ratio?: number;
  /** Bytes. */
  uploaded?: number;
  /** Bytes. */
  downloaded?: number;
  /** Bytes. */
  buffer?: number;
  hnrCount?: number;
  seedBonus?: number;
}

const ACCOUNT_FIELDS: Record<string, { key: keyof AccountStats; parse: (raw: string) => number | undefined }> = {
  ratio: { key: 'ratio', parse: (raw) => parseDecimal(raw) },
  uploaded: { key: 'uploaded', parse: (raw) => parseSize(raw) },
  upload: { key: 'uploaded', parse: (raw) => parseSize(raw) },
  downloaded: { key: 'downloaded', parse: (raw) => parseSize(raw) },
  download: { key: 'downloaded', parse: (raw) => parseSize(raw) },
  buffer: { key: 'buffer', parse: (raw) => parseSize(raw) },
  hnrcount: { key: 'hnrCount', parse: (raw) => parseInteger(raw) },
  hnr: { key: 'hnrCount', parse: (raw) => parseInteger(raw) },
  seedbonus: { key: 'seedBonus', parse: (raw) => parseDecimal(raw) },
};

export type DownloadResult =
  | { kind: 'torrent'; data: Uint8Array; url: string; contentType?: string }
  | { kind: 'magnet'; magnetUrl: string };

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 100_000;
const MAX_REDIRECTS = 10;
const COOKIE_LIFETIME_MS = 30 * 24 * 3600 * 1000;
const SEEDER_CAP = 5_000_000;

export const PUBLIC_TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
];

const KNOWN_FIELDS = new Set([
  'category', 'categorydesc', 'title', 'description', 'details', 'comments', 'download', 'magnet', 'infohash', 'size',
  'date', 'seeders', 'leechers', 'grabs', 'files', 'downloadvolumefactor', 'uploadvolumefactor', 'minimumratio',
  'minimumseedtime', 'imdb', 'imdbid', 'tmdbid', 'tvdbid', 'rageid', 'tvmazeid', 'traktid', 'doubanid', 'poster',
  'banner', 'genre', 'year', 'author', 'booktitle', 'publisher', 'artist', 'album', 'label', 'track',
]);
const IMPLICIT_OPTIONAL = new Set([
  'imdb', 'imdbid', 'tmdbid', 'rageid', 'tvdbid', 'tvmazeid', 'traktid', 'doubanid', 'poster', 'banner', 'description', 'genre',
]);

class FieldError extends Error {}

/** A request that never got an HTTP response (DNS, refused, reset, timeout). */
class NetworkFailure extends IndexerError {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean, cause: unknown) {
    super('unreachable', message, { cause });
    this.timedOut = timedOut;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  contentType?: string;
  followRedirects: boolean;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** Final URL after redirects. */
  url: string;
  /** Location of an unfollowed (or magnet) redirect. */
  location?: string;
}

/** Draft release assembled from fields before it becomes a ReleaseInfo. */
interface Draft {
  title?: string;
  description?: string;
  infoUrl?: string;
  commentUrl?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  guid?: string;
  size?: number;
  publishDate?: string;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  files?: number;
  downloadVolumeFactor?: number;
  uploadVolumeFactor?: number;
  minimumRatio?: number;
  minimumSeedTime?: number;
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  posterUrl?: string;
  genres?: string[];
  year?: number;
  categories: number[];
}

type RowTarget =
  | { kind: 'html'; node: HtmlParent; doc: HtmlDocument }
  | { kind: 'json'; value: JsonValue; outer: JsonValue };

// ---------------------------------------------------------------------------------------
// Settings and query variables

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Resolve the site base URL (S2.7): custom `baseUrl`/`sitelink` setting unless legacy. */
export function resolveSiteLink(def: Definition, values: SettingsValues): string {
  const custom = values['baseUrl'] ?? values['sitelink'];
  if (typeof custom === 'string' && custom.trim()) {
    const url = withSlash(custom.trim());
    if (!(def.legacylinks ?? []).includes(url)) return url;
  }
  return def.links[0] ?? '';
}

/** `.Config.*` variables (S3.2, S3.3, S3.6). */
export function resolveConfig(def: Definition, values: SettingsValues): TemplateVars {
  const vars: TemplateVars = { 'Config.sitelink': resolveSiteLink(def, values) };
  for (const s of def.settings) {
    if (s.type.startsWith('info') || s.type === 'cardigannCaptcha') continue;
    const raw = values[s.name] ?? s.default ?? null;
    switch (s.type) {
      case 'checkbox': {
        const on = raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') || raw === 1;
        vars[`Config.${s.name}`] = on ? 'True' : null;
        break;
      }
      case 'select': {
        const keys = Object.keys(s.options ?? {});
        const wanted = raw === null || raw === undefined ? undefined : String(raw);
        const fallback = s.default === undefined || s.default === null ? undefined : String(s.default);
        vars[`Config.${s.name}`] =
          wanted !== undefined && keys.includes(wanted) ? wanted : fallback !== undefined ? fallback : (keys[0] ?? null);
        break;
      }
      case 'multi-select': {
        const list = Array.isArray(raw) ? raw.map(String) : raw === null || raw === undefined ? (s.defaults ?? []).map(String) : [String(raw)];
        vars[`Config.${s.name}`] = list;
        break;
      }
      default:
        vars[`Config.${s.name}`] = raw === null || raw === undefined ? null : Array.isArray(raw) ? raw.join(',') : String(raw);
    }
  }
  return vars;
}

const QUERY_KEYS = [
  'Type', 'Q', 'Keywords', 'Categories', 'Limit', 'Offset', 'Extended', 'APIKey', 'Season', 'Ep', 'Episode', 'Series',
  'Movie', 'Year', 'Genre', 'IMDBID', 'IMDBIDShort', 'TMDBID', 'TVDBID', 'TVRageID', 'TVMazeID', 'TraktID', 'DoubanID',
  'Album', 'Artist', 'Label', 'Track', 'Author', 'Title', 'Publisher',
];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `.Query.*` variables for a request (S4.1). */
export function queryVariables(request: DefinitionSearchRequest): TemplateVars {
  const vars: TemplateVars = {};
  for (const k of QUERY_KEYS) vars[`Query.${k}`] = null;
  const set = (k: string, v: string | number | undefined): void => {
    if (v !== undefined && v !== '') vars[`Query.${k}`] = String(v);
  };
  let episode: string | undefined;
  let year: number | undefined;
  switch (request.kind) {
    case 'rss':
      set('Type', 'search');
      break;
    case 'search':
      set('Type', 'search');
      set('Q', request.query.trim());
      break;
    case 'tv': {
      set('Type', 'tvsearch');
      set('Q', request.query?.trim());
      if (request.airDate && /^\d{4}-\d{2}-\d{2}$/.test(request.airDate)) {
        episode = request.airDate.replace(/-/g, '.');
        set('Season', request.airDate.slice(0, 4));
        set('Ep', request.airDate.slice(5).replace('-', '/'));
      } else {
        set('Season', request.season);
        set('Ep', request.episode);
        if (request.season !== undefined) {
          episode = `S${pad(request.season)}${request.episode !== undefined ? `E${pad(request.episode)}` : ''}`;
        }
      }
      set('Episode', episode);
      set('TVDBID', request.tvdbId);
      set('TMDBID', request.tmdbId);
      if (request.imdbId) {
        const digits = request.imdbId.replace(/\D/g, '');
        set('IMDBID', `tt${digits.padStart(7, '0')}`);
        set('IMDBIDShort', digits);
      }
      break;
    }
    case 'movie':
      set('Type', 'movie');
      set('Q', request.query?.trim());
      year = request.year;
      set('Year', year);
      set('TMDBID', request.tmdbId);
      if (request.imdbId) {
        const digits = request.imdbId.replace(/\D/g, '');
        set('IMDBID', `tt${digits.padStart(7, '0')}`);
        set('IMDBIDShort', digits);
      }
      break;
    case 'music': {
      set('Type', 'music');
      set('Artist', request.artist?.trim());
      set('Album', request.album?.trim());
      set('Label', request.label?.trim());
      year = request.year;
      set('Year', year);
      // Sites without structured music search see "{artist} {album}" as the query.
      const q = request.query?.trim() || [request.artist, request.album].map((p) => p?.trim() ?? '').filter(Boolean).join(' ');
      set('Q', q);
      break;
    }
    case 'book': {
      set('Type', 'book');
      set('Author', request.author?.trim());
      set('Title', request.title?.trim());
      const q = request.query?.trim() || [request.author, request.title].map((p) => p?.trim() ?? '').filter(Boolean).join(' ');
      set('Q', q);
      break;
    }
  }
  const q = vars['Query.Q'];
  const keywords = [typeof q === 'string' ? q : '', year === undefined ? '' : String(year), episode ?? '']
    .filter(Boolean)
    .join(' ');
  vars['Query.Keywords'] = keywords || null;
  vars['Query.Categories'] = (request.categories ?? []).map(String);
  return vars;
}

function todayVars(now: number): TemplateVars {
  return { 'Today.Year': String(new Date(now).getUTCFullYear()) };
}

// ---------------------------------------------------------------------------------------
// Misc helpers

function resolveUrl(value: string, base: string): string {
  try {
    return new URL(value.trim(), base).href;
  } catch {
    return value.trim();
  }
}

function firstHeaderValues(headers: Record<string, string[]> | undefined, vars: TemplateVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = v.map((x) => renderTemplate(x, vars).trim()).join(', ');
  return out;
}

function isHtmlContent(headers: Headers): boolean {
  const ct = headers.get('content-type');
  return !ct || /html/i.test(ct);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Normalise a 40-hex or 32-base32 info hash to lower-case hex; undefined if invalid. */
export function normalizeInfoHash(hash: string): string | undefined {
  const h = hash.trim();
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(h)) {
    let bits = '';
    for (const c of h.toUpperCase()) bits += BASE32.indexOf(c).toString(2).padStart(5, '0');
    let hex = '';
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex.slice(0, 40);
  }
  return undefined;
}

export function buildMagnet(infoHash: string, title: string | undefined, trackers: readonly string[] = PUBLIC_TRACKERS): string {
  let magnet = `magnet:?xt=urn:btih:${infoHash}`;
  if (title) magnet += `&dn=${encodeURIComponent(title)}`;
  for (const t of trackers) magnet += `&tr=${encodeURIComponent(t)}`;
  return magnet;
}

function hashFromMagnet(magnet: string): string | undefined {
  const m = /xt=urn:btih:([0-9a-z]+)/i.exec(magnet);
  return m?.[1] ? normalizeInfoHash(m[1]) : undefined;
}

function looksLikeTorrent(body: Uint8Array): boolean {
  return body.length > 0 && body[0] === 0x64; // 'd'
}

const STOP_WORDS = new Set(['and', 'the', 'an', 'of']);

/** S10.10 query re-filter. */
export function andMatch(query: string, release: { title: string; description?: string }): boolean {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  if (terms.length === 0) return true;
  const haystack = `${release.title} ${release.description ?? ''}`.toLowerCase();
  const hits = terms.filter((t) => haystack.includes(t)).length;
  return terms.length > 1 ? hits >= 2 : hits === 1;
}

// ---------------------------------------------------------------------------------------
// Runtime

export class DefinitionRuntime {
  readonly definition: Definition;
  readonly jar: CookieJar;
  readonly categoryMap: CategoryMap;
  private currentLink: string;
  private readonly config: TemplateVars;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: () => Promise<void>;
  private readonly now: () => number;
  private readonly options: RuntimeOptions;
  private readonly hasFlareSolverr: boolean;
  private loginPromise: Promise<void> | undefined;
  private loggedIn = false;

  constructor(definition: Definition, settings: SettingsValues = {}, options: RuntimeOptions = {}) {
    this.definition = definition;
    this.options = options;
    this.jar = options.jar ?? new CookieJar();
    this.now = options.now ?? Date.now;
    this.config = resolveConfig(definition, settings);
    this.currentLink = String(this.config['Config.sitelink']);
    this.categoryMap = buildCategoryMap(definition);
    const base = options.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = options.proxy ? createProxiedFetch(options.proxy, { fetchImpl: base, jar: this.jar }) : base;
    const proxies: readonly ProxyConfig[] = options.proxy === undefined ? [] : Array.isArray(options.proxy) ? options.proxy : [options.proxy as ProxyConfig];
    this.hasFlareSolverr = proxies.some(isFlareSolverr);
    const delay = Math.max(options.rateLimitMs ?? 0, (definition.requestdelay ?? 0) * 1000);
    this.limiter = createRateLimiter(delay, this.now, options.sleep ?? defaultSleep);
    if (this.jar.size > 0 && !this.jar.isExpired(this.now())) this.loggedIn = true;
  }

  /** Base URL in use; may move to another `links` mirror after a fallback or a followed redirect. */
  get siteLink(): string {
    return this.currentLink;
  }

  private useLink(link: string): void {
    if (link === this.currentLink) return;
    this.currentLink = link;
    this.config['Config.sitelink'] = link;
  }

  /** Mirrors to try, current first. A custom base URL outside `links` gets no fallback. */
  private linkCandidates(): string[] {
    const links = this.definition.links;
    if (!links.includes(this.currentLink)) return [this.currentLink];
    return [this.currentLink, ...links.filter((l) => l !== this.currentLink)];
  }

  /** The `links` entry on the given host, or undefined. */
  private linkForHost(host: string | undefined): string | undefined {
    return host === undefined ? undefined : this.definition.links.find((l) => hostOf(l) === host);
  }

  private isDefinitionHost(host: string | undefined): boolean {
    if (host === undefined) return false;
    return [...this.definition.links, ...(this.definition.legacylinks ?? [])].some((l) => hostOf(l) === host);
  }

  private log(level: LogLevel, message: string): void {
    this.options.log?.(level, `[${this.definition.id}] ${message}`);
  }

  private baseVars(): TemplateVars {
    return { ...this.config, ...todayVars(this.now()) };
  }

  private filterContext(vars: TemplateVars): FilterContext {
    return {
      vars,
      encoding: this.definition.encoding,
      now: this.now(),
      ...(this.definition.timezone === undefined ? {} : { timeZone: this.definition.timezone }),
      log: (m) => this.log('debug', m),
    };
  }

  // ------------------------------------------------------------------ HTTP

  /**
   * Send a request, falling back through the definition's `links` when a site URL fails
   * with a network error (DNS, refused, reset; not a timeout) or an HTTP 5xx. The first
   * mirror that answers becomes the site link for later requests.
   */
  private async request(req: HttpRequest): Promise<HttpResult> {
    const origin = this.currentLink;
    if (!origin || !req.url.startsWith(origin)) return this.requestOnce(req);
    const candidates = this.linkCandidates();
    if (candidates.length === 1) return this.requestOnce(req);
    const failures: string[] = [];
    for (const [i, link] of candidates.entries()) {
      const last = i === candidates.length - 1;
      const url = link + req.url.slice(origin.length);
      let result: HttpResult;
      try {
        result = await this.requestOnce({ ...req, url });
      } catch (err) {
        if (!(err instanceof NetworkFailure) || err.timedOut) throw err;
        failures.push(`${link} (${err.message})`);
        if (last) {
          throw new IndexerError('unreachable', `All site links failed: ${failures.join('; ')}`, { cause: err });
        }
        this.log('warn', `${link} unreachable (${err.message}); trying next link`);
        continue;
      }
      if (result.status >= 500 && result.status < 600 && !last) {
        failures.push(`${link} (HTTP ${result.status})`);
        this.log('warn', `${link} answered HTTP ${result.status}; trying next link`);
        continue;
      }
      if (i > 0 && this.currentLink === origin) {
        this.log('info', `using link ${link} (${origin} failed)`);
        this.useLink(link);
      }
      return result;
    }
    throw new IndexerError('unreachable', 'No site link to try');
  }

  /**
   * One request with manual redirect handling. A redirect to another host is followed once,
   * even when `followRedirects` is off, if that host belongs to the definition's
   * `links`/`legacylinks`; landing on a `links` host makes it the site link.
   */
  private async requestOnce(req: HttpRequest): Promise<HttpResult> {
    if (this.jar.isExpired(this.now())) {
      this.jar.clear();
      this.loggedIn = false;
    }
    await this.limiter();
    let url = req.url;
    let method = req.method;
    let body = req.body;
    let contentType = req.contentType;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    let crossHostFollowed = false;

    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {
        // With FlareSolverr the solved browser UA is injected by the proxy layer (S14.11).
        ...(this.options.userAgent || !this.hasFlareSolverr ? { 'User-Agent': this.options.userAgent ?? DEFAULT_USER_AGENT } : {}),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        ...req.headers,
      };
      const cookie = this.jar.header();
      if (cookie) headers['Cookie'] = cookie;
      if (contentType && body !== undefined) headers['Content-Type'] = contentType;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          redirect: 'manual',
          signal,
          ...(body === undefined ? {} : { body: typeof body === 'string' ? body : Buffer.from(body) }),
        });
      } catch (cause) {
        if (this.options.signal?.aborted) throw cause;
        const inner = cause instanceof Error && cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
        const message = `${cause instanceof Error ? cause.message : String(cause)}${inner}`;
        throw new NetworkFailure(`${timeout.aborted ? 'Timed out' : 'Request failed'}: ${message}`, timeout.aborted, cause);
      }
      this.jar.importResponse(response, this.now());
      const bytes = new Uint8Array(await response.arrayBuffer());
      const location = response.headers.get('location') ?? undefined;
      const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined;
      if (isRedirect && location.startsWith('magnet:')) {
        return { status: response.status, headers: response.headers, body: bytes, url, location };
      }
      const target = isRedirect ? resolveUrl(location, url) : undefined;
      const targetHost = target === undefined ? undefined : hostOf(target);
      const crossHost = target !== undefined && targetHost !== hostOf(url);
      const followKnownHost =
        crossHost && !req.followRedirects && !crossHostFollowed && hop < MAX_REDIRECTS && this.isDefinitionHost(targetHost);
      if (target !== undefined && ((req.followRedirects && hop < MAX_REDIRECTS) || followKnownHost)) {
        if (crossHost) {
          crossHostFollowed = true;
          const moved = this.linkForHost(targetHost);
          if (moved && this.isDefinitionHost(hostOf(url))) {
            this.log('info', `site redirected to ${moved}; using it as the site link`);
            this.useLink(moved);
          }
        }
        url = target;
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          contentType = undefined;
        }
        continue;
      }
      return {
        status: response.status,
        headers: response.headers,
        body: bytes,
        url,
        ...(isRedirect ? { location: resolveUrl(location, url) } : {}),
      };
    }
  }

  private text(result: HttpResult, json = false): string {
    return decodeBytes(result.body, json ? 'utf-8' : this.definition.encoding);
  }

  private loginHeaders(vars: TemplateVars): Record<string, string> {
    return firstHeaderValues(this.definition.login?.headers ?? this.definition.search.headers, vars);
  }

  // ------------------------------------------------------------------ login (S8)

  /** True when the response indicates a lost session (S8.17). */
  private isLoggedOut(result: HttpResult): boolean {
    const login = this.definition.login;
    if (!login) return false;
    if (result.location !== undefined || (result.status >= 300 && result.status < 400)) return true;
    if (result.status >= 400) return true;
    const sel = login.test?.selector;
    if (sel && isHtmlContent(result.headers)) {
      try {
        return querySelector(parseHtml(this.text(result)), renderTemplate(sel, this.baseVars())) === null;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Log in (single flight). Resolves when the jar holds a session. */
  login(): Promise<void> {
    if (!this.loginPromise) {
      const pending = this.doLogin().finally(() => {
        if (this.loginPromise === pending) this.loginPromise = undefined;
      });
      this.loginPromise = pending;
    }
    return this.loginPromise;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.definition.login || this.loggedIn) return;
    await this.login();
  }

  private async doLogin(): Promise<void> {
    const login = this.definition.login;
    if (!login) return;
    const vars = this.baseVars();
    const headers = this.loginHeaders(vars);
    const enc = this.definition.encoding;
    const inputs = (): Array<[string, string]> =>
      Object.entries(login.inputs ?? {}).map(([k, v]) => [k, renderTemplate(v, vars)]);
    const seedCookies = (): void => {
      for (const c of login.cookies ?? []) this.jar.importCookieHeader(c);
    };
    const path = renderTemplate(login.path ?? '', vars);
    const loginUrl = resolveUrl(path, this.siteLink);
    this.loggedIn = false;
    let result: HttpResult;

    switch (login.method) {
      case 'cookie': {
        const cookie = this.config['Config.cookie'];
        this.jar.clear();
        if (typeof cookie !== 'string' || !cookie.trim()) throw new IndexerError('auth', 'Cookie setting is empty');
        this.jar.importCookieHeader(cookie);
        this.jar.expiresAt = this.now() + COOKIE_LIFETIME_MS;
        this.loggedIn = true;
        await this.verifyLogin(vars, headers);
        return;
      }
      case 'post':
        this.jar.clear();
        seedCookies();
        result = await this.request({
          url: loginUrl,
          method: 'POST',
          headers: { Referer: this.siteLink, ...headers },
          body: serializePairs(inputs(), enc),
          contentType: 'application/x-www-form-urlencoded',
          followRedirects: true,
        });
        break;
      case 'get': {
        this.jar.clear();
        const query = serializePairs(inputs(), enc);
        result = await this.request({
          url: query ? `${loginUrl}${loginUrl.includes('?') ? '&' : '?'}${query}` : loginUrl,
          method: 'GET',
          headers: { Referer: this.siteLink, ...headers },
          followRedirects: true,
        });
        break;
      }
      case 'oneurl': {
        this.jar.clear();
        const oneurl = renderTemplate(login.inputs?.['oneurl'] ?? '', vars);
        result = await this.request({
          url: resolveUrl(path + oneurl, this.siteLink),
          method: 'GET',
          headers: { Referer: this.siteLink, ...headers },
          followRedirects: true,
        });
        break;
      }
      case 'form':
        result = await this.formLogin(loginUrl, vars, headers);
        break;
    }

    if (result.status === 401) throw new IndexerError('auth', 'Login failed: HTTP 401', { status: 401 });
    this.checkLoginErrors(result, vars);
    this.jar.expiresAt = this.now() + COOKIE_LIFETIME_MS;
    this.loggedIn = true;
    await this.verifyLogin(vars, headers);
    this.log('info', 'logged in');
  }

  /** If `login.test` names a path and selector, fetch it and require a match. */
  private async verifyLogin(vars: TemplateVars, headers: Record<string, string>): Promise<void> {
    const test = this.definition.login?.test;
    if (!test?.path || !test.selector) return;
    const result = await this.request({
      url: resolveUrl(renderTemplate(test.path, vars), this.siteLink),
      method: 'GET',
      headers,
      followRedirects: true,
    });
    const doc = parseHtml(this.text(result));
    if (querySelector(doc, renderTemplate(test.selector, vars)) === null) {
      this.loggedIn = false;
      throw new IndexerError('auth', 'Login failed: the logged-in check did not match (check credentials)');
    }
  }

  private checkLoginErrors(result: HttpResult, vars: TemplateVars): void {
    const blocks = this.definition.login?.error;
    if (!blocks?.length) return;
    const doc = parseHtml(this.text(result));
    for (const block of blocks) {
      const message = this.errorBlockMessage(block, doc, vars);
      if (message !== undefined) throw new IndexerError('auth', `Login failed: ${message}`);
    }
  }

  private errorBlockMessage(block: ErrorBlock, doc: HtmlDocument, vars: TemplateVars): string | undefined {
    let el: HtmlElement | null;
    try {
      el = querySelector(doc, renderTemplate(block.selector, vars));
    } catch {
      return undefined;
    }
    if (!el) return undefined;
    if (block.message) {
      try {
        const m = this.evalBlock(block.message, { kind: 'html', node: doc, doc }, vars, true);
        if (m) return m.trim();
      } catch {
        // fall back to the matched element text
      }
    }
    return textContent(el).trim() || 'unknown error';
  }

  private async formLogin(loginUrl: string, vars: TemplateVars, headers: Record<string, string>): Promise<HttpResult> {
    const login = this.definition.login;
    if (!login) throw new Error('unreachable');
    const enc = this.definition.encoding;
    for (const c of login.cookies ?? []) this.jar.importCookieHeader(c);
    const landing = await this.request({
      url: loginUrl,
      method: 'GET',
      headers: { Referer: this.siteLink, ...headers },
      followRedirects: this.definition.followredirect === true,
    });
    const landingUrl = landing.url;
    const doc = parseHtml(this.text(landing));
    const formSelector = login.form ?? 'form';
    const form = querySelector(doc, formSelector);
    if (!form) throw new IndexerError('auth', `No form found on ${landingUrl} using form selector ${formSelector}`);

    if (login.captcha?.selector && querySelector(doc, login.captcha.selector)) {
      throw new IndexerError('auth', 'Login failed: captcha required (captcha login is not supported)');
    }

    const pairs = new Map<string, string>();
    for (const input of querySelectorAll(form, 'input')) {
      const name = getAttribute(input, 'name');
      if (!name || getAttribute(input, 'disabled') !== undefined) continue;
      const type = (getAttribute(input, 'type') ?? 'text').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && getAttribute(input, 'checked') === undefined) continue;
      if (type === 'submit' || type === 'image' || type === 'button' || type === 'reset') continue;
      pairs.set(name, getAttribute(input, 'value') ?? '');
    }
    for (const [key, value] of Object.entries(login.inputs ?? {})) {
      let name = key;
      if (login.selectors) {
        const el = querySelector(doc, key);
        const elName = el ? getAttribute(el, 'name') : undefined;
        if (!elName) throw new IndexerError('auth', `Login input selector "${key}" not found on ${landingUrl}`);
        name = elName;
      }
      pairs.set(name, renderTemplate(value, vars));
    }
    const target: RowTarget = { kind: 'html', node: doc, doc };
    for (const [key, block] of Object.entries(login.selectorinputs ?? {})) {
      const value = this.evalBlockSafe(block, target, vars, `selectorinputs.${key}`);
      if (value !== null) pairs.set(key, value);
    }
    const getPairs: Array<[string, string]> = [];
    for (const [key, block] of Object.entries(login.getselectorinputs ?? {})) {
      const value = this.evalBlockSafe(block, target, vars, `getselectorinputs.${key}`);
      if (value !== null) getPairs.push([key, value]);
    }

    const action = login.submitpath ? renderTemplate(login.submitpath, vars) : (getAttribute(form, 'action') ?? '');
    let submitUrl = resolveUrl(action || landingUrl, login.submitpath ? this.siteLink : landingUrl);
    if (getPairs.length) submitUrl += `${submitUrl.includes('?') ? '&' : '?'}${serializePairs(getPairs, enc)}`;

    const multipart = /multipart\/form-data/i.test(getAttribute(form, 'enctype') ?? '');
    let body: string;
    let contentType: string;
    if (multipart) {
      const boundary = `----ArclightBoundary${Math.random().toString(16).slice(2)}`;
      body = [...pairs]
        .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
        .join('') + `--${boundary}--\r\n`;
      contentType = `multipart/form-data; boundary=${boundary}`;
    } else {
      body = serializePairs([...pairs], enc);
      contentType = 'application/x-www-form-urlencoded';
    }
    return this.request({
      url: submitUrl,
      method: 'POST',
      headers: { ...headers, Referer: landingUrl },
      body,
      contentType,
      followRedirects: true,
    });
  }

  private evalBlockSafe(block: SelectorBlock, target: RowTarget, vars: TemplateVars, what: string): string | null {
    try {
      return this.evalBlock(block, target, vars, block.optional !== true);
    } catch (err) {
      throw new IndexerError('auth', `Login: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fetch with relogin-once on a lost session (S13.6 step 3). */
  private async fetchAuthed(build: () => HttpRequest): Promise<HttpResult> {
    await this.ensureLoggedIn();
    let result = await this.request(build());
    if (this.definition.login && this.isLoggedOut(result)) {
      this.log('info', 'session lost; logging in again');
      this.loggedIn = false;
      await this.login();
      result = await this.request(build());
      // Still logged out on a normal page (test selector missing): the session did not stick.
      if (result.status === 200 && result.location === undefined && this.isLoggedOut(result)) {
        this.jar.clear();
        this.loggedIn = false;
        throw new IndexerError('auth', 'Session expired or login did not stick; recheck cookie/credentials');
      }
    }
    return result;
  }

  private flareSolverrRequired(): IndexerError {
    return new IndexerError(
      'unreachable',
      `${this.definition.name} is behind Cloudflare and requires a FlareSolverr proxy; attach a FlareSolverr proxy to this indexer`,
    );
  }

  private checkResponse(result: HttpResult): void {
    if (this.definition.requiresflaresolverr && !this.hasFlareSolverr && (result.status === 403 || result.status === 503)) {
      throw this.flareSolverrRequired();
    }
    if (!this.hasFlareSolverr) {
      const body = result.status === 403 || result.status === 503 ? this.text(result) : '';
      if (body && isChallengeResponse(result.status, result.headers, body)) {
        throw new IndexerError('unreachable', 'Cloudflare protection detected; a FlareSolverr proxy may be required', {
          status: result.status,
        });
      }
    }
    if (result.status === 429) throw new IndexerError('rate-limited', 'Request limit reached', { status: 429 });
    if (result.status >= 500) throw new IndexerError('unreachable', `HTTP ${result.status} from site`, { status: result.status });
    if (result.location !== undefined) {
      if (/login/i.test(result.location)) {
        this.jar.clear();
        this.loggedIn = false;
        throw new IndexerError('auth', 'Session expired or killed; recheck cookie/credentials');
      }
      const newHost = hostOf(result.location);
      if (newHost !== undefined && newHost !== hostOf(result.url) && this.isDefinitionHost(newHost)) {
        throw new IndexerError(
          'bad-response',
          `Redirected to ${result.location}: only one redirect to another site link is followed per request`,
          { status: result.status },
        );
      }
      if (newHost !== undefined && newHost !== hostOf(result.url)) {
        throw new IndexerError(
          'bad-response',
          `Redirected to ${result.location}: the site appears to have moved to ${newHost}, which is not in this definition's links`,
          { status: result.status },
        );
      }
      throw new IndexerError('bad-response', `Redirected to ${result.location}`, { status: result.status });
    }
    if (result.status === 401 || result.status === 403) {
      throw new IndexerError('auth', `HTTP ${result.status} from site`, { status: result.status });
    }
    if (result.status !== 200) throw new IndexerError('bad-response', `HTTP ${result.status} from site`, { status: result.status });
  }

  // ------------------------------------------------------------------ selectors (S5)

  private selectHtml(node: HtmlParent, selector: string, doc: HtmlDocument): HtmlElement | null {
    let sel = selector.trim();
    let ctx: HtmlParent = node;
    if (sel.startsWith(':root')) {
      sel = sel.slice(5).trim();
      ctx = doc;
      if (!sel) return doc.children.find((c): c is HtmlElement => c.type === 'element') ?? null;
      if (sel.startsWith('>')) sel = `:root ${sel}`;
    }
    if (ctx.type === 'element' && matches(ctx, sel)) return ctx;
    return querySelector(ctx, sel);
  }

  /**
   * Evaluate one selector block (S5.1). Returns null for a missing optional value; throws
   * FieldError when a required value is missing.
   */
  evalBlock(block: SelectorBlock, target: RowTarget, vars: TemplateVars, required: boolean): string | null {
    let value: string | null = null;
    if (block.text !== undefined && block.text !== null) {
      value = renderTemplate(block.text, vars);
    } else if (target.kind === 'html') {
      const sel = block.selector === undefined ? undefined : renderTemplate(block.selector, vars);
      const el = sel ? this.selectHtml(target.node, sel, target.doc) : target.node;
      if (el) {
        if (block.remove) removeMatching(el, block.remove);
        if (block.case) {
          for (const [key, mapped] of Object.entries(block.case)) {
            const hit = el.type === 'element' && (matches(el, key) || querySelector(el, key) !== null);
            if (hit || (el.type === 'document' && querySelector(el, key) !== null)) {
              value = renderTemplate(mapped, vars);
              break;
            }
          }
        } else if (block.attribute) {
          value = el.type === 'element' ? (getAttribute(el, block.attribute) ?? null) : null;
          if (value !== null) value = value.trim();
        } else {
          value = textContent(el).trim();
        }
      }
    } else {
      const sel = block.selector === undefined ? '' : renderTemplate(block.selector, vars);
      const found = sel.startsWith('..') ? jsonQuery(target.outer, sel.slice(2)) : jsonQuery(target.value, sel);
      let str = jsonToString(found);
      if (str !== null && block.attribute) str = jsonToString(jsonQuery(found ?? null, block.attribute));
      if (block.case) {
        for (const [key, mapped] of Object.entries(block.case)) {
          if (key === '*' || (str !== null && str === key)) {
            value = renderTemplate(mapped, vars);
            break;
          }
        }
      } else {
        value = str === null ? null : str.trim();
      }
    }

    if (value !== null) value = applyFilters(value, block.filters as FilterSpec[] | undefined, this.filterContext(vars));
    if ((value === null || value.trim() === '') && block.default !== undefined && block.default !== null && !required) {
      value = renderTemplate(block.default, vars);
    }
    if (value === null && required) throw new FieldError(`selector ${block.selector ?? '(self)'} matched nothing`);
    return value;
  }

  // ------------------------------------------------------------------ search (S9, S10)

  search(request: DefinitionSearchRequest): Promise<ReleaseInfo[]> {
    return this.runSearch(request, this.definition.search.paths);
  }

  private async runSearch(request: DefinitionSearchRequest, paths: readonly SearchPathDefinition[]): Promise<ReleaseInfo[]> {
    const search = this.definition.search;
    const vars: TemplateVars = { ...this.baseVars(), ...queryVariables(request) };
    const keywords = vars['Query.Keywords'];
    vars['Keywords'] =
      typeof keywords === 'string' ? applyFilters(keywords, search.keywordsfilters as FilterSpec[] | undefined, this.filterContext(vars)) : null;
    const trackerCats = mapToTracker(this.categoryMap, request.categories ?? []);

    const seenUrls = new Set<string>();
    const drafts: Array<{ draft: Draft }> = [];
    for (const path of paths) {
      const pathCats = this.narrowCategories(path, trackerCats);
      if (pathCats === undefined) continue;
      const pathVars: TemplateVars = { ...vars, Categories: pathCats };
      const req = this.buildSearchRequest(path, pathVars);
      if (req.method === 'GET') {
        if (seenUrls.has(req.url)) continue;
        seenUrls.add(req.url);
      }
      const result = await this.fetchAuthed(() => req);
      this.checkResponse(result);
      for (const draft of this.parseResults(path, result, pathVars)) drafts.push({ draft });
    }

    const releases: ReleaseInfo[] = [];
    const guids = new Set<string>();
    const andmatch = search.rows.filters?.some((f) => f.name.toLowerCase() === 'andmatch') ?? false;
    const query = typeof vars['Query.Q'] === 'string' ? vars['Query.Q'] : '';
    for (const { draft } of drafts) {
      const release = this.finalize(draft);
      if (!release || guids.has(release.guid)) continue;
      if (andmatch && request.kind === 'search' && query && !andMatch(query, release)) continue;
      guids.add(release.guid);
      releases.push(release);
    }
    return releases;
  }

  /** S9.7: undefined = skip this path; otherwise the `.Categories` for it. */
  private narrowCategories(path: SearchPathDefinition, trackerCats: string[]): string[] | undefined {
    const listed = path.categories;
    if (!listed?.length || trackerCats.length === 0) return trackerCats;
    const lower = (s: string): string => s.toLowerCase();
    if (listed[0] === '!') {
      const excluded = new Set(listed.slice(1).map(lower));
      const intersects = trackerCats.some((c) => excluded.has(lower(c)));
      if (intersects) return undefined;
      return trackerCats.filter((c) => !excluded.has(lower(c)));
    }
    const allowed = new Set(listed.map(lower));
    const inter = trackerCats.filter((c) => allowed.has(lower(c)));
    return inter.length === 0 ? undefined : inter;
  }

  private buildSearchRequest(path: SearchPathDefinition, vars: TemplateVars): HttpRequest {
    const search = this.definition.search;
    const enc = this.definition.encoding;
    const entries: Array<[string, string]> = [
      ...(path.inheritinputs === false ? [] : Object.entries(search.inputs ?? {})),
      ...Object.entries(path.inputs ?? {}),
    ];
    const pairs: Array<[string, string]> = [];
    for (const [key, tpl] of entries) {
      if (key === '$raw') {
        const raw = renderTemplate(tpl, vars, { encodeValue: (v) => formEncode(v, enc) });
        for (const piece of raw.split('&')) {
          const eq = piece.indexOf('=');
          const k = eq < 0 ? piece : piece.slice(0, eq);
          if (!k) continue;
          // Already encoded: keep verbatim by decoding once, re-encoded on serialisation.
          pairs.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent((eq < 0 ? '' : piece.slice(eq + 1)).replace(/\+/g, ' '))]);
        }
        continue;
      }
      const value = renderTemplate(tpl, vars);
      if (!search.allowemptyinputs && value.trim() === '') continue;
      pairs.push([key, value]);
    }
    const rendered = renderTemplate(path.path, vars, { encodeValue: (v) => pathEncode(v, enc) });
    let url = resolveUrl(rendered, this.siteLink);
    const headers = firstHeaderValues(search.headers, vars);
    const serialized = serializePairs(pairs, enc, path.queryseparator ?? '&');
    if (path.method === 'post') {
      return { url, method: 'POST', headers, body: serialized, contentType: 'application/x-www-form-urlencoded', followRedirects: path.followredirect === true };
    }
    if (serialized) url += `${url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?'}${serialized}`;
    return { url, method: 'GET', headers, followRedirects: path.followredirect === true };
  }

  private parseResults(path: SearchPathDefinition, result: HttpResult, vars: TemplateVars): Draft[] {
    const type = (path.response?.type ?? 'html').toLowerCase();
    return type === 'json' ? this.parseJson(path, result, vars) : this.parseMarkup(type === 'xml', result, vars);
  }

  private parseJson(path: SearchPathDefinition, result: HttpResult, vars: TemplateVars): Draft[] {
    const rows = this.definition.search.rows;
    const text = this.text(result, true);
    const noResults = path.response?.noresultsmessage;
    if (noResults !== undefined && noResults !== null) {
      if (noResults === '' ? text.trim() === '' : text.includes(noResults)) return [];
    }
    let doc: JsonValue;
    try {
      doc = JSON.parse(text) as JsonValue;
    } catch (cause) {
      throw new IndexerError('bad-response', 'Error Parsing Json Response', { cause });
    }
    if (rows.count) {
      try {
        const count = this.evalBlock(rows.count, { kind: 'json', value: doc, outer: doc }, vars, false);
        if (count !== null && /^-?\d+$/.test(count.trim()) && Number(count) < 1) return [];
      } catch {
        // S9.12: failure evaluating count is ignored
      }
    }
    const selector = renderTemplate(rows.selector ?? '', vars);
    const list = jsonSelectRows(doc, selector);
    if (!list) {
      if (rows.missingattributeequalsnoresults) return [];
      throw new IndexerError('bad-response', 'Error Parsing Rows Selector');
    }
    const drafts: Draft[] = [];
    for (const outer of list) {
      let inner: JsonValue[] = [outer];
      if (rows.attribute) {
        const sub = jsonQuery(outer, rows.attribute);
        if (sub === undefined || sub === null) {
          if (rows.missingattributeequalsnoresults) continue;
          this.log('warn', `row attribute ${rows.attribute} missing; row skipped`);
          continue;
        }
        inner = rows.multiple && typeof sub === 'object' && !Array.isArray(sub) ? Object.values(sub) : rows.multiple && Array.isArray(sub) ? sub : [sub];
      }
      for (const row of inner) {
        const draft = this.parseRow({ kind: 'json', value: row, outer }, vars, result.url);
        if (draft) drafts.push(draft);
      }
    }
    return drafts;
  }

  private parseMarkup(xml: boolean, result: HttpResult, vars: TemplateVars): Draft[] {
    const search = this.definition.search;
    const rows = search.rows;
    let text = this.text(result);
    const pre = applyFilters(text, search.preprocessingfilters as FilterSpec[] | undefined, this.filterContext(vars));
    if (pre !== null) text = pre;
    const doc = xml ? parseXml(text) : parseHtml(text);
    for (const block of search.error ?? []) {
      const message = this.errorBlockMessage(block, doc, vars);
      if (message !== undefined) throw new IndexerError('bad-response', `Site error: ${message}`);
    }
    let matched: HtmlElement[];
    try {
      matched = querySelectorAll(doc, renderTemplate(rows.selector ?? '', vars));
    } catch (cause) {
      throw new IndexerError('bad-response', `Invalid rows selector: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    const after = rows.after ?? 0;
    const drafts: Draft[] = [];
    for (let i = 0; i < matched.length; i += after + 1) {
      const row = matched[i];
      if (!row) continue;
      if (after > 0) {
        if (i + after >= matched.length) {
          this.log('warn', 'incomplete multi-row release skipped');
          break;
        }
        for (let j = 1; j <= after; j++) {
          const next = matched[i + j];
          if (!next) continue;
          for (const child of [...next.children]) appendChild(row, child);
          detach(next);
        }
      }
      const draft = this.parseRow({ kind: 'html', node: row, doc }, vars, result.url, row);
      if (draft) drafts.push(draft);
    }
    return drafts;
  }

  private dateFromHeaders(row: HtmlElement, doc: HtmlDocument, vars: TemplateVars): string | undefined | null {
    const block = this.definition.search.rows.dateheaders;
    if (!block) return undefined;
    let cand: HtmlElement | null = previousElementSibling(row);
    if (!cand && row.parent?.type === 'element') cand = previousElementSibling(row.parent);
    while (cand) {
      let value: string | null = null;
      try {
        value = this.evalBlock({ ...block, optional: true }, { kind: 'html', node: cand, doc }, vars, false);
      } catch {
        value = null;
      }
      if (value && value.trim()) {
        const date = parseDateValue(value, this.dateContext());
        if (date) return toIsoString(date);
      }
      cand = previousElementSibling(cand);
    }
    return block.optional ? undefined : null;
  }

  private dateContext(): { now: number; timeZone?: string } {
    return { now: this.now(), ...(this.definition.timezone === undefined ? {} : { timeZone: this.definition.timezone }) };
  }

  /** Evaluate every field of one row; undefined when a required field fails (S10.1). */
  private parseRow(target: RowTarget, baseVars: TemplateVars, requestUrl: string, htmlRow?: HtmlElement): Draft | undefined {
    const draft: Draft = { categories: [] };
    const vars: TemplateVars = { ...baseVars };
    for (const [key, block] of Object.entries(this.definition.search.fields)) {
      const [rawName = '', ...mods] = key.split('|');
      let name = rawName.toLowerCase();
      if (!KNOWN_FIELDS.has(name)) {
        const base = /^([a-z]+)_.+$/.exec(name)?.[1];
        if (base && KNOWN_FIELDS.has(base)) name = base;
      }
      const optional = block.optional === true || mods.includes('optional') || IMPLICIT_OPTIONAL.has(name);
      let value: string | null;
      try {
        value = this.evalBlock(block, target, vars, !optional);
        if (value !== null) value = this.applyField(draft, name, mods, value, requestUrl);
      } catch (err) {
        if (!optional) {
          this.log('debug', `row skipped: field ${key}: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
        value = null;
        if (block.default !== undefined && block.default !== null) {
          try {
            value = this.applyField(draft, name, mods, renderTemplate(block.default, vars), requestUrl);
          } catch {
            value = null;
          }
        }
      }
      vars[`Result.${name}`] = value;
      if (rawName !== name) vars[`Result.${rawName}`] = value;
    }
    if (draft.publishDate === undefined && htmlRow && target.kind === 'html') {
      const fromHeader = this.dateFromHeaders(htmlRow, target.doc, vars);
      if (fromHeader === null) {
        this.log('debug', 'row skipped: no date header row');
        return undefined;
      }
      if (fromHeader !== undefined) draft.publishDate = fromHeader;
    }
    return draft;
  }

  /** S10.3: apply a field value to the draft; returns the value stored as `.Result`. */
  private applyField(draft: Draft, name: string, mods: string[], raw: string, requestUrl: string): string {
    const value = raw.trim();
    const int = (): number => {
      const n = parseInteger(value);
      if (n === undefined) throw new FieldError(`"${value}" is not an integer`);
      return n;
    };
    const dec = (): number => {
      const n = parseDecimal(value);
      if (n === undefined) throw new FieldError(`"${value}" is not a number`);
      return n;
    };
    switch (name) {
      case 'category': {
        const ids = mapFromTracker(this.categoryMap, value);
        draft.categories = mods.includes('noappend') ? ids : [...new Set([...draft.categories, ...ids])];
        return value;
      }
      case 'categorydesc':
        draft.categories = [...new Set([...draft.categories, ...mapFromDesc(this.categoryMap, value)])];
        return value;
      case 'title':
        draft.title = mods.includes('append') && draft.title ? draft.title + value : value;
        return draft.title;
      case 'description':
        draft.description = mods.includes('append') && draft.description ? draft.description + value : value;
        return draft.description;
      case 'details':
        if (value) draft.infoUrl = resolveUrl(value, requestUrl);
        return draft.infoUrl ?? value;
      case 'comments':
        if (value && !draft.commentUrl) draft.commentUrl = resolveUrl(value, requestUrl);
        return draft.commentUrl ?? value;
      case 'download': {
        if (!value) {
          delete draft.downloadUrl;
          return value;
        }
        if (value.startsWith('magnet:')) {
          draft.magnetUrl = value;
          draft.guid = value;
          return value;
        }
        draft.downloadUrl = resolveUrl(value, requestUrl);
        draft.guid = draft.downloadUrl;
        return draft.downloadUrl;
      }
      case 'magnet':
        if (value) draft.magnetUrl = value;
        return value;
      case 'infohash':
        if (value) draft.infoHash = value;
        return value;
      case 'size': {
        const size = parseSize(value);
        if (size === undefined) throw new FieldError(`"${value}" is not a size`);
        draft.size = size;
        return String(size);
      }
      case 'date': {
        const date = parseDateValue(value, this.dateContext());
        if (date) draft.publishDate = toIsoString(date);
        else this.log('debug', `unparseable date "${value}"`);
        return draft.publishDate ?? value;
      }
      case 'seeders':
      case 'leechers': {
        let n = int();
        if (n >= SEEDER_CAP) n = 0;
        draft[name] = n;
        return String(n);
      }
      case 'grabs':
      case 'files':
      case 'year':
        draft[name] = int();
        return String(draft[name]);
      case 'downloadvolumefactor':
        draft.downloadVolumeFactor = dec();
        return String(draft.downloadVolumeFactor);
      case 'uploadvolumefactor':
        draft.uploadVolumeFactor = dec();
        return String(draft.uploadVolumeFactor);
      case 'minimumratio':
        draft.minimumRatio = dec();
        return String(draft.minimumRatio);
      case 'minimumseedtime':
        draft.minimumSeedTime = int();
        return String(draft.minimumSeedTime);
      case 'imdb':
      case 'imdbid': {
        const id = extractId(value);
        if (id > 0) draft.imdbId = `tt${String(id).padStart(7, '0')}`;
        return String(id);
      }
      case 'tmdbid':
        draft.tmdbId = extractId(value);
        return String(draft.tmdbId);
      case 'tvdbid':
        draft.tvdbId = extractId(value);
        return String(draft.tvdbId);
      case 'poster':
        if (value) draft.posterUrl = resolveUrl(value, requestUrl);
        return draft.posterUrl ?? value;
      case 'genre': {
        const genres = value
          .split(/[,\s/)(.;[\]"|:]+/)
          .filter(Boolean)
          .map((g) => g.replace(/_/g, ' '));
        draft.genres = [...new Set([...(draft.genres ?? []), ...genres])];
        return value;
      }
      default:
        return value;
    }
  }

  /** S10.5-S10.7: post-row finalisation and the validity gate. */
  private finalize(d: Draft): ReleaseInfo | undefined {
    const title = d.title?.trim();
    if (!title) return undefined;
    if (d.infoHash) {
      const normalized = normalizeInfoHash(d.infoHash);
      if (normalized) d.infoHash = normalized;
    }
    if (!d.magnetUrl && d.infoHash && this.definition.type !== 'private' && normalizeInfoHash(d.infoHash)) {
      d.magnetUrl = buildMagnet(d.infoHash, title);
    }
    if (d.magnetUrl && !d.infoHash) {
      const h = hashFromMagnet(d.magnetUrl);
      if (h) d.infoHash = h;
    }
    const downloadUrl = d.downloadUrl ?? d.magnetUrl;
    const interactive = this.options.interactive === true;
    if (!interactive) {
      if (d.size === undefined || d.categories.length === 0 || !downloadUrl) {
        this.log('warn', `release "${title}" dropped (missing ${d.size === undefined ? 'size' : d.categories.length === 0 ? 'categories' : 'link'})`);
        return undefined;
      }
    }
    const guid = d.guid ?? d.downloadUrl ?? d.magnetUrl ?? d.infoUrl ?? `${this.definition.id}:${title}`;
    const release: ReleaseInfo = {
      guid,
      title,
      size: d.size ?? 0,
      publishDate: d.publishDate ?? toIsoString(new Date(this.now())),
      downloadUrl: downloadUrl ?? d.infoUrl ?? '',
      categories: d.categories,
      indexerName: this.definition.name,
      protocol: 'torrent',
      downloadVolumeFactor: d.downloadVolumeFactor ?? 1,
      uploadVolumeFactor: d.uploadVolumeFactor ?? 1,
    };
    const opt = <K extends keyof ReleaseInfo>(key: K, value: ReleaseInfo[K] | undefined): void => {
      if (value !== undefined) release[key] = value;
    };
    opt('infoUrl', d.infoUrl);
    opt('magnetUrl', d.magnetUrl);
    opt('infoHash', d.infoHash);
    opt('seeders', d.seeders);
    opt('leechers', d.leechers);
    if (d.seeders !== undefined || d.leechers !== undefined) release.peers = (d.seeders ?? 0) + (d.leechers ?? 0);
    opt('grabs', d.grabs);
    opt('indexerId', this.options.indexerId);
    opt('imdbId', d.imdbId);
    opt('tmdbId', d.tmdbId);
    opt('tvdbId', d.tvdbId);
    opt('minimumRatio', d.minimumRatio);
    opt('minimumSeedTime', d.minimumSeedTime === undefined ? undefined : d.minimumSeedTime * 1000);
    opt('description', d.description);
    opt('commentUrl', d.commentUrl);
    opt('posterUrl', d.posterUrl);
    opt('files', d.files);
    opt('genres', d.genres);
    opt('year', d.year);
    return release;
  }

  // ------------------------------------------------------------------ download (S11)

  async download(link: string): Promise<DownloadResult> {
    if (link.startsWith('magnet:')) return { kind: 'magnet', magnetUrl: link };
    const def = this.definition;
    const block = def.download;
    const vars: TemplateVars = { ...this.baseVars(), ...downloadUriVars(link) };
    const headers = firstHeaderValues(block?.headers ?? def.search.headers, vars);
    const enc = def.encoding;
    const finalMethod: 'GET' | 'POST' = (block?.method ?? 'get').toLowerCase() === 'post' ? 'POST' : 'GET';
    const getPage = async (url: string): Promise<{ doc: HtmlDocument; url: string }> => {
      const res = await this.fetchAuthed(() => ({ url, method: 'GET', headers, followRedirects: true }));
      this.checkResponse(res);
      return { doc: parseHtml(this.text(res)), url: res.url };
    };

    let beforePage: { doc: HtmlDocument; url: string } | undefined;
    if (block?.before) {
      const before = block.before;
      let beforePath = before.path === undefined ? '' : renderTemplate(before.path, vars);
      if (before.pathselector) {
        const page = await getPage(link);
        const v = this.evalBlock(before.pathselector, { kind: 'html', node: page.doc, doc: page.doc }, vars, true);
        beforePath = v ?? '';
      }
      const pairs = Object.entries(before.inputs ?? {}).map(([k, v]): [string, string] => [k, renderTemplate(v, vars)]);
      const query = serializePairs(pairs, enc, before.queryseparator ?? '&');
      let url = resolveUrl(beforePath, link);
      const post = (before.method ?? 'get').toLowerCase() === 'post';
      if (!post && query) url += `${url.includes('?') ? '&' : '?'}${query}`;
      const res = await this.fetchAuthed(() => ({
        url,
        method: post ? 'POST' : 'GET',
        headers: { ...headers, Referer: link },
        ...(post ? { body: query, contentType: 'application/x-www-form-urlencoded' } : {}),
        followRedirects: true,
      }));
      beforePage = { doc: parseHtml(this.text(res)), url: res.url };
    }

    if (block?.infohash) {
      try {
        const ih = block.infohash;
        const page = ih.usebeforeresponse && beforePage ? beforePage : await getPage(link);
        const target: RowTarget = { kind: 'html', node: page.doc, doc: page.doc };
        const hash = normalizeInfoHash(this.evalBlock(ih.hash, target, vars, true) ?? '');
        const title = this.evalBlock(ih.title, target, vars, true) ?? '';
        if (!hash) throw new Error('invalid info hash');
        return { kind: 'magnet', magnetUrl: buildMagnet(hash, title) };
      } catch (err) {
        this.log('warn', `download infohash failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (block?.selectors?.length) {
      let linkPage: { doc: HtmlDocument; url: string } | undefined;
      for (const sel of block.selectors as DownloadSelector[]) {
        const page = sel.usebeforeresponse && beforePage ? beforePage : (linkPage ??= await getPage(link));
        let value: string | null;
        try {
          value = this.evalBlock({ ...sel, optional: true }, { kind: 'html', node: page.doc, doc: page.doc }, vars, false);
        } catch {
          value = null;
        }
        if (!value) continue;
        const candidate = resolveUrl(value, link);
        if (candidate.startsWith('magnet:')) return { kind: 'magnet', magnetUrl: candidate };
        if (def.testlinktorrent === false) return this.fetchTorrent(candidate, finalMethod, headers, link);
        try {
          return await this.fetchTorrent(candidate, finalMethod, headers, link);
        } catch (err) {
          this.log('debug', `download candidate ${candidate} rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new IndexerError('bad-response', `Download selectors didn't match for ${link}`);
    }
    return this.fetchTorrent(link, finalMethod, headers, undefined);
  }

  private async fetchTorrent(url: string, method: 'GET' | 'POST', headers: Record<string, string>, referer: string | undefined): Promise<DownloadResult> {
    const res = await this.fetchAuthed(() => ({
      url,
      method,
      headers: referer ? { ...headers, Referer: referer } : headers,
      followRedirects: true,
    }));
    if (res.location?.startsWith('magnet:')) return { kind: 'magnet', magnetUrl: res.location };
    if (res.status === 404) throw new IndexerError('bad-response', 'Release unavailable (404)', { status: 404 });
    if (res.status === 429) throw new IndexerError('rate-limited', 'Grab limit reached', { status: 429 });
    if (res.status !== 200) throw new IndexerError('bad-response', `HTTP ${res.status} downloading torrent`, { status: res.status });
    const ct = res.headers.get('content-type') ?? undefined;
    if (ct && /html/i.test(ct) && !looksLikeTorrent(res.body)) {
      throw new IndexerError('bad-response', 'Site responded with html content');
    }
    if (!looksLikeTorrent(res.body)) throw new IndexerError('bad-response', 'Downloaded file is not a torrent');
    return { kind: 'torrent', data: res.body, url: res.url, ...(ct ? { contentType: ct } : {}) };
  }

  // ------------------------------------------------------------------ account (Arclight)

  /**
   * Fetch the logged-in account page named by the definition's `account` block and read the
   * user's ratio, upload, download, buffer and H&R count from it. Missing values are left out;
   * a definition without an `account` block throws `IndexerError('bad-response')`.
   */
  async accountStats(): Promise<AccountStats> {
    const account = this.definition.account;
    if (!account) throw new IndexerError('bad-response', `${this.definition.name} has no account statistics page`);
    const vars = this.baseVars();
    const path: SearchPathDefinition = {
      path: account.path,
      method: (account.method ?? 'get').toLowerCase() === 'post' ? 'post' : 'get',
      inheritinputs: false,
      ...(account.inputs ? { inputs: account.inputs } : {}),
    };
    const result = await this.fetchAuthed(() => this.buildSearchRequest(path, vars));
    this.checkResponse(result);
    const doc = parseHtml(this.text(result));
    const target: RowTarget = { kind: 'html', node: doc, doc };
    const stats: AccountStats = {};
    for (const [name, block] of Object.entries(account.fields)) {
      const field = ACCOUNT_FIELDS[name.toLowerCase().replace(/[_-]/g, '')];
      if (!field) {
        this.log('debug', `account field ${name} is not used`);
        continue;
      }
      let raw: string | null = null;
      try {
        raw = this.evalBlock(block, target, vars, false);
      } catch (err) {
        this.log('debug', `account field ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (raw === null || raw.trim() === '') continue;
      const value = field.parse(raw.trim());
      if (value !== undefined && Number.isFinite(value)) stats[field.key] = value;
    }
    return stats;
  }

  // ------------------------------------------------------------------ test (S12)

  async test(): Promise<{ ok: true; releaseCount: number } | { ok: false; error: IndexerError }> {
    if (this.definition.requiresflaresolverr && !this.hasFlareSolverr) {
      return { ok: false, error: this.flareSolverrRequired() };
    }
    try {
      if (this.definition.login) {
        this.loggedIn = false;
        await this.login();
      }
      // A definition `test` block names a known-good listing; otherwise probe RSS, then a keyword.
      if (this.definition.test) {
        const listed = await this.runSearch({ kind: 'rss' }, [this.definition.test]);
        if (listed.length === 0) {
          throw new IndexerError('bad-response', 'Test request succeeded but returned no releases');
        }
        return { ok: true, releaseCount: listed.length };
      }
      let releases = await this.search({ kind: 'rss' });
      if (releases.length === 0) releases = await this.search({ kind: 'search', query: 'test' });
      if (releases.length === 0) {
        throw new IndexerError(
          'bad-response',
          'Query successful, but no results were returned; check category/freeleech settings',
        );
      }
      return { ok: true, releaseCount: releases.length };
    } catch (err) {
      const error =
        err instanceof IndexerError
          ? err
          : new IndexerError('unreachable', err instanceof Error ? err.message : String(err), { cause: err });
      return { ok: false, error };
    }
  }
}

/** `.DownloadUri.*` variables (S4.1). */
export function downloadUriVars(link: string): TemplateVars {
  const vars: TemplateVars = {};
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return vars;
  }
  vars['DownloadUri.AbsoluteUri'] = u.href;
  vars['DownloadUri.AbsolutePath'] = u.pathname;
  vars['DownloadUri.Scheme'] = u.protocol.replace(/:$/, '');
  vars['DownloadUri.Host'] = u.hostname;
  vars['DownloadUri.Port'] = u.port || (u.protocol === 'https:' ? '443' : '80');
  vars['DownloadUri.PathAndQuery'] = u.pathname + u.search;
  vars['DownloadUri.Query'] = u.search;
  for (const [k, v] of u.searchParams) if (vars[`DownloadUri.Query.${k}`] === undefined) vars[`DownloadUri.Query.${k}`] = v;
  return vars;
}

export type { TemplateValue };
