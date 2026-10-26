import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DISCOVER_MOVIE_SORTS, DISCOVER_TV_SORTS, type DiscoverQuery } from '@arclight/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import { FilterBar, Input, PageHeader, Segmented, Select } from '../../arclight/index.js';
import { DiscoverGrid } from './discover-kit.js';
import { useDiscoverGenres } from '../../hooks/requests.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { t } from '../../i18n/index.js';

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
    popularity: t('discover.browse.sortPopularity'),
    vote_average: t('discover.browse.sortRating'),
    vote_count: t('discover.browse.sortVotes'),
    primary_release_date: t('discover.browse.releaseDate'),
    first_air_date: t('discover.browse.firstAirDate'),
    revenue: t('discover.browse.sortRevenue'),
    original_title: t('common.title'),
    original_name: t('common.title'),
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
      <PageHeader index="02" title={kind === 'movie' ? t('discover.browse.discoverMovies') : t('discover.browse.discoverSeries')}>
        <Segmented
          aria-label={t('common.mediaType')}
          value={kind}
          onChange={(k) => void navigate({ to: k === 'movie' ? '/discover/movies' : '/discover/tv' })}
          options={[
            { value: 'movie', label: t('common.movies') },
            { value: 'tv', label: t('common.series') },
          ]}
        />
      </PageHeader>
      <FilterBar onClear={() => setFilters(EMPTY_FILTERS)} activeCount={activeDiscoverFilters(filters)}>
        <Select aria-label={t('discover.browse.sort')} value={filters.sortBy} onChange={set('sortBy')} options={sorts.map((s) => ({ value: s, label: sortLabel(s) }))} />
        <Select aria-label={t('discover.browse.genre')} value={filters.genre} onChange={set('genre')}>
          <option value="">{t('discover.browse.anyGenre')}</option>
          {(genres.data ?? []).map((g) => (
            <option key={g.id} value={String(g.id)}>
              {g.name}
            </option>
          ))}
        </Select>
        <Input aria-label={t('discover.browse.yearFrom')} mono inputMode="numeric" placeholder="1990" style={{ width: 90 }} value={filters.yearFrom} onChange={set('yearFrom')} />
        <Input aria-label={t('discover.browse.yearTo')} mono inputMode="numeric" placeholder="2026" style={{ width: 90 }} value={filters.yearTo} onChange={set('yearTo')} />
        <Input aria-label={t('discover.browse.minRating')} mono type="number" min={0} max={10} step={0.5} placeholder={t('discover.browse.rating')} style={{ width: 96 }} value={filters.minRating} onChange={set('minRating')} />
        <Input aria-label={t('common.language')} mono placeholder={t('discover.browse.en')} maxLength={3} style={{ width: 70 }} value={filters.language} onChange={set('language')} />
        <Input aria-label={t('discover.browse.runtimeMin')} mono type="number" min={0} placeholder={t('discover.browse.min')} end="min" style={{ width: 110 }} value={filters.runtimeMin} onChange={set('runtimeMin')} />
        <Input aria-label={t('discover.browse.runtimeMax')} mono type="number" min={0} placeholder={t('common.max')} end="min" style={{ width: 110 }} value={filters.runtimeMax} onChange={set('runtimeMax')} />
      </FilterBar>
      <div style={{ marginTop: 24 }}>
        <DiscoverGrid queryKey={requestKeys.discover.list(kind, query)} fetchPage={fetchPage} />
      </div>
    </>
  );
}
