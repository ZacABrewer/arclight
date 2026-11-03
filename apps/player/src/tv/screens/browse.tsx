import { useState, type ReactNode } from 'react';
import { useT } from '@web/i18n/index';
import { useMovies, useSeriesList, useVideoHome } from '@web/features/player/video/api';
import { useMyList } from '../../video/my-list';
import { cardArt, useVideoActions } from '../actions';
import { WideTile } from '../tiles';
import type { Translate } from '../format';

// TV Shows / Movies / My List (template "browse"): title and count, genre chips, a 4-column 16:9
// grid. More pages load as focus nears the end of what is loaded.

/** Template wide-tile sub: "year · first genre". */
export function titleSub(year: number | null, genres: readonly string[]): string | null {
  return [year ? String(year) : null, genres[0] ?? null].filter(Boolean).join(' · ') || null;
}

const PREFETCH_ROWS = 2;

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

function Frame({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  const t = useT();
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-browse">
        <div className="tv-headline">
          <h1 className="tv-h1">{title}</h1>
          {count != null ? <span className="tv-count">{t('app.tv.count', { count })}</span> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

type Paged = ReturnType<typeof useMovies> | ReturnType<typeof useSeriesList>;

function BrowseGrid({ kind, q, genre, setGenre }: { kind: 'movies' | 'shows'; q: Paged; genre: string | null; setGenre: (g: string | null) => void }) {
  const t = useT();
  const home = useVideoHome();
  const { openTitle } = useVideoActions();
  const genres = (kind === 'movies' ? home.data?.movieGenres : home.data?.seriesGenres) ?? home.data?.genres ?? [];
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items as { id: number; title: string; year: number | null; genres: string[]; backdropUrl: string | null; posterUrl: string | null }[]);
  const total = pages[0]?.total ?? null;
  const more = (i: number) => {
    if (q.hasNextPage && !q.isFetchingNextPage && i >= items.length - 4 * PREFETCH_ROWS) void q.fetchNextPage();
  };
  return (
    <Frame title={t(kind === 'movies' ? 'app.tv.tab.movies' : 'app.tv.tab.shows')} count={total}>
      <Chips genres={genres} genre={genre} onPick={setGenre} t={t} />
      <div className="tv-grid">
        {items.map((m, i) => (
          <div key={m.id} onFocus={() => more(i)} style={{ display: 'contents' }}>
            <WideTile id={`g-${m.id}`} title={m.title} sub={titleSub(m.year, m.genres)} art={m.backdropUrl ?? m.posterUrl} onOpen={() => openTitle(kind === 'movies' ? 'movie' : 'series', m.id)} />
          </div>
        ))}
      </div>
    </Frame>
  );
}

export function TvMoviesScreen() {
  const [genre, setGenre] = useState<string | null>(null);
  const q = useMovies({ genre: genre ?? undefined });
  return <BrowseGrid kind="movies" q={q} genre={genre} setGenre={setGenre} />;
}

export function TvShowsScreen() {
  const [genre, setGenre] = useState<string | null>(null);
  const q = useSeriesList({ genre: genre ?? undefined });
  return <BrowseGrid kind="shows" q={q} genre={genre} setGenre={setGenre} />;
}

export function TvMyListScreen() {
  const t = useT();
  const list = useMyList();
  const { openCard } = useVideoActions();
  const items = list.data?.items ?? [];
  return (
    <Frame title={t('app.tv.tab.myList')} count={list.isSuccess ? items.length : null}>
      {list.isSuccess && !items.length ? <div className="tv-empty">{t('app.tv.myListEmpty')}</div> : null}
      <div className="tv-grid">
        {items.map((c) => (
          <WideTile key={`${c.kind}:${c.id}`} id={`g-${c.kind}:${c.id}`} title={c.title} sub={c.year ? String(c.year) : null} art={cardArt(c)} onOpen={() => openCard(c)} />
        ))}
      </div>
    </Frame>
  );
}
