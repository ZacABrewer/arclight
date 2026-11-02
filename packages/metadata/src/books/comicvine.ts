// ComicVine client (`https://comicvine.gamespot.com/api`). Needs an API key (`api_key`) and a
// descriptive User-Agent (generic agents are blocked). Errors arrive as `status_code` in the
// JSON body (1 OK, 100 invalid key, 101 not found, 107 rate limited), sometimes with HTTP 200.
// ComicVine allows about 200 requests per hour per resource and blocks bursts, so the limiter
// runs at one request per second.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { MetadataError, isMetadataError } from '../types.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { maybe, stripHtml, text } from '../audiobook-util.js';
import type { ComicIssueRecord, ComicSeriesRecord } from './types.js';
import { httpsUrl, idString, numberFrom, partialDate } from './util.js';

export const COMICVINE_DEFAULT_BASE_URL = 'https://comicvine.gamespot.com/api';
export const COMICVINE_PROVIDER = 'comicvine';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const ISSUE_PAGE_SIZE = 100;
/** Safety stop for `listIssues` (30 × 100 issues). */
const MAX_ISSUE_PAGES = 30;
const VOLUME_FIELDS = 'id,name,start_year,publisher,count_of_issues,deck,description,image,issues';
const ISSUE_FIELDS = 'id,name,issue_number,cover_date,store_date,deck,description,image,volume';

const optString = z.string().nullable().optional();
const idSchema = z.union([z.number(), z.string()]).nullable().optional();
const imageSchema = z
  .object({ original_url: optString, super_url: optString, medium_url: optString })
  .loose()
  .nullable()
  .optional();

const cvIssueSchema = z
  .object({
    id: idSchema,
    name: optString,
    issue_number: z.union([z.string(), z.number()]).nullable().optional(),
    cover_date: optString,
    store_date: optString,
    deck: optString,
    description: optString,
    image: imageSchema,
  })
  .loose();
export type ComicVineIssueWire = z.infer<typeof cvIssueSchema>;

const cvVolumeSchema = z
  .object({
    id: idSchema,
    name: optString,
    start_year: z.union([z.string(), z.number()]).nullable().optional(),
    publisher: z.object({ name: optString }).loose().nullable().optional(),
    count_of_issues: z.union([z.number(), z.string()]).nullable().optional(),
    deck: optString,
    description: optString,
    image: imageSchema,
    issues: z.array(cvIssueSchema).nullable().optional(),
  })
  .loose();
export type ComicVineVolumeWire = z.infer<typeof cvVolumeSchema>;

function envelope<T extends z.ZodType>(results: T) {
  return z
    .object({
      status_code: z.number().nullable().optional(),
      error: optString,
      number_of_total_results: z.number().nullable().optional(),
      offset: z.number().nullable().optional(),
      results: z.union([results, z.array(z.unknown()).length(0)]).nullable().optional(),
    })
    .loose();
}

const searchSchema = envelope(z.array(z.unknown()));
const volumeSchema = envelope(cvVolumeSchema);
const issuesSchema = envelope(z.array(z.unknown()));

function coverOf(image: ComicVineVolumeWire['image']): string | undefined {
  return httpsUrl(image?.original_url) ?? httpsUrl(image?.super_url) ?? httpsUrl(image?.medium_url);
}

/** Maps a ComicVine volume (series). */
export function comicSeriesFromComicVine(wire: ComicVineVolumeWire): ComicSeriesRecord | undefined {
  const id = idString(wire.id);
  const title = text(wire.name);
  if (!id || !title) return undefined;
  const year = numberFrom(wire.start_year);
  return {
    key: `cv:${id}`,
    keys: [`cv:${id}`],
    title,
    ...maybe('publisher', text(wire.publisher?.name)),
    ...maybe('startYear', year !== undefined && Number.isInteger(year) && year > 1800 ? year : undefined),
    ...maybe('issueCount', numberFrom(wire.count_of_issues)),
    ...maybe('overview', stripHtml(wire.deck) ?? stripHtml(wire.description)),
    ...maybe('coverUrl', coverOf(wire.image)),
    comicVineId: id,
    sources: ['comicVine'],
  };
}

/** Maps a ComicVine issue. */
export function comicIssueFromComicVine(wire: ComicVineIssueWire): ComicIssueRecord | undefined {
  const id = idString(wire.id);
  const issueNumber = text(wire.issue_number === null || wire.issue_number === undefined ? undefined : String(wire.issue_number));
  if (!id || !issueNumber) return undefined;
  const coverDate = partialDate(wire.cover_date);
  const storeDate = partialDate(wire.store_date);
  return {
    key: `cv-issue:${id}`,
    keys: [`cv-issue:${id}`],
    issueNumber,
    ...maybe('title', text(wire.name)),
    ...maybe('coverDate', coverDate),
    ...maybe('storeDate', storeDate),
    ...maybe('overview', stripHtml(wire.deck) ?? stripHtml(wire.description)),
    ...maybe('coverUrl', coverOf(wire.image)),
    comicVineId: id,
    sources: ['comicVine'],
  };
}

