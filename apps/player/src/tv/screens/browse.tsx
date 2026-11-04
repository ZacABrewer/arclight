import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { VideoCard } from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { useMovies, useSeriesList, useVideoHome, type VideoFilters, type VideoSort } from '@web/features/player/video/api';
import { useMyList } from '@web/features/player/redesign/api';
import { cardArt, cardMeta, useVideoActions } from '../actions';
import { WideTile } from '../tiles';
import type { Translate } from '../format';
import { HOME_PATH } from '../tv-runtime';

// TV Shows / Movies / My List (design S09–S11): title and count, chips, then the grid: 4-up 16:9
// for shows and My List, 6-up 2:3 posters with a sort for movies. More pages load as focus nears
// the end of what is loaded. A filter with no matches keeps its chips, so there is a way out.

/** Template wide-tile sub: "year · first genre". */
export function titleSub(year: number | null, genres: readonly string[]): string | null {
  return [year ? String(year) : null, genres[0] ?? null].filter(Boolean).join(' · ') || null;
}

const PREFETCH_ROWS = 2;

/** Movies' sorts, in the order OK cycles through them. */
export const SORTS: { sort: VideoSort; order: 'asc' | 'desc' }[] = [
  { sort: 'added', order: 'desc' },
  { sort: 'title', order: 'asc' },
  { sort: 'year', order: 'desc' },
  { sort: 'rating', order: 'desc' },
];

function Chips({ genres, genre, onPick, t }: { genres: string[]; genre: string | null; onPick: (g: string | null) => void; t: Translate }) {
  if (!genres.length) return null;
  const all = [null, ...genres];
  return (
    <div className="tv-chips" data-tv-row="">
      {all.map((g, i) => (
        <button key={g ?? '*'} type="button" className="tv-chip" data-tv-key={`chip-${i}`} data-tv-r="999" aria-pressed={g === genre} onClick={() => onPick(g)}>
          {g ?? t('app.tv.all')}
        </button>
      ))}
    </div>
  );
}

function Frame({ title, count, aside, children }: { title: string; count: number | null; aside?: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-browse">
        <div className="tv-headline">
          <h1 className="tv-h1">{title}</h1>
          {count != null ? <span className="tv-count">{t('app.tv.count', { count })}</span> : null}
          {aside}
        </div>
        {children}
      </div>
    </div>
  );
}

function NoResults({ title, text }: { title: string; text: string }) {
  return (
    <div className="tv-noresults">
      <div className="tv-noresults__title">{title}</div>
      <div className="tv-noresults__text">{text}</div>
    </div>
  );
}

type Paged = ReturnType<typeof useMovies> | ReturnType<typeof useSeriesList>;
type BrowseItem = { id: number; title: string; year: number | null; genres: string[]; backdropUrl: string | null; posterUrl: string | null; badges?: string[] };

function BrowseGrid({ kind, q, genre, setGenre, sort, onSort }: { kind: 'movies' | 'shows'; q: Paged; genre: string | null; setGenre: (g: string | null) => void; sort?: number; onSort?: () => void }) {
  const t = useT();
  const home = useVideoHome();
  const { openTitle } = useVideoActions();
  const genres = (kind === 'movies' ? home.data?.movieGenres : home.data?.seriesGenres) ?? home.data?.genres ?? [];
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items as BrowseItem[]);
  const total = pages[0]?.total ?? null;
  const posters = kind === 'movies';
  const perRow = posters ? 6 : 4;
  const more = (i: number) => {
    if (q.hasNextPage && !q.isFetchingNextPage && i >= items.length - perRow * PREFETCH_ROWS) void q.fetchNextPage();
  };
  const current = sort != null ? SORTS[sort % SORTS.length] : undefined;
  const aside =
    current && onSort ? (
      <div className="tv-sort">
        <span>{t('app.tv.sortBy')}</span>
        <button type="button" className="tv-sort__btn" data-tv-key="sort" data-tv-r="6" onClick={onSort}>
          {t(`app.tv.sort.${current.sort}`)} ▾
        </button>
      </div>
    ) : null;
  return (
    <Frame title={t(kind === 'movies' ? 'app.tv.tab.movies' : 'app.tv.tab.shows')} count={total} aside={aside}>
      <Chips genres={genres} genre={genre} onPick={setGenre} t={t} />
      {q.isSuccess && total === 0 && genre ? <NoResults title={t(posters ? 'app.tv.noGenreMovies' : 'app.tv.noGenreShows', { genre })} text={t('app.tv.noGenreHint')} /> : null}
      <div className={`tv-grid${posters ? ' tv-grid--posters' : ''}`}>
        {items.map((m, i) => (
          <div key={m.id} onFocus={() => more(i)} style={{ display: 'contents' }}>
            <WideTile
              id={`g-${m.id}`}
              title={m.title}
              sub={titleSub(m.year, m.genres)}
              art={posters ? (m.posterUrl ?? m.backdropUrl) : (m.backdropUrl ?? m.posterUrl)}
              poster={posters}
              meta={[m.year ? String(m.year) : null, ...m.genres.slice(0, 2), ...(m.badges ?? [])].filter(Boolean).join(' · ') || null}
              onOpen={() => openTitle(posters ? 'movie' : 'series', m.id)}
            />
          </div>
        ))}
      </div>
    </Frame>
  );
}

