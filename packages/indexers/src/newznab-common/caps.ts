import {
  IndexerError,
  SEARCH_PARAMS,
  type CapsCategory,
  type IndexerCapabilities,
  type SearchModeCapabilities,
  type SearchParam,
} from '../types.js';
import { asArray, attrOf, isRecord, type XmlNode } from './xml.js';

const FALLBACK_LIMIT = 100;

/** Capabilities assumed when an indexer omits a section: plain `q` search only. */
export function defaultCapabilities(): IndexerCapabilities {
  return {
    limits: { max: FALLBACK_LIMIT, default: FALLBACK_LIMIT },
    searching: {
      search: { available: true, supportedParams: ['q'] },
      tvSearch: { available: false, supportedParams: [] },
      movieSearch: { available: false, supportedParams: [] },
    },
    categories: [],
  };
}

/** Map a parsed `t=caps` document to `IndexerCapabilities`. */
export function parseCaps(doc: XmlNode): IndexerCapabilities {
  const root = doc['caps'];
  if (!isRecord(root)) {
    throw new IndexerError('caps-failed', 'Capabilities response has no <caps> root element');
  }

  const caps = defaultCapabilities();

  const serverTitle = attrOf(root['server'], 'title');
  if (serverTitle) caps.serverTitle = serverTitle;

  const limits = root['limits'];
  if (isRecord(limits)) {
    const max = positiveInt(attrOf(limits, 'max'));
    const def = positiveInt(attrOf(limits, 'default'));
    const resolvedMax = max ?? def ?? FALLBACK_LIMIT;
    caps.limits = { max: resolvedMax, default: Math.min(def ?? resolvedMax, resolvedMax) };
  }

  const searching = root['searching'];
  if (isRecord(searching)) {
    caps.searching = {
      search: parseMode(searching['search']),
      tvSearch: parseMode(searching['tv-search']),
      movieSearch: parseMode(searching['movie-search']),
    };
  }

  caps.categories = parseCategories(root['categories']);
  return caps;
}

function parseMode(node: unknown): SearchModeCapabilities {
  if (!isRecord(node) || attrOf(node, 'available')?.toLowerCase() !== 'yes') {
    return { available: false, supportedParams: [] };
  }
  const raw = attrOf(node, 'supportedParams');
  if (raw === undefined) return { available: true, supportedParams: ['q'] };

  const params: SearchParam[] = [];
  for (const piece of raw.split(',')) {
    const name = piece.trim().toLowerCase();
    if (isSearchParam(name) && !params.includes(name)) params.push(name);
  }
  return { available: true, supportedParams: params };
}

function isSearchParam(name: string): name is SearchParam {
  return (SEARCH_PARAMS as readonly string[]).includes(name);
}

function parseCategories(node: unknown): CapsCategory[] {
  if (!isRecord(node)) return [];
  const result: CapsCategory[] = [];
  for (const cat of asArray(node['category'])) {
    const id = intAttr(cat, 'id');
    if (id === undefined) continue;
    const subcats = asArray(isRecord(cat) ? cat['subcat'] : undefined).flatMap((sub) => {
      const subId = intAttr(sub, 'id');
      return subId === undefined ? [] : [{ id: subId, name: attrOf(sub, 'name') ?? String(subId) }];
    });
    result.push({ id, name: attrOf(cat, 'name') ?? String(id), subcats });
  }
  return result;
}

function intAttr(node: unknown, name: string): number | undefined {
  const value = Number.parseInt(attrOf(node, name) ?? '', 10);
  return Number.isFinite(value) ? value : undefined;
}

function positiveInt(raw: string | undefined): number | undefined {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

