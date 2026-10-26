import {
  CatalogueCategoryGroup,
  urlHost,
  type CatalogueSource,
  type Indexer,
  type IndexerCatalogueEntry,
  type IndexerPrivacy,
  type IndexerTemplate,
  type ReleaseProtocol,
} from '@arclight/shared';
import { INDEXER_PRIORITY_DEFAULT } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Pure model of the add-indexer chooser: filters, sorting, language grouping and the
// "already added" index. The component (catalogue.tsx) only renders what these return.

/** Source filter values: Arclight's own definitions (builtin + feed) count as one. */
export type SourceFilter = 'all' | 'arclight' | 'community' | 'custom' | 'preset';

export interface ChooserFilter {
  text: string;
  protocol: ReleaseProtocol | 'all';
  privacy: IndexerPrivacy | 'all';
  /** Primary language subtag (`en`), '' = any. */
  language: string;
  category: CatalogueCategoryGroup | 'all';
  source: SourceFilter;
  testedOnly: boolean;
  hideUnsupported: boolean;
}

export const EMPTY_CHOOSER_FILTER: ChooserFilter = {
  text: '',
  protocol: 'all',
  privacy: 'all',
  language: '',
  category: 'all',
  source: 'all',
  testedOnly: false,
  hideUnsupported: false,
};

export type SortKey = 'name' | 'protocol' | 'privacy' | 'language' | 'categories' | 'source';
export interface ChooserSort {
  key: SortKey;
  direction: 'asc' | 'desc';
}
export const DEFAULT_SORT: ChooserSort = { key: 'name', direction: 'asc' };

export function sourceFilterOf(source: CatalogueSource): SourceFilter {
  if (source === 'builtin' || source === 'feed') return 'arclight';
  if (source === 'generic') return 'preset';
  return source;
}

/** `en-US` -> `en`; '' stays ''. */
export function primaryLanguage(code: string): string {
  return code.split(/[-_]/)[0]?.toLowerCase() ?? '';
}

/** Display name of a language subtag in the UI language, falling back to the code. */
export function languageName(code: string, locale = 'en'): string {
  if (!code) return t('settings.indexers.catalogue.anyLanguageMixed');
  try {
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Language options with entry counts, most common first. */
export function languageOptions(entries: readonly IndexerCatalogueEntry[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const code = primaryLanguage(e.language);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function matchesText(e: IndexerCatalogueEntry, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${e.id} ${e.name} ${e.description} ${e.language} ${e.links.join(' ')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Entries matching every filter. Generic endpoints ignore privacy, language and category. */
export function filterEntries(entries: readonly IndexerCatalogueEntry[], f: ChooserFilter): IndexerCatalogueEntry[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (!matchesText(e, words)) return false;
    if (f.protocol !== 'all' && e.protocol !== f.protocol) return false;
    if (f.source !== 'all' && sourceFilterOf(e.source) !== f.source) return false;
    if (f.hideUnsupported && e.support === 'unsupported') return false;
    if (e.kind === 'generic') return true;
    if (f.privacy !== 'all' && e.privacy !== f.privacy) return false;
    if (f.language && primaryLanguage(e.language) !== f.language) return false;
    if (f.category !== 'all' && !e.categoryGroups.includes(f.category)) return false;
    if (f.testedOnly && !e.tested) return false;
    return true;
  });
}

const PRIVACY_ORDER: Record<IndexerPrivacy, number> = { public: 0, 'semi-private': 1, private: 2 };
const SOURCE_ORDER: Record<CatalogueSource, number> = { generic: 0, preset: 1, builtin: 2, feed: 3, custom: 4, community: 5 };

function sortValue(e: IndexerCatalogueEntry, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return e.name.toLowerCase();
    case 'protocol':
      return e.protocol;
    case 'privacy':
      return PRIVACY_ORDER[e.privacy];
    case 'language':
      return e.language.toLowerCase() || '￿';
    case 'categories':
      return e.categoryGroups.map((g) => CatalogueCategoryGroup.options.indexOf(g)).join(',') || '￿';
    case 'source':
      return SOURCE_ORDER[e.source];
  }
}

/** Generic endpoints stay on top; the rest sorts by the key, then by name. */
export function sortEntries(entries: readonly IndexerCatalogueEntry[], sort: ChooserSort): IndexerCatalogueEntry[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if ((a.kind === 'generic') !== (b.kind === 'generic')) return a.kind === 'generic' ? -1 : 1;
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const primary = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    if (primary !== 0) return primary * dir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function nextSort(current: ChooserSort, key: SortKey): ChooserSort {
  return current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' };
}

// ---- already added -------------------------------------------------------------------

export interface AddedIndex {
  byDefinition: Map<string, Indexer[]>;
  byHost: Map<string, Indexer[]>;
}

export function addedIndex(indexers: readonly Indexer[]): AddedIndex {
  const byDefinition = new Map<string, Indexer[]>();
  const byHost = new Map<string, Indexer[]>();
  for (const i of indexers) {
    if (i.implementation === 'definition') {
      const id = i.settings.definitionId;
      if (id) byDefinition.set(id, [...(byDefinition.get(id) ?? []), i]);
      continue;
    }
    const host = urlHost(i.settings.baseUrl);
    if (host) byHost.set(host, [...(byHost.get(host) ?? []), i]);
  }
  return { byDefinition, byHost };
}

/** The user's indexers made from this entry: same definition id, or (presets) same base URL host. */
export function existingFor(entry: IndexerCatalogueEntry, index: AddedIndex): Indexer[] {
  if (entry.kind === 'definition') return index.byDefinition.get(entry.id) ?? [];
  if (entry.kind === 'preset' && entry.preset) {
    const host = urlHost(entry.preset.baseUrl);
    return (index.byHost.get(host) ?? []).filter((i) => i.implementation === entry.preset?.implementation);
  }
  return [];
}

// ---- presets -> editor templates -----------------------------------------------------

/** A ready-to-fill IndexerTemplate for a preset or generic entry. */
export function presetTemplate(entry: IndexerCatalogueEntry): IndexerTemplate | null {
  const p = entry.preset;
  if (!p) return null;
  return {
    implementation: p.implementation,
    implementationName: entry.name,
    protocol: entry.protocol,
    template: {
      name: entry.kind === 'generic' ? '' : entry.name,
      implementation: p.implementation,
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      priority: INDEXER_PRIORITY_DEFAULT,
      tags: [],
      settings: {
        baseUrl: p.baseUrl,
        apiPath: p.apiPath,
        apiKey: '',
        categories: [...p.categories],
        animeCategories: [...p.animeCategories],
        ...(p.implementation === 'torznab' ? { minimumSeeders: 1 } : {}),
      },
    },
  };
}

// ---- keyboard ------------------------------------------------------------------------

/** Next active row for a navigation key; null when the key is not a navigation key. */
export function moveActive(key: string, active: number, count: number, page: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, active + 1);
    case 'ArrowUp':
      return Math.max(0, active - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return Math.min(count - 1, active + page);
    case 'PageUp':
      return Math.max(0, active - page);
    default:
      return null;
  }
}
