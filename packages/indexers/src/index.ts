import * as newznab from './newznab/index.js';
import * as torznab from './torznab/index.js';
import {
  IndexerError,
  type ClientOptions,
  type IndexerCapabilities,
  type IndexerDefinition,
  type ReleaseInfo,
  type SearchRequest,
} from './types.js';

export * from './types.js';
export * from './categories.js';
export { createRateLimiter } from './rate-limit.js';
import { createRateLimiter, defaultSleep } from './rate-limit.js';
export { buildCapsUrl, buildSearchUrl, planSearch, redactUrl, type SearchPlan } from './newznab-common/index.js';
export { torznab, newznab };
export * from './proxy.js';
export * from './definitions/index.js';
export * as html from './html/index.js';
import { CookieJar } from './definitions/cookies.js';
import { createProxiedFetch } from './proxy.js';

export interface IndexerOptions extends Omit<ClientOptions, 'beforeRequest'> {
  /** Sleep used by the rate limiter; defaults to a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

export type IndexerTestResult =
  | { ok: true; caps: IndexerCapabilities; releaseCount: number }
  | { ok: false; error: IndexerError };

export interface Indexer {
  readonly definition: IndexerDefinition;
  /** Capabilities, fetched once and remembered; `refresh` forces a new `t=caps` call. */
  caps(options?: { refresh?: boolean }): Promise<IndexerCapabilities>;
  rss(): Promise<ReleaseInfo[]>;
  search(request: SearchRequest): Promise<ReleaseInfo[]>;
  /** Re-fetch caps and run an RSS query; never throws. */
  test(): Promise<IndexerTestResult>;
}

function toIndexerError(err: unknown): IndexerError {
  if (err instanceof IndexerError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new IndexerError('unreachable', message, { cause: err });
}

export function createIndexer(def: IndexerDefinition, options: IndexerOptions = {}): Indexer {
  const protocol = def.protocol === 'torrent' ? torznab : newznab;
  const { sleep, ...clientBase } = options;
  if (def.proxy) clientBase.fetch = proxiedClientFetch(def.proxy, options.fetch);
  const limiter = createRateLimiter(def.rateLimitMs ?? 0, options.now ?? Date.now, sleep ?? defaultSleep);
  const clientOptions: ClientOptions = { ...clientBase, beforeRequest: limiter };

  let capsPromise: Promise<IndexerCapabilities> | undefined;

  const caps = (opts: { refresh?: boolean } = {}): Promise<IndexerCapabilities> => {
    if (!capsPromise || opts.refresh) {
      const pending = protocol.fetchCaps(def, clientOptions);
      capsPromise = pending;
      pending.catch(() => {
        if (capsPromise === pending) capsPromise = undefined;
      });
    }
    return capsPromise;
  };

  const search = async (request: SearchRequest): Promise<ReleaseInfo[]> =>
    protocol.search(def, request, await caps(), clientOptions);

  return {
    definition: def,
    caps,
    rss: () => search({ kind: 'rss' }),
    search,
    async test() {
      try {
        const fresh = await caps({ refresh: true });
        const releases = await protocol.search(def, { kind: 'rss' }, fresh, clientOptions);
        return { ok: true, caps: fresh, releaseCount: releases.length };
      } catch (err) {
        return { ok: false, error: toIndexerError(err) };
      }
    },
  };
}

/**
 * Fetch for the Newznab/Torznab clients when the definition names proxies: a private cookie
 * jar keeps FlareSolverr clearance cookies across requests.
 */
function proxiedClientFetch(proxy: NonNullable<IndexerDefinition['proxy']>, base: typeof fetch | undefined): typeof fetch {
  const jar = new CookieJar();
  const inner = createProxiedFetch(proxy, { jar, ...(base ? { fetchImpl: base } : {}) });
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const cookie = jar.header();
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    return inner(input, { ...init, headers });
  };
}
