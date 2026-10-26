import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DISCOVER_MOVIE_SORTS, DISCOVER_TV_SORTS, type DiscoverQuery } from '@arclight/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import { FilterBar, Input, PageHeader, Segmented, Select } from '../../arclight/index.js';
import { DiscoverGrid } from './discover-kit.js';
import { useDiscoverGenres } from '../../hooks/requests.js';
import { requestKeys } from '../../hooks/request-keys.js';

export interface DiscoverFilters {
  sortBy: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  minRating: string;
  language: string;
  runtimeMin: string;
  runtimeMax: string;
}

export const EMPTY_FILTERS: DiscoverFilters = {
  sortBy: 'popularity.desc',
  genre: '',
  yearFrom: '',
  yearTo: '',
  minRating: '',
  language: '',
  runtimeMin: '',
  runtimeMax: '',
};

const year = (v: string) => (/^\d{4}$/.test(v.trim()) ? v.trim() : null);
const num = (v: string) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Filter-bar state → the DiscoverQuery the api takes (page excluded). Invalid input is dropped. */
export function buildDiscoverQuery(f: DiscoverFilters): Omit<DiscoverQuery, 'page'> {
  const q: Omit<DiscoverQuery, 'page'> = {};
  if (f.sortBy) q.sortBy = f.sortBy;
  if (f.genre) q.genre = f.genre;
  const from = year(f.yearFrom);
  const to = year(f.yearTo);
  if (from) q.releaseDateGte = `${from}-01-01`;
  if (to) q.releaseDateLte = `${to}-12-31`;
  const rating = num(f.minRating);
  if (rating !== null) q.voteAverageGte = Math.min(10, Math.max(0, rating));
  const lang = f.language.trim().toLowerCase();
  if (/^[a-z]{2,3}$/.test(lang)) q.language = lang;
  const rmin = num(f.runtimeMin);
  const rmax = num(f.runtimeMax);
  if (rmin !== null && rmin >= 0) q.runtimeGte = Math.floor(rmin);
  if (rmax !== null && rmax >= 0) q.runtimeLte = Math.floor(rmax);
  return q;
}

export function sortLabel(sort: string): string {
  const [field = '', dir] = sort.split('.');
  const names: Record<string, string> = {
    popularity: 'Popularity',
    vote_average: 'Rating',
    vote_count: 'Votes',
    primary_release_date: 'Release date',
    first_air_date: 'First air date',
    revenue: 'Revenue',
    original_title: 'Title',
    original_name: 'Title',
  };
  return `${names[field] ?? field} ${dir === 'asc' ? '↑' : '↓'}`;
}

/** Filters that differ from the defaults (drives the FilterBar Clear button). */
export function activeDiscoverFilters(f: DiscoverFilters): number {
  return (Object.keys(EMPTY_FILTERS) as Array<keyof DiscoverFilters>).filter((k) => f[k] !== EMPTY_FILTERS[k]).length;
}

export function DiscoverMoviesPage() {
  return <DiscoverBrowse kind="movie" />;
}

export function DiscoverTvPage() {
  return <DiscoverBrowse kind="tv" />;
}

function DiscoverBrowse({ kind }: { kind: DiscoverKind }) {
  const [filters, setFilters] = useState<DiscoverFilters>(EMPTY_FILTERS);
  const navigate = useNavigate();
  const genres = useDiscoverGenres(kind);
  const query = useMemo(() => buildDiscoverQuery(filters), [filters]);
  const fetchPage = useCallback(
    (page: number) => (kind === 'movie' ? discoverApi.movies({ ...query, page }) : discoverApi.tv({ ...query, page })),
    [kind, query],
  );
  const set = (k: keyof DiscoverFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters({ ...filters, [k]: e.currentTarget.value });
  const sorts = kind === 'movie' ? DISCOVER_MOVIE_SORTS : DISCOVER_TV_SORTS;

  return (
    <>
      <PageHeader index="02" title={kind === 'movie' ? 'Discover movies' : 'Discover series'}>
        <Segmented
          aria-label="Media type"
          value={kind}
          onChange={(k) => void navigate({ to: k === 'movie' ? '/discover/movies' : '/discover/tv' })}
          options={[
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'Series' },
          ]}
        />
      </PageHeader>
      <FilterBar onClear={() => setFilters(EMPTY_FILTERS)} activeCount={activeDiscoverFilters(filters)}>
        <Select aria-label="Sort" value={filters.sortBy} onChange={set('sortBy')} options={sorts.map((s) => ({ value: s, label: sortLabel(s) }))} />
        <Select aria-label="Genre" value={filters.genre} onChange={set('genre')}>
          <option value="">Any genre</option>
          {(genres.data ?? []).map((g) => (
            <option key={g.id} value={String(g.id)}>
              {g.name}
            </option>
          ))}
        </Select>
        <Input aria-label="Year from" mono inputMode="numeric" placeholder="1990" style={{ width: 90 }} value={filters.yearFrom} onChange={set('yearFrom')} />
        <Input aria-label="Year to" mono inputMode="numeric" placeholder="2026" style={{ width: 90 }} value={filters.yearTo} onChange={set('yearTo')} />
        <Input aria-label="Min rating" mono type="number" min={0} max={10} step={0.5} placeholder="Rating" style={{ width: 96 }} value={filters.minRating} onChange={set('minRating')} />
        <Input aria-label="Language" mono placeholder="en" maxLength={3} style={{ width: 70 }} value={filters.language} onChange={set('language')} />
        <Input aria-label="Runtime min" mono type="number" min={0} placeholder="Min" end="min" style={{ width: 110 }} value={filters.runtimeMin} onChange={set('runtimeMin')} />
        <Input aria-label="Runtime max" mono type="number" min={0} placeholder="Max" end="min" style={{ width: 110 }} value={filters.runtimeMax} onChange={set('runtimeMax')} />
      </FilterBar>
      <div style={{ marginTop: 24 }}>
        <DiscoverGrid queryKey={requestKeys.discover.list(kind, query)} fetchPage={fetchPage} />
      </div>
    </>
  );
}