export interface ComicVineClientOptions {
  apiKey: string;
  /** Required: ComicVine blocks generic agents. */
  userAgent: string;
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

export interface ComicVineVolume {
  series: ComicSeriesRecord;
  /** The minimal issue list the volume record carries (number, name, id). */
  issues: ComicIssueRecord[];
}

export interface ComicVineClient {
  readonly providerKey: string;
  searchVolumes(term: string, options?: RequestOptions & { limit?: number }): Promise<ComicSeriesRecord[]>;
  /** Undefined when ComicVine has no such volume. */
  getVolume(id: string, options?: RequestOptions): Promise<ComicVineVolume | undefined>;
  /** Every issue of the volume, in issue-number order. */
  listIssues(volumeId: string, options?: RequestOptions): Promise<ComicIssueRecord[]>;
}

function volumeId(id: string): string {
  const raw = id.trim().replace(/^cv:/, '').replace(/^4050-/, '');
  if (!/^\d+$/.test(raw)) throw new MetadataError('not-found', `"${id}" is not a ComicVine volume id`);
  return raw;
}

function checkStatus(body: { status_code?: number | null | undefined; error?: string | null | undefined }): void {
  const status = body.status_code ?? 1;
  if (status === 1) return;
  const detail = text(body.error) ?? `status ${status}`;
  if (status === 100) throw new MetadataError('unauthorized', `ComicVine rejected the API key: ${detail}`);
  if (status === 101) throw new MetadataError('not-found', `ComicVine: ${detail}`);
  if (status === 107) throw new MetadataError('rate-limited', `ComicVine is throttling requests: ${detail}`);
  throw new MetadataError('bad-response', `ComicVine answered an error: ${detail}`);
}

export function createComicVineClient(options: ComicVineClientOptions): ComicVineClient {
  const apiKey = text(options?.apiKey);
  if (!apiKey) throw new TypeError('ComicVine requires an API key');
  const userAgent = text(options.userAgent);
  if (!userAgent) throw new TypeError('ComicVine requires a descriptive User-Agent');
  const baseUrl = (options.baseUrl ?? COMICVINE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const providerKey = COMICVINE_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: 1, burst: 2 });
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const transport = createJsonTransport({
    label: 'ComicVine',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${baseUrl}/${path}`);
    u.searchParams.set('api_key', apiKey!);
    u.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') u.searchParams.set(key, String(value));
    }
    return u.toString();
  }

  return {
    providerKey,
    async searchVolumes(term, opts = {}) {
      const trimmed = term.trim();
      if (trimmed.length === 0) return [];
      const { limit, ...request } = opts;
      const body = await transport.get(
        url('search/', {
          resources: 'volume',
          query: trimmed,
          field_list: 'id,name,start_year,publisher,count_of_issues,deck,image',
          limit: Math.min(100, Math.max(1, Math.round(limit ?? 20))),
        }),
        searchSchema,
        { ...request, ttlMs },
      );
      checkStatus(body);
      return (body.results ?? []).flatMap((r) => {
        const parsed = cvVolumeSchema.safeParse(r);
        const series = parsed.success ? comicSeriesFromComicVine(parsed.data) : undefined;
        return series ? [series] : [];
      });
    },
    async getVolume(id, opts) {
      const vid = volumeId(id);
      let body;
      try {
        body = await transport.get(url(`volume/4050-${vid}/`, { field_list: VOLUME_FIELDS }), volumeSchema, {
          ...opts,
          ttlMs,
        });
        checkStatus(body);
      } catch (err) {
        if (isMetadataError(err, 'not-found')) return undefined;
        throw err;
      }
      const results = body.results;
      if (!results || Array.isArray(results)) return undefined;
      const series = comicSeriesFromComicVine(results);
      if (!series) return undefined;
      const issues = (results.issues ?? [])
        .map(comicIssueFromComicVine)
        .filter((i): i is ComicIssueRecord => i !== undefined);
      return { series, issues };
    },
    async listIssues(id, opts) {
      const vid = volumeId(id);
      const out = new Map<string, ComicIssueRecord>();
      let offset = 0;
      for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
        const body = await transport.get(
          url('issues/', {
            filter: `volume:${vid}`,
            field_list: ISSUE_FIELDS,
            sort: 'issue_number:asc',
            limit: ISSUE_PAGE_SIZE,
            offset: offset > 0 ? offset : undefined,
          }),
          issuesSchema,
          { ...opts, ttlMs },
        );
        checkStatus(body);
        const rows = body.results ?? [];
        for (const row of rows) {
          const parsed = cvIssueSchema.safeParse(row);
          const issue = parsed.success ? comicIssueFromComicVine(parsed.data) : undefined;
          if (issue && !out.has(issue.key)) out.set(issue.key, issue);
        }
        offset += rows.length;
        const total = body.number_of_total_results ?? 0;
        if (rows.length === 0 || offset >= total) break;
      }
      return [...out.values()];
    },
  };
}
