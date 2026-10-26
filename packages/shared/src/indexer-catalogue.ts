import { z } from 'zod';
import { CommunityCatalogueSettings, IndexerImplementation, IndexerPrivacy } from './indexers.js';
import { ReleaseProtocol } from './profiles.js';

// The add-indexer catalogue: every entry the chooser lists in one shape. Site definitions
// (builtin, the Arclight definition feed, the community catalogue, the user's own YAML),
// Newznab/Torznab presets and the generic endpoints. Served in full with an ETag
// (GET /indexer/catalogue); the community catalogue has its own sync routes and settings.

// ---- community catalogue source -----------------------------------------------------

export const CatalogueUnsupportedReason = z.object({ reason: z.string(), count: z.number().int() });
export type CatalogueUnsupportedReason = z.infer<typeof CatalogueUnsupportedReason>;

export const CommunityCatalogueStatus = z.object({
  settings: CommunityCatalogueSettings,
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The listing URL the files on disk came from. */
  sourceUrl: z.string().nullable(),
  /** Definition files on disk. */
  files: z.number().int(),
  /** Files that load (some with limitations). */
  supported: z.number().int(),
  /** Files that load but use a feature Arclight does not support yet (e.g. login captchas). */
  limited: z.number().int(),
  /** Files that do not load. */
  unsupported: z.number().int(),
  /** Community entries hidden by a builtin, feed or custom definition with the same id. */
  overridden: z.number().int(),
  /** Most common reasons, largest first. */
  topReasons: z.array(CatalogueUnsupportedReason),
  /** A previous sync is kept and POST .../rollback swaps it back. */
  previousAvailable: z.boolean(),
  previousSyncedAt: z.string().nullable(),
  /** Enabled, and no successful sync for three intervals (or never). */
  stale: z.boolean(),
});
export type CommunityCatalogueStatus = z.infer<typeof CommunityCatalogueStatus>;

