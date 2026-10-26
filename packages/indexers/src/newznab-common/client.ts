import {
  IndexerError,
  type ClientOptions,
  type IndexerCapabilities,
  type IndexerDefinition,
  type ReleaseInfo,
  type SearchRequest,
} from '../types.js';
import { parseCaps } from './caps.js';
import { getXml } from './http.js';
import { isRssDocument, parseReleases, responseTotal, rssItems } from './items.js';
import { buildCapsUrl, buildSearchUrl, planSearch, type Flavor } from './query.js';

const DEFAULT_MAX_RESULTS = 1000;
const DEFAULT_MAX_PAGES = 10;
const FALLBACK_PAGE_SIZE = 100;

export async function fetchCapsFor(def: IndexerDefinition, options: ClientOptions = {}): Promise<IndexerCapabilities> {
  try {
    return parseCaps(await getXml(buildCapsUrl(def), options));
  } catch (err) {
    if (err instanceof IndexerError && err.code === 'bad-response') {
      const details = { cause: err, ...(err.status === undefined ? {} : { status: err.status }) };
      throw new IndexerError('caps-failed', `Could not read capabilities: ${err.message}`, details);
    }
    throw err;
  }
}

/**
 * Run a request against a Newznab-family endpoint, paging with limit/offset until the
 * indexer runs dry, stops returning new items, or `maxResults`/`maxPages` is reached.
 */
export async function searchFor(
  flavor: Flavor,
  def: IndexerDefinition,
  request: SearchRequest,
  caps: IndexerCapabilities,
  options: ClientOptions = {},
): Promise<ReleaseInfo[]> {
  const plan = planSearch(def, request, caps, flavor);
  const pageSize = caps.limits.max > 0 ? caps.limits.max : FALLBACK_PAGE_SIZE;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxPages = request.kind === 'rss' ? 1 : (options.maxPages ?? DEFAULT_MAX_PAGES);
  const now = options.now ?? Date.now;

  const seen = new Set<string>();
  const releases: ReleaseInfo[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const doc = await getXml(buildSearchUrl(def, plan, { limit: pageSize, offset }), options);
    if (!isRssDocument(doc)) {
      throw new IndexerError('bad-response', 'Search response is not an RSS feed');
    }

    const rawCount = rssItems(doc).length;
    const pageReleases = parseReleases(doc, {
      protocol: def.protocol,
      indexerName: def.name,
      caps,
      now: now(),
      ...(options.indexerId === undefined ? {} : { indexerId: options.indexerId }),
    });

    let added = 0;
    for (const release of pageReleases) {
      if (seen.has(release.guid)) continue;
      seen.add(release.guid);
      releases.push(release);
      added++;
    }

    const total = responseTotal(doc);
    const exhausted =
      rawCount < pageSize ||
      (total !== undefined && offset + rawCount >= total) ||
      (rawCount > 0 && added === 0);
    if (exhausted || releases.length >= maxResults) break;
  }

  const filtered = applyMinimumSeeders(def, releases);
  return filtered.length > maxResults ? filtered.slice(0, maxResults) : filtered;
}

function applyMinimumSeeders(def: IndexerDefinition, releases: ReleaseInfo[]): ReleaseInfo[] {
  const min = def.minimumSeeders;
  if (def.protocol !== 'torrent' || min === undefined || min <= 0) return releases;
  return releases.filter((r) => r.seeders === undefined || r.seeders >= min);
}
