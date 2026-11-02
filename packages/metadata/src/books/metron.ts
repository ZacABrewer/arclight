// Metron client (`https://metron.cloud/api`). HTTP Basic auth with a Metron account; lists
// are paged through absolute `next` links. Metron asks clients to stay around 20 requests per
// minute, so the limiter runs at one request every three seconds. Series carry ComicVine's id
// (`cv_id`), which is how the catalog links the two comic sources.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { MetadataError, isMetadataError } from '../types.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { maybe, stripHtml, text } from '../audiobook-util.js';
import type { ComicIssueRecord, ComicSeriesRecord } from './types.js';
import { httpsUrl, idString, numberFrom, partialDate } from './util.js';

export const METRON_DEFAULT_BASE_URL = 'https://metron.cloud/api';
export const METRON_PROVIDER = 'metron';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
/** Safety stop for paged lists. */
const MAX_PAGES = 40;

const optString = z.string().nullable().optional();
const idSchema = z.union([z.number(), z.string()]).nullable().optional();

const metronSeriesSchema = z
  .object({
    id: idSchema,
    name: optString,
    /** List rows give a display name ("Batman (2016)") instead of `name`. */
    series: optString,
    year_began: z.union([z.number(), z.string()]).nullable().optional(),
    year_end: z.union([z.number(), z.string()]).nullable().optional(),
    publisher: z.object({ name: optString }).loose().nullable().optional(),
    issue_count: z.union([z.number(), z.string()]).nullable().optional(),
    desc: optString,
    status: z.union([z.string(), z.object({ name: optString }).loose()]).nullable().optional(),
    cv_id: idSchema,
    image: optString,
  })
  .loose();
export type MetronSeriesWire = z.infer<typeof metronSeriesSchema>;

const metronIssueSchema = z
  .object({
    id: idSchema,
    number: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.union([z.array(z.string()), z.string()]).nullable().optional(),
    title: optString,
    cover_date: optString,
    store_date: optString,
    desc: optString,
    image: optString,
    cv_id: idSchema,
  })
  .loose();
export type MetronIssueWire = z.infer<typeof metronIssueSchema>;

const pageSchema = z
  .object({
    count: z.number().nullable().optional(),
    next: optString,
    results: z.array(z.unknown()).nullable().optional(),
  })
  .loose();

function statusOf(wire: MetronSeriesWire): ComicSeriesRecord['status'] {
  const raw = typeof wire.status === 'string' ? wire.status : wire.status?.name;
  const status = (text(raw) ?? '').toLowerCase();
  if (/ongoing|continuing|current/.test(status)) return 'continuing';
  if (/complete|cancel|ended|finished|concluded/.test(status)) return 'ended';
  if (numberFrom(wire.year_end) !== undefined) return 'ended';
  return undefined;
}

/** Maps a Metron series (detail or list row). */
export function comicSeriesFromMetron(wire: MetronSeriesWire): ComicSeriesRecord | undefined {
  const id = idString(wire.id);
  const display = text(wire.series);
  const title = text(wire.name) ?? (display ? display.replace(/\s*\(\d{4}\)\s*$/, '') : undefined);
  if (!id || !title) return undefined;
  const year = numberFrom(wire.year_began) ?? numberFrom(/\((\d{4})\)\s*$/.exec(display ?? '')?.[1]);
  const cvId = idString(wire.cv_id);
  const status = statusOf(wire);
  return {
    key: `metron:${id}`,
    keys: [`metron:${id}`, ...(cvId ? [`cv:${cvId}`] : [])],
    title,
    ...maybe('publisher', text(wire.publisher?.name)),
    ...maybe('startYear', year),
    ...maybe('issueCount', numberFrom(wire.issue_count)),
    ...maybe('overview', stripHtml(wire.desc)),
    ...maybe('coverUrl', httpsUrl(wire.image)),
    ...maybe('comicVineId', cvId),
    metronId: id,
    ...maybe('status', status),
    sources: ['metron'],
  };
}

/** Maps a Metron issue (detail or list row). */
export function comicIssueFromMetron(wire: MetronIssueWire): ComicIssueRecord | undefined {
  const id = idString(wire.id);
  const issueNumber = text(wire.number === null || wire.number === undefined ? undefined : String(wire.number));
  if (!id || !issueNumber) return undefined;
  const names = Array.isArray(wire.name) ? wire.name : [wire.name ?? undefined];
  const title = text(wire.title) ?? text(names.filter((n): n is string => !!text(n)).join('; '));
  const cvId = idString(wire.cv_id);
  return {
    key: `metron-issue:${id}`,
    keys: [`metron-issue:${id}`, ...(cvId ? [`cv-issue:${cvId}`] : [])],
    issueNumber,
    ...maybe('title', title),
    ...maybe('coverDate', partialDate(wire.cover_date)),
    ...maybe('storeDate', partialDate(wire.store_date)),
    ...maybe('overview', stripHtml(wire.desc)),
    ...maybe('coverUrl', httpsUrl(wire.image)),
    ...maybe('comicVineId', cvId),
    metronId: id,
    sources: ['metron'],
  };
}

