import type { Movie, Series } from '@arclight/shared';
import { imageUrl } from '../../components/media/format.js';
import { t } from '../../i18n/index.js';

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
  overview: string;
  /** TMDB collection (movies only). */
  collection: { tmdbId: number; title: string } | null;
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
    overview: s.overview,
    collection: null,
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
    overview: m.overview,
    collection: m.collection ?? null,
    searchText: normaliseSearch(`${m.title} ${m.originalTitle} ${m.sortTitle} ${m.year}`),
  };
}

export type MonitoredFilter = 'all' | 'monitored' | 'unmonitored';

/** The `?tag=ID` search param as a tag id, or null. */
export function tagFromSearch(search: unknown): number | null {
  const raw = search && typeof search === 'object' ? (search as Record<string, unknown>)['tag'] : undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

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
    return terms.every((item) => r.searchText.includes(item));
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
  get title() {
    return t('common.title');
  },
  get added() {
    return t('library.filters.dateAdded');
  },
  get year() {
    return t('common.year');
  },
  get size() {
    return t('common.sizeOnDisk');
  },
  get progress() {
    return t('common.progress');
  },
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
  get continuing() {
    return t('library.filters.continuing');
  },
  get ended() {
    return t('library.filters.ended');
  },
  get upcoming() {
    return t('library.filters.upcoming');
  },
  get deleted() {
    return t('common.deleted');
  },
  get tba() {
    return t('common.tba');
  },
  get announced() {
    return t('library.filters.announced');
  },
  get inCinemas() {
    return t('common.inCinemas');
  },
  get released() {
    return t('common.released');
  },
};

/** Caption under a poster: "2022 · Apple TV+". */
export function rowMeta(r: Pick<LibraryRow, 'year' | 'subtitle'>): string {
  return [r.year || null, r.subtitle].filter(Boolean).join(' · ');
}

/** Poster progress bar tone: orange when monitored files are missing, grey when unmonitored. */
export function progressTone(r: Pick<LibraryRow, 'monitored' | 'have' | 'total'>): 'default' | 'warn' | 'muted' {
  if (!r.monitored) return 'muted';
  return r.total > 0 && r.have < r.total ? 'warn' : 'default';
}

export interface CollectionGroup {
  tmdbId: number;
  title: string;
  movies: LibraryRow[];
  /** Movies in the collection with a file on disk. */
  owned: number;
}

/** Movies grouped by TMDB collection (largest first); movies without one are left out. */
export function groupCollections(rows: readonly LibraryRow[]): CollectionGroup[] {
  const map = new Map<number, CollectionGroup>();
  for (const r of rows) {
    if (!r.collection) continue;
    const g = map.get(r.collection.tmdbId) ?? { tmdbId: r.collection.tmdbId, title: r.collection.title, movies: [], owned: 0 };
    g.movies.push(r);
    if (r.have > 0) g.owned += 1;
    map.set(r.collection.tmdbId, g);
  }
  for (const g of map.values()) g.movies.sort((a, b) => a.year - b.year || collator.compare(a.sortTitle, b.sortTitle));
  return [...map.values()].sort((a, b) => b.movies.length - a.movies.length || collator.compare(a.title, b.title));
}
