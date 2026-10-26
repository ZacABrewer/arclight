import type { IndexerCategory, ManualSearchRequest, ManualSearchType, ReleaseResource } from '@media-tron/shared';
import { ApiError } from '../api/client.js';
import { releaseDownloadHref } from '../api/indexers.js';

// Cross-indexer search page state and the pure helpers it renders with.

export type SearchKind = 'all' | 'series' | 'movie';

export interface SearchForm {
  query: string;
  kind: SearchKind;
  categories: number[];
  indexerIds: number[];
}

export const EMPTY_SEARCH: SearchForm = { query: '', kind: 'all', categories: [], indexerIds: [] };

const KIND_TO_TYPE: Record<SearchKind, ManualSearchType> = { all: 'search', series: 'tv', movie: 'movie' };

/** The GET /search query for a form, or null when there is nothing to search for. */
export function toSearchRequest(form: SearchForm): Partial<ManualSearchRequest> | null {
  const query = form.query.trim();
  if (!query) return null;
  return {
    query,
    type: KIND_TO_TYPE[form.kind],
    ...(form.categories.length ? { categories: [...form.categories].sort((a, b) => a - b) } : {}),
    ...(form.indexerIds.length ? { indexerIds: [...form.indexerIds].sort((a, b) => a - b) } : {}),
  };
}

export interface CategoryOption {
  value: number;
  label: string;
  /** Sub-category of a top-level one. */
  child: boolean;
}

/** Parents followed by their sub-categories, for the category multi-select. */
export function categoryOptions(categories: readonly IndexerCategory[], kind: SearchKind = 'all'): CategoryOption[] {
  // Newznab ranges: 2000 movies, 5000 TV. Narrow the list when a type is chosen.
  const keep = (id: number) => kind === 'all' || (kind === 'movie' ? id >= 2000 && id < 3000 : id >= 5000 && id < 6000);
  const out: CategoryOption[] = [];
  for (const c of categories) {
    if (!keep(c.id)) continue;
    out.push({ value: c.id, label: c.name, child: false });
    for (const s of c.subCategories) out.push({ value: s.id, label: s.name, child: true });
  }
  return out;
}

/** Category id -> display name (sub-categories as `Parent/Sub`). */
export function categoryNameMap(categories: readonly IndexerCategory[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const c of categories) {
    map.set(c.id, c.name);
    for (const s of c.subCategories) map.set(s.id, s.name.includes('/') ? s.name : `${c.name}/${s.name}`);
  }
  return map;
}

/** Seeders/leechers for torrents, grabs for usenet. */
export function peersLabel(r: ReleaseResource): string {
  if (r.protocol === 'torrent') return `${r.seeders ?? '?'} / ${r.leechers ?? '?'}`;
  return r.grabs !== undefined ? `${r.grabs} grabs` : '—';
}

/** `45m`, `5h`, `3d`. */
export function formatAge(r: Pick<ReleaseResource, 'age' | 'ageMinutes'>): string {
  const minutes = r.ageMinutes;
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${r.age}d`;
}

export type ProtocolFilter = 'all' | 'torrent' | 'usenet';

export interface ResultFilter {
  protocol: ProtocolFilter;
  /** Words that must all appear in the title. */
  text: string;
}

/** Client-side refinement of a result set. */
export function filterResults(results: readonly ReleaseResource[], f: ResultFilter): ReleaseResource[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  return results.filter((r) => {
    if (f.protocol !== 'all' && r.protocol !== f.protocol) return false;
    const title = r.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

/**
 * The link to download the .torrent / .nzb. Files go through the indexer (GET
 * /indexer/:id/download) so its login and cookies apply; magnets are linked directly.
 */
export function downloadLink(r: Pick<ReleaseResource, 'downloadUrl' | 'magnetUrl' | 'indexerId'>): string | null {
  if (r.downloadUrl && !r.downloadUrl.startsWith('magnet:')) return releaseDownloadHref(r.indexerId, r.downloadUrl);
  return r.downloadUrl || r.magnetUrl || null;
}

/** POST /search/grab answered 409 NO_MATCH: the result maps to nothing in the library. */
export function isNoMatch(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'NO_MATCH';
}