export interface MetronClientOptions {
  username: string;
  password: string;
  userAgent?: string;
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** In-memory response cache; 0 turns it off. */
  cacheTtlMs?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface MetronClient {
  readonly providerKey: string;
  searchSeries(name: string, options?: RequestOptions): Promise<ComicSeriesRecord[]>;
  /** Undefined when Metron has no such series. */
  getSeries(id: string, options?: RequestOptions): Promise<ComicSeriesRecord | undefined>;
  /** The Metron series linked to a ComicVine volume, or undefined. */
  seriesByComicVineId(cvId: string, options?: RequestOptions): Promise<ComicSeriesRecord | undefined>;
  /** Every issue of the series (all pages). */
  listIssues(seriesId: string, options?: RequestOptions): Promise<ComicIssueRecord[]>;
}

/** `Basic <base64(user:password)>` (UTF-8). */
export function metronAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

function numericId(id: string, prefix: string, what: string): string {
  const raw = id.trim().replace(new RegExp(`^${prefix}:`), '');
  if (!/^\d+$/.test(raw)) throw new MetadataError('not-found', `"${id}" is not a ${what} id`);
  return raw;
}

export function createMetronClient(options: MetronClientOptions): MetronClient {
  const username = text(options?.username);
  const password = options?.password ?? '';
  if (!username || password.length === 0) throw new TypeError('Metron requires a username and password');
  const baseUrl = (options.baseUrl ?? METRON_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const origin = new URL(baseUrl).origin;
  const providerKey = METRON_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: 20 / 60, burst: 2 });
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: metronAuthorization(username, password),
  };
  const userAgent = text(options.userAgent);
  if (userAgent) headers['User-Agent'] = userAgent;
  const transport = createJsonTransport({
    label: 'Metron',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') u.searchParams.set(key, String(value));
    }
    return u.toString();
  }

  /** Follows `next` links (same origin only, so credentials never leave Metron). */
  async function allPages(first: string, opts: RequestOptions | undefined, maxPages = MAX_PAGES): Promise<unknown[]> {
    const rows: unknown[] = [];
    let next: string | undefined = first;
    for (let page = 0; next && page < maxPages; page += 1) {
      const body = await transport.get(next, pageSchema, { ...opts, ttlMs });
      rows.push(...(body.results ?? []));
      const link = text(body.next);
      next = link && new URL(link, origin).origin === origin ? new URL(link, origin).toString() : undefined;
    }
    return rows;
  }

  function seriesRows(rows: unknown[]): ComicSeriesRecord[] {
    return rows.flatMap((r) => {
      const parsed = metronSeriesSchema.safeParse(r);
      const series = parsed.success ? comicSeriesFromMetron(parsed.data) : undefined;
      return series ? [series] : [];
    });
  }

  async function getSeries(id: string, opts?: RequestOptions): Promise<ComicSeriesRecord | undefined> {
    const sid = numericId(id, 'metron', 'Metron series');
    const body = await transport.getOptional(url(`series/${sid}/`), metronSeriesSchema, { ...opts, ttlMs });
    return body ? comicSeriesFromMetron(body) : undefined;
  }

  return {
    providerKey,
    async searchSeries(name, opts) {
      const trimmed = name.trim();
      if (trimmed.length === 0) return [];
      return seriesRows(await allPages(url('series/', { name: trimmed }), opts, 1));
    },
    getSeries,
    async seriesByComicVineId(cvId, opts) {
      const id = numericId(cvId, 'cv', 'ComicVine volume');
      const rows = seriesRows(await allPages(url('series/', { cv_id: id }), opts, 1));
      const candidate = rows[0];
      if (!candidate?.metronId) return undefined;
      // List rows do not always carry cv_id: confirm the link on the detail record.
      const detail = candidate.comicVineId ? candidate : await getSeries(candidate.metronId, opts);
      return detail?.comicVineId === id ? detail : undefined;
    },
    async listIssues(seriesId, opts) {
      const sid = numericId(seriesId, 'metron', 'Metron series');
      let rows: unknown[];
      try {
        rows = await allPages(url('issue/', { series_id: sid }), opts);
      } catch (err) {
        if (isMetadataError(err, 'not-found')) return [];
        throw err;
      }
      const out = new Map<string, ComicIssueRecord>();
      for (const row of rows) {
        const parsed = metronIssueSchema.safeParse(row);
        const issue = parsed.success ? comicIssueFromMetron(parsed.data) : undefined;
        if (issue && !out.has(issue.key)) out.set(issue.key, issue);
      }
      return [...out.values()];
    },
  };
}
