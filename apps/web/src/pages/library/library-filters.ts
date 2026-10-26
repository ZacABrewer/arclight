import type { Movie, Series } from '@arclight/shared';
import { imageUrl } from '../../components/media/format.js';

// Library index model: series and movies are normalised to one row shape so filtering,
// sorting and both views (poster grid, table) share one implementation.

export type LibraryKind = 'series' | 'movie';

export interface LibraryRow {
  id: number;
  kind: LibraryKind;
  title: string;
  sortTitle: string;
  year: number;
  added: string;
  sizeOnDisk: number;
  /** Files on disk vs. files expected (series: aired+monitored episodes; movies: 1). */
  have: number;
  total: number;
  monitored: boolean;
  missing: boolean;
  qualityProfileId: number;
  tags: readonly number[];
  status: string;
  path: string;
  rootFolderPath: string;
  posterUrl: string | undefined;
  /** Network for series, studio for movies. */
  subtitle: string | null;
  searchText: string;
}

export function normaliseSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function seriesRow(s: Series): LibraryRow {
  const have = s.statistics?.episodeFileCount ?? 0;
  const total = s.statistics?.episodeCount ?? 0;
  return {
    id: s.id,
    kind: 'series',
    title: s.title,
    sortTitle: s.sortTitle,
    year: s.year,
    added: s.added,
    sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
    have,
    total,
    monitored: s.monitored,
    missing: have < total,
    qualityProfileId: s.qualityProfileId,
    tags: s.tags,
    status: s.status,
    path: s.path,
    rootFolderPath: s.rootFolderPath,
    posterUrl: imageUrl(s.images, 'poster'),
    subtitle: s.network ?? null,
    searchText: normaliseSearch(`${s.title} ${s.sortTitle} ${s.year}`),
  };
}

export function movieRow(m: Movie): LibraryRow {
  return {
    id: m.id,
    kind: 'movie',
    title: m.title,
    sortTitle: m.sortTitle,
    year: m.year,
    added: m.added,
    sizeOnDisk: m.statistics?.sizeOnDisk ?? 0,
    have: m.hasFile ? 1 : 0,
    total: 1,
    monitored: m.monitored,
    missing: !m.hasFile,
    qualityProfileId: m.qualityProfileId,
    tags: m.tags,
    status: m.status,
    path: m.path,
    rootFolderPath: m.rootFolderPath,
    posterUrl: imageUrl(m.images, 'poster'),
    subtitle: m.studio ?? null,
    searchText: normaliseSearch(`${m.title} ${m.originalTitle} ${m.sortTitle} ${m.year}`),
  };
}

export type MonitoredFilter = 'all' | 'monitored' | 'unmonitored';

export interface LibraryFilters {
  search: string;
  monitored: MonitoredFilter;
  /** Only items missing files. */
  missing: boolean;
  qualityProfileId: number | null;
  tagId: number | null;
  status: string | null;
}

export const DEFAULT_FILTERS: LibraryFilters = {
  search: '',
  monitored: 'all',
  missing: false,
  qualityProfileId: null,
  tagId: null,
  status: null,
};

export function filterRows(rows: readonly LibraryRow[], f: LibraryFilters): LibraryRow[] {
  const terms = normaliseSearch(f.search).split(' ').filter(Boolean);
  return rows.filter((r) => {
    if (f.monitored === 'monitored' && !r.monitored) return false;
    if (f.monitored === 'unmonitored' && r.monitored) return false;
    if (f.missing && !r.missing) return false;
    if (f.qualityProfileId !== null && r.qualityProfileId !== f.qualityProfileId) return false;
    if (f.tagId !== null && !r.tags.includes(f.tagId)) return false;
    if (f.status !== null && r.status !== f.status) return false;
    return terms.every((t) => r.searchText.includes(t));
  });
}

export function activeFilterCount(f: LibraryFilters): number {
  return (
    (f.monitored !== 'all' ? 1 : 0) +
    (f.missing ? 1 : 0) +
    (f.qualityProfileId !== null ? 1 : 0) +
    (f.tagId !== null ? 1 : 0) +
    (f.status !== null ? 1 : 0)
  );
}

export type LibrarySortKey = 'title' | 'added' | 'year' | 'size' | 'progress';
export interface LibrarySort {
  key: LibrarySortKey;
  direction: 'asc' | 'desc';
}

export const SORT_LABELS: Record<LibrarySortKey, string> = {
  title: 'Title',
  added: 'Date added',
  year: 'Year',
  size: 'Size on disk',
  progress: 'Progress',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Progress ratio; items with nothing expected sort below 0% so they do not look complete. */
export function progressRatio(r: Pick<LibraryRow, 'have' | 'total'>): number {
  return r.total > 0 ? r.have / r.total : -1;
}

function compareBy(key: LibrarySortKey, a: LibraryRow, b: LibraryRow): number {
  switch (key) {
    case 'title':
      return collator.compare(a.sortTitle, b.sortTitle);
    case 'added':
      return Date.parse(a.added) - Date.parse(b.added);
    case 'year':
      return a.year - b.year;
    case 'size':
      return a.sizeOnDisk - b.sizeOnDisk;
    case 'progress':
      return progressRatio(a) - progressRatio(b);
  }
}

/** Stable sort; ties fall back to title ascending regardless of direction. */
export function sortLibraryRows(rows: readonly LibraryRow[], sort: LibrarySort): LibraryRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * compareBy(sort.key, a, b) || collator.compare(a.sortTitle, b.sortTitle));
}

export const SERIES_STATUSES = ['continuing', 'ended', 'upcoming'] as const;
export const MOVIE_STATUSES = ['tba', 'announced', 'inCinemas', 'released'] as const;

export const STATUS_LABELS: Record<string, string> = {
  continuing: 'Continuing',
  ended: 'Ended',
  upcoming: 'Upcoming',
  deleted: 'Deleted',
  tba: 'TBA',
  announced: 'Announced',
  inCinemas: 'In cinemas',
  released: 'Released',
};
