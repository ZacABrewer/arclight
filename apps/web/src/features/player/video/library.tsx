import { useMemo, useState, type ReactNode } from 'react';
import { Input, Segmented, Select } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { LETTERS } from '../browse/format.js';
import { Empty, GridSkeleton, LoadError, LoadMore, PageTitle, useDebounced, useStoredChoice } from '../browse/kit.js';
import { useMovies, useSeriesList, type VideoFilters, type VideoSort, type WatchedFilter } from './api.js';
import { MovieCard, SeriesCard } from './cards.js';
import { WatchNav, takeHandedGenre } from './watch-home.js';
import './watch.css';

// /player/watch/movies and /player/watch/shows: poster grids with search, sort, genre, a
// watched filter, a letter rail and a density switch (S/M/L poster sizes).

export type Density = 's' | 'm' | 'l';
const DENSITIES: readonly Density[] = ['s', 'm', 'l'];
export const DENSITY_STORAGE_KEY = 'arclight.player.watch.density';
const SORTS: readonly VideoSort[] = ['title', 'added', 'year', 'rating'];
const WATCHED: readonly WatchedFilter[] = ['all', 'unwatched', 'watched'];
/** Sorts that read newest / highest first. */
const DESC: ReadonlySet<VideoSort> = new Set(['added', 'year', 'rating']);

function useVideoControls(kind: 'movies' | 'shows') {
  const t = useT();
  const [density, setDensity] = useStoredChoice<Density>(DENSITY_STORAGE_KEY, DENSITIES, 'm');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<VideoSort>('title');
  const [genre, setGenre] = useState(() => (kind === 'movies' ? takeHandedGenre() : ''));
  const [letter, setLetter] = useState('');
  const [watched, setWatched] = useState<WatchedFilter>('all');
  const debounced = useDebounced(search, 300);
  const filters: VideoFilters = useMemo(
    () => ({ search: debounced.trim() || undefined, sort, order: DESC.has(sort) ? 'desc' : 'asc', genre: genre || undefined, letter: letter || undefined, watched }),
    [debounced, sort, genre, letter, watched],
  );
  const filtered = !!(filters.search || filters.genre || filters.letter || watched !== 'all');

  const bar = (genres: readonly string[], total: number): ReactNode => {
    const genreOptions = [...new Set([...genres, ...(genre ? [genre] : [])])].sort((a, b) => a.localeCompare(b));
    return (
      <div className="pb-filters">
        <div className="pb-filters__row">
          <label className="pb-filters__search">
            <span className="pb-visually-hidden">{t(`player.video.search.${kind}`)}</span>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t(`player.video.search.${kind}`)} />
          </label>
          <label className="pb-filters__field">
            <span className="pb-filters__label">{t('player.browse.library.sort')}</span>
            <Select value={sort} onChange={(e) => setSort(e.target.value as VideoSort)} options={SORTS.map((s) => ({ value: s, label: t(`player.video.sort.${s}`) }))} />
          </label>
          <label className="pb-filters__field">
            <span className="pb-filters__label">{t('player.browse.library.genre')}</span>
            <Select value={genre} onChange={(e) => setGenre(e.target.value)}>
              <option value="">{t('player.browse.library.allGenres')}</option>
              {genreOptions.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </label>
          <Segmented<Density>
            variant="soft"
            aria-label={t('player.video.density')}
            value={density}
            onChange={setDensity}
            options={DENSITIES.map((d) => ({ value: d, label: t(`player.video.densityShort.${d}`) }))}
          />
        </div>
        <div className="vw-chiprow">
          <div className="vw-chips" role="group" aria-label={t('player.video.watchedFilter')}>
            {WATCHED.map((w) => (
              <button key={w} type="button" className="vw-chip" aria-pressed={watched === w} onClick={() => setWatched(w)}>
                {t(`player.video.watchedOption.${w}`)}
              </button>
            ))}
          </div>
          <span className="vw-count" aria-live="polite">
            {t(`player.video.count.${kind}`, { count: total })}
          </span>
        </div>
        <nav className="pb-rail" aria-label={t('player.browse.library.jump')}>
          <button type="button" className="pb-rail__btn" aria-pressed={letter === ''} onClick={() => setLetter('')}>
            {t('player.browse.library.allLetters')}
          </button>
          {LETTERS.map((l) => (
            <button
              key={l}
              type="button"
              className="pb-rail__btn"
              aria-pressed={letter === l}
              aria-label={l === '#' ? t('player.browse.library.letterOther') : t('player.browse.library.letter', { letter: l })}
              onClick={() => setLetter(letter === l ? '' : l)}
            >
              {l}
            </button>
          ))}
        </nav>
      </div>
    );
  };
  return { filters, filtered, density, bar };
}

/** /player/watch/movies */
export function MoviesPage() {
  const t = useT();
  const c = useVideoControls('movies');
  const q = useMovies(c.filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const genres = [...new Set(items.flatMap((m) => m.genres))];
  return (
    <div className="pb-page">
      <PageTitle eyebrow={q.data ? t('player.video.titlesCount', { count: total }) : undefined}>{t('player.video.nav.movies')}</PageTitle>
      <WatchNav />
      {c.bar(genres, total)}
      {q.isPending ? (
        <GridSkeleton label={t('player.browse.loading')} />
      ) : q.isError ? (
        <LoadError title={t('player.video.moviesFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        c.filtered ? (
          <Empty title={t('player.browse.library.noMatch')}>{t('player.browse.library.noMatchBody')}</Empty>
        ) : (
          <Empty title={t('player.video.noMoviesTitle')}>{t('player.video.noMoviesBody')}</Empty>
        )
      ) : (
        <>
          <ul className="vw-grid" data-density={c.density} aria-label={t('player.video.nav.movies')}>
            {items.map((m) => (
              <MovieCard key={m.id} movie={m} />
            ))}
          </ul>
          <LoadMore shown={items.length} total={total} hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </>
      )}
    </div>
  );
}

/** /player/watch/shows */
export function ShowsPage() {
  const t = useT();
  const c = useVideoControls('shows');
  const q = useSeriesList(c.filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const genres = [...new Set(items.flatMap((s) => s.genres))];
  return (
    <div className="pb-page">
      <PageTitle eyebrow={q.data ? t('player.video.titlesCount', { count: total }) : undefined}>{t('player.video.nav.shows')}</PageTitle>
      <WatchNav />
      {c.bar(genres, total)}
      {q.isPending ? (
        <GridSkeleton label={t('player.browse.loading')} />
      ) : q.isError ? (
        <LoadError title={t('player.video.showsFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        c.filtered ? (
          <Empty title={t('player.browse.library.noMatch')}>{t('player.browse.library.noMatchBody')}</Empty>
        ) : (
          <Empty title={t('player.video.noShowsTitle')}>{t('player.video.noShowsBody')}</Empty>
        )
      ) : (
        <>
          <ul className="vw-grid" data-density={c.density} aria-label={t('player.video.nav.shows')}>
            {items.map((s) => (
              <SeriesCard key={s.id} series={s} />
            ))}
          </ul>
          <LoadMore shown={items.length} total={total} hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </>
      )}
    </div>
  );
}