export function TvMoviesScreen() {
  const [genre, setGenre] = useState<string | null>(null);
  const [sort, setSort] = useState(0);
  const s = SORTS[sort % SORTS.length];
  const filters: VideoFilters = { genre: genre ?? undefined, sort: s?.sort, order: s?.order };
  const q = useMovies(filters);
  return <BrowseGrid kind="movies" q={q} genre={genre} setGenre={setGenre} sort={sort} onSort={() => setSort((v) => (v + 1) % SORTS.length)} />;
}

export function TvShowsScreen() {
  const [genre, setGenre] = useState<string | null>(null);
  const q = useSeriesList({ genre: genre ?? undefined });
  return <BrowseGrid kind="shows" q={q} genre={genre} setGenre={setGenre} />;
}

export type ListFilter = 'all' | 'series' | 'movies' | 'unwatched';
const LIST_FILTERS: ListFilter[] = ['all', 'series', 'movies', 'unwatched'];

/** My List's type chips. */
export function listFilter(items: readonly VideoCard[], f: ListFilter): VideoCard[] {
  if (f === 'series') return items.filter((c) => c.kind === 'series');
  if (f === 'movies') return items.filter((c) => c.kind === 'movie');
  if (f === 'unwatched') return items.filter((c) => !c.progress?.played);
  return [...items];
}

export function TvMyListScreen() {
  const t = useT();
  const list = useMyList();
  const { openCard } = useVideoActions();
  const [filter, setFilter] = useState<ListFilter>('all');
  const all = list.data?.items ?? [];
  const items = listFilter(all, filter);
  if (list.isSuccess && !all.length) {
    return (
      <Frame title={t('app.tv.tab.myList')} count={0}>
        <div className="tv-listempty" data-tv-row="">
          <span className="tv-listempty__plus" aria-hidden="true">
            +
          </span>
          <div className="tv-listempty__body">
            <NoResults title={t('app.tv.myListEmptyTitle')} text={t('app.tv.myListEmpty')} />
            <div className="tv-btns">
              <Link to={HOME_PATH} className="tv-btn tv-btn--primary" data-tv-key="list-trending" data-tv-autofocus="" data-tv-r="8">
                {t('app.tv.browseTrending')}
              </Link>
            </div>
          </div>
        </div>
      </Frame>
    );
  }
  return (
    <Frame title={t('app.tv.tab.myList')} count={list.isSuccess ? all.length : null}>
      {all.length ? (
        <div className="tv-chips" data-tv-row="">
          {LIST_FILTERS.map((f, i) => (
            <button key={f} type="button" className="tv-chip" data-tv-key={`chip-${i}`} data-tv-r="999" aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {t(`app.tv.listFilter.${f}`)}
            </button>
          ))}
        </div>
      ) : null}
      {all.length && !items.length ? <NoResults title={t('app.tv.listFilterEmpty')} text={t('app.tv.listFilterHint')} /> : null}
      <div className="tv-grid">
        {items.map((c) => (
          <WideTile
            key={`${c.kind}:${c.id}`}
            id={`g-${c.kind}:${c.id}`}
            title={c.title}
            sub={c.year ? String(c.year) : null}
            art={cardArt(c)}
            badge={t(c.kind === 'movie' ? 'app.tv.movie' : 'app.tv.series').toUpperCase()}
            meta={cardMeta(c)}
            fraction={c.progress && !c.progress.played && c.progress.durationMs ? c.progress.positionMs / c.progress.durationMs : null}
            onOpen={() => openCard(c)}
          />
        ))}
      </div>
    </Frame>
  );
}
