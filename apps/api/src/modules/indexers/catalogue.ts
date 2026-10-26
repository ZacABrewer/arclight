import { createHash } from 'node:crypto';
import { INDEXER_PRESETS, limitingWarnings, type IndexerPreset } from '@arclight/indexers';
import {
  categoryGroupsOf,
  IndexerPrivacy,
  type IndexerCatalogue,
  type IndexerCatalogueCounts,
  type IndexerCatalogueEntry,
  type IndexerCatalogueEntryDetail,
} from '@arclight/shared';
import type { CommunityFailure, DefinitionStore } from './definitions.js';

// The add-indexer catalogue as one list: every site definition the store serves (including
// community files that did not load, as "unsupported"), the Newznab/Torznab presets and the two
// generic endpoints. Built on demand; the ETag covers the store generation, the presets and
// the community header so the web can revalidate cheaply.

export class CatalogueEntryNotFound extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor(key: string) {
    super(`catalogue entry "${key}" not found`);
    this.name = 'CatalogueEntryNotFound';
  }
}

export interface CatalogueContext {
  store: DefinitionStore;
  /** Community header; `enabled` false hides nothing already loaded (the store skips the folder). */
  community: () => Promise<IndexerCatalogue['community']>;
  presets?: readonly IndexerPreset[];
}

const GENERIC: ReadonlyArray<Pick<IndexerCatalogueEntry, 'id' | 'name' | 'description' | 'protocol'> & { implementation: 'torznab' | 'newznab' }> = [
  {
    id: 'torznab',
    implementation: 'torznab',
    name: 'Torznab',
    description: 'Any Torznab endpoint: Jackett, Prowlarr or a tracker API. You enter the URL and API key.',
    protocol: 'torrent',
  },
  {
    id: 'newznab',
    implementation: 'newznab',
    name: 'Newznab',
    description: 'Any Newznab usenet indexer API. You enter the URL and API key.',
    protocol: 'usenet',
  },
];

function definitionEntries(store: DefinitionStore): IndexerCatalogueEntry[] {
  const out: IndexerCatalogueEntry[] = [];
  for (const summary of store.list()) {
    const def = store.get(summary.id);
    const limits = def ? limitingWarnings(def) : [];
    const categoryIds = summary.categories.map((c) => c.id);
    const overrides = store.overrides(summary.id);
    out.push({
      key: `definition:${summary.id}`,
      kind: 'definition',
      id: summary.id,
      name: summary.name,
      description: summary.description,
      language: summary.language,
      protocol: summary.protocol,
      privacy: summary.privacy,
      links: summary.links,
      categoryIds,
      categoryGroups: categoryGroupsOf(categoryIds),
      tested: summary.tested,
      source: summary.source,
      support: limits.length ? 'limited' : 'supported',
      ...(limits.length ? { supportReason: limits.join(' ') } : {}),
      ...(summary.requiresFlareSolverr || summary.settingsFields.some((f) => f.type === 'info_flaresolverr') ? { requiresFlareSolverr: true } : {}),
      ...(overrides.length ? { overrides } : {}),
    });
  }
  for (const f of store.communityFailures()) out.push(failureEntry(f));
  return out;
}

function failureEntry(f: CommunityFailure): IndexerCatalogueEntry {
  const privacy = IndexerPrivacy.safeParse(f.peek.type);
  return {
    key: `definition:${f.id}`,
    kind: 'definition',
    id: f.id,
    name: f.peek.name ?? f.id,
    description: f.peek.description ?? '',
    language: f.peek.language ?? '',
    protocol: 'torrent',
    privacy: privacy.success ? privacy.data : 'private',
    links: f.peek.links,
    categoryIds: [],
    categoryGroups: [],
    tested: false,
    source: 'community',
    support: 'unsupported',
    supportReason: f.message,
  };
}

function presetEntry(p: IndexerPreset): IndexerCatalogueEntry {
  const ids = [...p.categories, ...p.animeCategories];
  return {
    key: `preset:${p.id}`,
    kind: 'preset',
    id: p.id,
    name: p.name,
    description: p.description,
    language: p.language,
    protocol: p.implementation === 'newznab' ? 'usenet' : 'torrent',
    privacy: p.privacy,
    links: [p.baseUrl],
    categoryIds: ids,
    categoryGroups: categoryGroupsOf(ids),
    tested: true,
    source: 'preset',
    support: 'supported',
    preset: {
      implementation: p.implementation,
      baseUrl: p.baseUrl,
      apiPath: p.apiPath,
      categories: [...p.categories],
      animeCategories: [...p.animeCategories],
      ...(p.apiKeyHint ? { apiKeyHint: p.apiKeyHint } : {}),
    },
  };
}

function genericEntries(): IndexerCatalogueEntry[] {
  return GENERIC.map((g) => ({
    key: `generic:${g.id}`,
    kind: 'generic',
    id: g.id,
    name: g.name,
    description: g.description,
    language: '',
    protocol: g.protocol,
    privacy: 'private',
    links: [],
    categoryIds: [2000, 5000, 5070],
    categoryGroups: categoryGroupsOf([2000, 5000, 5070]),
    tested: true,
    source: 'generic',
    support: 'supported',
    preset: { implementation: g.implementation, baseUrl: '', apiPath: '/api', categories: [2000, 5000], animeCategories: [5070] },
  }));
}

function countsOf(entries: readonly IndexerCatalogueEntry[]): IndexerCatalogueCounts {
  const bySource: Record<string, number> = {};
  let limited = 0;
  let unsupported = 0;
  for (const e of entries) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    if (e.support === 'limited') limited++;
    if (e.support === 'unsupported') unsupported++;
  }
  return { total: entries.length, supported: entries.length - unsupported, limited, unsupported, bySource };
}

/** The whole catalogue, sorted by name (generic endpoints first). */
export async function buildCatalogue(ctx: CatalogueContext): Promise<IndexerCatalogue> {
  await ctx.store.ready();
  const presets = (ctx.presets ?? INDEXER_PRESETS).map(presetEntry);
  const defs = definitionEntries(ctx.store);
  const byName = (a: IndexerCatalogueEntry, b: IndexerCatalogueEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
  const entries = [...genericEntries(), ...[...presets, ...defs].sort(byName)];
  const community = await ctx.community();
  const etag = `W/"${createHash('sha1')
    .update(JSON.stringify({ g: ctx.store.generation, n: entries.length, p: presets.map((p) => p.key), c: community }))
    .digest('hex')
    .slice(0, 20)}"`;
  return { etag, counts: countsOf(entries), community, entries };
}

/** One entry with what the editor needs (`definition:<id>`, `preset:<id>`, `generic:<impl>`). */
export async function catalogueEntry(ctx: CatalogueContext, key: string): Promise<IndexerCatalogueEntryDetail> {
  const catalogue = await buildCatalogue(ctx);
  const entry = catalogue.entries.find((e) => e.key === key);
  if (!entry) throw new CatalogueEntryNotFound(key);
  if (entry.kind !== 'definition') return { ...entry, searchModes: [], requiresLogin: false, warnings: [] };
  if (entry.support === 'unsupported') {
    const failure = ctx.store.communityFailures().find((f) => f.id === entry.id);
    return { ...entry, searchModes: [], requiresLogin: false, warnings: [], ...(failure ? { file: failure.file } : {}) };
  }
  const detail = ctx.store.detail(entry.id);
  return { ...entry, searchModes: detail.searchModes, requiresLogin: detail.requiresLogin, warnings: detail.warnings };
}
