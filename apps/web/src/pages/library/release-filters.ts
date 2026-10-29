import type { ReleaseDecision } from '@arclight/shared';

// Filters over the release tables (interactive search for video, music and audiobooks). A movie
// search can return hundreds of releases; these narrow down what was already fetched, client
// side, without asking the indexers again.

export type ReleaseDecisionFilter = 'all' | 'approved' | 'rejected';
export type ReleaseProtocolFilter = 'all' | 'torrent' | 'usenet';

export interface ReleaseFilters {
  /** Words the title must all contain (case and separators ignored). */
  title: string;
  /** Quality definition ids; empty = any. */
  qualities: readonly number[];
  /** Indexer ids; empty = any. */
  indexers: readonly number[];
  protocol: ReleaseProtocolFilter;
  /** Bytes; null = no bound. */
  minSize: number | null;
  maxSize: number | null;
  /** Torrents with fewer (or unknown) seeders are hidden; usenet releases have none and pass. */
  minSeeders: number | null;
  /** `rejected` includes temporarily rejected (delayed) releases. */
  decision: ReleaseDecisionFilter;
}

export const DEFAULT_RELEASE_FILTERS: ReleaseFilters = {
  title: '',
  qualities: [],
  indexers: [],
  protocol: 'all',
  minSize: null,
  maxSize: null,
  minSeeders: null,
  decision: 'all',
};

type FilterableRelease = Pick<ReleaseDecision, 'title' | 'quality' | 'indexerId' | 'indexerName' | 'protocol' | 'size' | 'seeders' | 'approved'>;

/** "Dune.Part.Two_2024" and "dune part two" read the same: lower case, separators as spaces. */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[._\-\s]+/g, ' ')
    .trim();
}

function titleTerms(query: string): string[] {
  const q = normalizeTitle(query);
  return q === '' ? [] : q.split(' ');
}

/** Does one release pass every filter? */
export function matchesReleaseFilters(r: FilterableRelease, f: ReleaseFilters, terms = titleTerms(f.title)): boolean {
  if (terms.length > 0) {
    const title = normalizeTitle(r.title);
    if (!terms.every((term) => title.includes(term))) return false;
  }
  if (f.qualities.length > 0 && !f.qualities.includes(r.quality.quality.id)) return false;
  if (f.indexers.length > 0 && !f.indexers.includes(r.indexerId)) return false;
  if (f.protocol !== 'all' && r.protocol !== f.protocol) return false;
  if (f.minSize !== null && r.size < f.minSize) return false;
  if (f.maxSize !== null && r.size > f.maxSize) return false;
  if (f.minSeeders !== null && f.minSeeders > 0 && r.protocol === 'torrent' && (r.seeders ?? -1) < f.minSeeders) return false;
  if (f.decision === 'approved' && !r.approved) return false;
  if (f.decision === 'rejected' && r.approved) return false;
  return true;
}

export function filterReleases<T extends FilterableRelease>(rows: readonly T[], f: ReleaseFilters): T[] {
  const terms = titleTerms(f.title);
  return rows.filter((r) => matchesReleaseFilters(r, f, terms));
}

/** Number of filters that differ from the defaults (drives the Clear button). */
export function activeReleaseFilterCount(f: ReleaseFilters): number {
  return (
    (normalizeTitle(f.title) !== '' ? 1 : 0) +
    (f.qualities.length > 0 ? 1 : 0) +
    (f.indexers.length > 0 ? 1 : 0) +
    (f.protocol !== 'all' ? 1 : 0) +
    (f.minSize !== null || f.maxSize !== null ? 1 : 0) +
    (f.minSeeders !== null && f.minSeeders > 0 ? 1 : 0) +
    (f.decision !== 'all' ? 1 : 0)
  );
}

export interface ReleaseFilterOption {
  value: number;
  label: string;
}

export interface ReleaseFilterChoices {
  /** Qualities in the results, best first (by quality weight). */
  qualities: ReleaseFilterOption[];
  /** Indexers in the results, alphabetical. */
  indexers: ReleaseFilterOption[];
  /** Both protocols occur (the protocol filter is only worth showing then). */
  mixedProtocols: boolean;
  /** Any torrent release (the seeders filter only applies to torrents). */
  hasTorrents: boolean;
}

/** What the multi-selects offer: the values present in the results. */
export function releaseFilterChoices(rows: readonly FilterableRelease[]): ReleaseFilterChoices {
  const qualities = new Map<number, { label: string; weight: number }>();
  const indexers = new Map<number, string>();
  const protocols = new Set<string>();
  for (const r of rows) {
    const q = r.quality.quality;
    qualities.set(q.id, { label: q.name, weight: q.weight });
    indexers.set(r.indexerId, r.indexerName);
    protocols.add(r.protocol);
  }
  return {
    qualities: [...qualities.entries()]
      .sort((a, b) => b[1].weight - a[1].weight || a[1].label.localeCompare(b[1].label))
      .map(([value, q]) => ({ value, label: q.label })),
    indexers: [...indexers.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]).map(([value, label]) => ({ value, label })),
    mixedProtocols: protocols.size > 1,
    hasTorrents: protocols.has('torrent'),
  };
}

const GB = 1024 ** 3;

/** A size field ("1.5", GB) as bytes; blank or invalid = no bound. */
export function parseSizeGb(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(n) || n < 0 ? null : Math.round(n * GB);
}

/** Bytes back to the GB field text (up to two decimals). */
export function formatSizeGb(bytes: number | null): string {
  return bytes === null ? '' : String(Math.round((bytes / GB) * 100) / 100);
}