export const CommunityCatalogueSyncResult = z.object({
  /** The listing answered 304: nothing to do. */
  notModified: z.boolean(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  unchanged: z.number().int(),
  /** Files that could not be downloaded or verified (the previous copy, if any, is kept). */
  failed: z.array(z.object({ file: z.string(), reason: z.string() })),
  /** Definition files on disk after the sync. */
  total: z.number().int(),
});
export type CommunityCatalogueSyncResult = z.infer<typeof CommunityCatalogueSyncResult>;

// ---- catalogue entries --------------------------------------------------------------

/** builtin / feed / custom / community: site definitions; preset: a Newznab/Torznab preset; generic: a bare endpoint. */
export const CatalogueSource = z.enum(['builtin', 'feed', 'custom', 'community', 'preset', 'generic']);
export type CatalogueSource = z.infer<typeof CatalogueSource>;

/** Coarse content groups for the chooser's category filter. */
export const CatalogueCategoryGroup = z.enum(['movies', 'tv', 'anime', 'music', 'books', 'xxx', 'other']);
export type CatalogueCategoryGroup = z.infer<typeof CatalogueCategoryGroup>;

/** supported: loads; limited: loads but uses a feature Arclight lacks; unsupported: does not load. */
export const CatalogueSupport = z.enum(['supported', 'limited', 'unsupported']);
export type CatalogueSupport = z.infer<typeof CatalogueSupport>;

/** Prefill for a preset or generic endpoint: the user adds an API key (presets) or everything (generic). */
export const CataloguePresetSettings = z.object({
  implementation: IndexerImplementation.exclude(['definition']),
  baseUrl: z.string(),
  apiPath: z.string(),
  categories: z.array(z.number().int()),
  animeCategories: z.array(z.number().int()),
  /** Where to find the API key, shown under the field. */
  apiKeyHint: z.string().optional(),
});
export type CataloguePresetSettings = z.infer<typeof CataloguePresetSettings>;

export const IndexerCatalogueEntry = z.object({
  /** Unique across kinds: `definition:<id>`, `preset:<id>` or `generic:<implementation>`. */
  key: z.string(),
  kind: z.enum(['definition', 'preset', 'generic']),
  /** Definition id, preset id or implementation. */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** e.g. `en-US`; '' when unknown. */
  language: z.string(),
  protocol: ReleaseProtocol,
  privacy: IndexerPrivacy,
  /** Site links (definitions) or the preset's base URL. */
  links: z.array(z.string()),
  /** Standard category ids the entry maps to. */
  categoryIds: z.array(z.number().int()),
  categoryGroups: z.array(CatalogueCategoryGroup),
  /** Definitions: confirmed against the live site. Presets/generic: true. */
  tested: z.boolean(),
  source: CatalogueSource,
  support: CatalogueSupport,
  /** Why the entry is limited or unsupported. */
  supportReason: z.string().optional(),
  requiresFlareSolverr: z.boolean().optional(),
  /** Sources with the same id that this entry overrides (e.g. ['community']). */
  overrides: z.array(CatalogueSource).optional(),
  /** Presets and generic endpoints. */
  preset: CataloguePresetSettings.optional(),
});
export type IndexerCatalogueEntry = z.infer<typeof IndexerCatalogueEntry>;

export const IndexerCatalogueCounts = z.object({
  total: z.number().int(),
  /** Entries that can be added (supported + limited). */
  supported: z.number().int(),
  limited: z.number().int(),
  unsupported: z.number().int(),
  bySource: z.record(z.string(), z.number().int()),
});
export type IndexerCatalogueCounts = z.infer<typeof IndexerCatalogueCounts>;

/** GET /indexer/catalogue (ETag; If-None-Match answers 304). */
export const IndexerCatalogue = z.object({
  /** Weak validator of this listing; changes when any definition, setting or preset changes. */
  etag: z.string(),
  counts: IndexerCatalogueCounts,
  /** Community catalogue on/off and its last sync, for the chooser's header. */
  community: z.object({
    enabled: z.boolean(),
    lastSuccessAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
  entries: z.array(IndexerCatalogueEntry),
});
export type IndexerCatalogue = z.infer<typeof IndexerCatalogue>;

/** GET /indexer/catalogue/entry/:key: the entry plus what the editor needs. */
export const IndexerCatalogueEntryDetail = IndexerCatalogueEntry.extend({
  /** Definitions that load: search modes (`search`, `tv-search`, ...). */
  searchModes: z.array(z.string()),
  requiresLogin: z.boolean(),
  /** Load warnings (definitions). */
  warnings: z.array(z.string()),
  /** Unsupported definitions: the file that failed and the loader's message. */
  file: z.string().optional(),
});
export type IndexerCatalogueEntryDetail = z.infer<typeof IndexerCatalogueEntryDetail>;

// ---- grouping helpers (shared by api and web) ---------------------------------------

/** Standard category id -> chooser group. TV/Anime (5070) is anime, the rest by thousand. */
export function categoryGroupOf(id: number): CatalogueCategoryGroup {
  const base = id >= 100_000 ? -1 : Math.floor(id / 1000) * 1000;
  if (id === 5070) return 'anime';
  switch (base) {
    case 2000:
      return 'movies';
    case 5000:
      return 'tv';
    case 3000:
      return 'music';
    case 7000:
      return 'books';
    case 6000:
      return 'xxx';
    default:
      return 'other';
  }
}

/**
 * Distinct groups of a category list, in the canonical order. A parent (5000) listed only
 * because a subcategory (5070) is mapped does not count on its own, so an anime-only site is
 * not also "TV".
 */
export function categoryGroupsOf(ids: readonly number[]): CatalogueCategoryGroup[] {
  const standard = ids.filter((id) => id < 100_000);
  const leaves = standard.filter((id) => id % 1000 !== 0 || !standard.some((o) => o > id && o < id + 1000));
  const set = new Set(leaves.map(categoryGroupOf));
  return CatalogueCategoryGroup.options.filter((g) => set.has(g));
}

/** Host of a URL, lower case without `www.`; '' when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
