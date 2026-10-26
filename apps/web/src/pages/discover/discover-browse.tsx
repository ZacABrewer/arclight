import { useCallback, useMemo, useState } from 'react';
import { DISCOVER_MOVIE_SORTS, DISCOVER_TV_SORTS, type DiscoverQuery } from '@arclight/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import { Button } from '../../components/button.js';
import { FormField, Input, Select } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { DiscoverGrid } from '../../features/requests/discover-ui.js';
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

export function DiscoverMoviesPage() {
  return <DiscoverBrowse kind="movie" />;
}

export function DiscoverTvPage() {
  return <DiscoverBrowse kind="tv" />;
}

function DiscoverBrowse({ kind }: { kind: DiscoverKind }) {
  const [filters, setFilters] = useState<DiscoverFilters>(EMPTY_FILTERS);
  const genres = useDiscoverGenres(kind);
  const query = useMemo(() => buildDiscoverQuery(filters), [filters]);
  const fetchPage = useCallback(
    (page: number) => (kind === 'movie' ? discoverApi.movies({ ...query, page }) : discoverApi.tv({ ...query, page })),
    [kind, query],
  );
  const set = (k: keyof DiscoverFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters({ ...filters, [k]: e.currentTarget.value });
  const sorts = kind === 'movie' ? DISCOVER_MOVIE_SORTS : DISCOVER_TV_SORTS;

  return (
    <Page title={kind === 'movie' ? 'Discover movies' : 'Discover series'}>
      <div className="filter-bar" role="group" aria-label="Filters">
        <FormField label="Sort">
          <Select value={filters.sortBy} onChange={set('sortBy')} options={sorts.map((s) => ({ value: s, label: sortLabel(s) }))} />
        </FormField>
        <FormField label="Genre">
          <Select value={filters.genre} onChange={set('genre')}>
            <option value="">Any</option>
            {(genres.data ?? []).map((g) => (
              <option key={g.id} value={String(g.id)}>
                {g.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Year from">
          <Input className="input-narrow" inputMode="numeric" placeholder="1990" value={filters.yearFrom} onChange={set('yearFrom')} />
        </FormField>
        <FormField label="Year to">
          <Input className="input-narrow" inputMode="numeric" placeholder="2026" value={filters.yearTo} onChange={set('yearTo')} />
        </FormField>
        <FormField label="Min rating">
          <Input className="input-narrow" type="number" min={0} max={10} step={0.5} value={filters.minRating} onChange={set('minRating')} />
        </FormField>
        <FormField label="Language">
          <Input className="input-narrow" placeholder="en" maxLength={3} value={filters.language} onChange={set('language')} />
        </FormField>
        <FormField label="Runtime min">
          <Input className="input-narrow" type="number" min={0} value={filters.runtimeMin} onChange={set('runtimeMin')} />
        </FormField>
        <FormField label="Runtime max">
          <Input className="input-narrow" type="number" min={0} value={filters.runtimeMax} onChange={set('runtimeMax')} />
        </FormField>
        <Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
          Reset
        </Button>
      </div>
      <DiscoverGrid queryKey={requestKeys.discover.list(kind, query)} fetchPage={fetchPage} />
    </Page>
  );
}
