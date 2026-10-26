/**
 * Category mapping between a site's own category ids and Newznab/Torznab ids (spec S7.6-S7.13)
 * and synthesis of `IndexerCapabilities` from a definition's `caps` block.
 */
import { createHash } from 'node:crypto';
import { STANDARD_CATEGORIES } from '../categories.js';
import { SEARCH_PARAMS, type CapsCategory, type IndexerCapabilities, type SearchParam } from '../types.js';
import type { Definition } from './schema.js';

export interface CategoryMapping {
  trackerId: string;
  torznabId: number;
  desc?: string;
  isDefault: boolean;
}

export interface CategoryMap {
  mappings: CategoryMapping[];
  /** Every Torznab id present in the advertised tree (parents, children, custom). */
  known: Set<number>;
  tree: CapsCategory[];
  warnings: string[];
}

export const CUSTOM_CATEGORY_OFFSET = 100_000;

/** Stable 16-bit id for a non-numeric tracker category (S7.8). */
export function customCategoryHash(trackerId: string): number {
  const digest = createHash('sha1').update(trackerId, 'utf8').digest();
  return (digest[0] ?? 0) | ((digest[1] ?? 0) << 8);
}

export function customCategoryId(trackerId: string): number {
  return CUSTOM_CATEGORY_OFFSET + (/^\d+$/.test(trackerId) ? Number(trackerId) : customCategoryHash(trackerId));
}

const BY_NAME = new Map(STANDARD_CATEGORIES.map((c) => [c.name, c]));
const BY_ID = new Map(STANDARD_CATEGORIES.map((c) => [c.id, c]));

export function buildCategoryMap(def: Pick<Definition, 'caps'>): CategoryMap {
  const mappings: CategoryMapping[] = [];
  const warnings: string[] = [];
  const entries = [
    ...(def.caps.categorymappings ?? []),
    ...Object.entries(def.caps.categories ?? {}).map(([id, cat]) => ({ id, cat, desc: undefined, default: false })),
  ];
  for (const entry of entries) {
    const trackerId = String(entry.id);
    const isDefault = entry.default === true;
    if (entry.cat !== undefined) {
      const std = BY_NAME.get(entry.cat);
      if (std) mappings.push({ trackerId, torznabId: std.id, isDefault, ...(entry.desc ? { desc: entry.desc } : {}) });
      else warnings.push(`Unknown category name "${entry.cat}" for tracker category ${trackerId}`);
    }
    if (entry.desc) mappings.push({ trackerId, torznabId: customCategoryId(trackerId), desc: entry.desc, isDefault });
  }

  // Tree (S7.9)
  const parents = new Map<number, CapsCategory>();
  const custom: CapsCategory[] = [];
  const known = new Set<number>();
  const ensureParent = (id: number): CapsCategory => {
    let p = parents.get(id);
    if (!p) {
      p = { id, name: BY_ID.get(id)?.name ?? String(id), subcats: [] };
      parents.set(id, p);
      known.add(id);
    }
    return p;
  };
  for (const m of mappings) {
    if (known.has(m.torznabId)) continue;
    if (m.torznabId >= CUSTOM_CATEGORY_OFFSET) {
      custom.push({ id: m.torznabId, name: m.desc ?? String(m.torznabId), subcats: [] });
      known.add(m.torznabId);
      continue;
    }
    const parentId = Math.floor(m.torznabId / 1000) * 1000;
    const parent = ensureParent(parentId);
    if (parentId !== m.torznabId) {
      parent.subcats.push({ id: m.torznabId, name: BY_ID.get(m.torznabId)?.name ?? m.desc ?? String(m.torznabId) });
      known.add(m.torznabId);
    }
  }
  const tree = [...[...parents.values()].sort((a, b) => a.id - b.id), ...custom];
  for (const p of tree) p.subcats.sort((a, b) => a.id - b.id);
  return { mappings, known, tree, warnings };
}

/** S7.10: parents expand to their known children. */
export function expandCategories(map: CategoryMap, requested: readonly number[]): number[] {
  const out = new Set<number>();
  for (const id of requested) {
    out.add(id);
    if (id < CUSTOM_CATEGORY_OFFSET && id % 1000 === 0) {
      for (const p of map.tree) if (p.id === id) for (const s of p.subcats) out.add(s.id);
    }
  }
  return [...out];
}

/** S7.11: Torznab ids -> distinct tracker ids (mapping order), else defaults, else []. */
export function mapToTracker(map: CategoryMap, requested: readonly number[]): string[] {
  const wanted = new Set(expandCategories(map, requested));
  const out: string[] = [];
  const add = (id: string): void => {
    if (!out.includes(id)) out.push(id);
  };
  for (const m of map.mappings) if (wanted.has(m.torznabId)) add(m.trackerId);
  if (out.length === 0 && requested.length > 0) for (const m of map.mappings) if (m.isDefault) add(m.trackerId);
  return out;
}

/** S7.12: tracker id -> every matching Torznab id (case-insensitive exact match). */
export function mapFromTracker(map: CategoryMap, trackerId: string): number[] {
  const key = trackerId.trim().toLowerCase();
  return [...new Set(map.mappings.filter((m) => m.trackerId.toLowerCase() === key).map((m) => m.torznabId))];
}

export function mapFromDesc(map: CategoryMap, desc: string): number[] {
  const key = desc.trim().toLowerCase();
  return [...new Set(map.mappings.filter((m) => m.desc?.toLowerCase() === key).map((m) => m.torznabId))];
}

/** S7.13: subset of requested ids the indexer supports. */
export function supportedCategories(map: CategoryMap, requested: readonly number[]): number[] {
  return requested.filter((id) => map.known.has(id));
}

function params(list: readonly string[] | undefined): SearchParam[] {
  return (list ?? []).filter((p): p is SearchParam => (SEARCH_PARAMS as readonly string[]).includes(p));
}

/** Capabilities advertised for a definition-backed indexer. */
export function synthesizeCaps(def: Definition, map: CategoryMap): IndexerCapabilities {
  const tv = def.caps.modes['tv-search'];
  const movie = def.caps.modes['movie-search'];
  const max = def.caps.limits?.max ?? 100;
  return {
    serverTitle: def.name,
    limits: { max, default: def.caps.limits?.default ?? Math.min(100, max) },
    searching: {
      search: { available: true, supportedParams: ['q'] },
      tvSearch: { available: tv !== undefined, supportedParams: params(tv) },
      movieSearch: { available: movie !== undefined, supportedParams: params(movie) },
    },
    categories: map.tree.map((c) => ({ ...c, subcats: [...c.subcats] })),
  };
}
