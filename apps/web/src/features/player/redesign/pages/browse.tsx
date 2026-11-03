import { useEffect, useRef, useState } from 'react';
import type { PlayerMovie, PlayerSeries } from '@arclight/shared';
import { cx } from '../../../../arclight/cx.js';
import { useT } from '../../../../i18n/index.js';
import { useMovies, useSeriesList, useVideoHome } from '../../video/api.js';
import { watchPaths } from '../../video/paths.js';
import { takeHandedGenre } from '../../video/watch-home.js';
import { useMyList } from '../api.js';
import { WideTile } from '../tiles.js';
import { RdError, RdLoading, RdPage, useCardActions, useCardSubs } from './common.js';

// TV Shows, Movies and My List (the template's Browse screen; spec §4.4 / §4.5): title and
// "N titles", the genre chips, a grid of 16:9 tiles with the title inside, paged 60 at a time as
// the end comes into view.

type Kind = 'shows' | 'movies';

function BrowseHead({ title, count }: { title: string; count: number | null }) {
  const t = useT();
  return (
    <div className="rd-browse__head">
      <h1 className="rd-browse__title">{title}</h1>
      {count !== null ? <span className="rd-browse__count">{t('player.redesign.browse.count', { count })}</span> : null}
    </div>
  );
}

function GenreChips({ genres, value, onChange }: { genres: readonly string[]; value: string; onChange: (g: string) => void }) {
  const t = useT();
  if (!genres.length) return null;
  const all = ['', ...genres];
  return (
    <div className="rd-chips" role="group" aria-label={t('player.redesign.browse.genres')}>
      {all.map((g) => (
        <button key={g || '*'} type="button" className={cx('rd-chip', g === value && 'is-on')} aria-pressed={g === value} onClick={() => onChange(g)}>
          {g || t('player.redesign.browse.all')}
        </button>
      ))}
    </div>
  );
}

/** Loads the next page when the end of the grid scrolls into view. */
function useEndSentinel(onEnd: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onEnd);
  cb.current = onEnd;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

function titleSub(item: Pick<PlayerMovie | PlayerSeries, 'year' | 'genres'>): string {
  return [item.year, item.genres[0]].filter((x) => x !== null && x !== undefined && x !== '').join(' · ');
}

type LibraryQuery = ReturnType<typeof useMovies> | ReturnType<typeof useSeriesList>;

function LibraryPage({ kind, genre, setGenre, q }: { kind: Kind; genre: string; setGenre: (g: string) => void; q: LibraryQuery }) {
  const t = useT();
  const home = useVideoHome();
  const genres = (kind === 'movies' ? home.data?.movieGenres : home.data?.seriesGenres) ?? home.data?.genres ?? [];
  const items: (PlayerMovie | PlayerSeries)[] = q.data?.pages.flatMap((p) => p.items as (PlayerMovie | PlayerSeries)[]) ?? [];
  const total = q.data?.pages[0]?.total ?? null;
  const sentinel = useEndSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, Boolean(q.hasNextPage));
  const title = kind === 'movies' ? t('player.redesign.nav.movies') : t('player.redesign.nav.shows');

  useEffect(() => {
    document.title = `${title} · ${t('player.documentTitle')}`;
  }, [title, t]);

  return (
    <RdPage className="rd-browse">
      <div className="rd-browse__sticky">
        <BrowseHead title={title} count={total} />
        <GenreChips genres={genres} value={genre} onChange={setGenre} />
      </div>
      {q.isPending ? (
        <RdLoading />
      ) : q.isError ? (
        <RdError title={t('player.redesign.browse.failed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length ? (
        <ul className="rd-grid">
          {items.map((it) => {
            const sub = titleSub(it);
            return (
              <li key={it.id}>
                <WideTile
                  size="grid"
                  title={it.title}
                  sub={sub}
                  image={it.backdropUrl ?? it.posterUrl}
                  seed={it.title}
                  href={kind === 'movies' ? watchPaths.movie(it.id) : watchPaths.show(it.id)}
                  label={sub ? `${it.title}, ${sub}` : it.title}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rd-browse__empty">{t('player.redesign.browse.noTitles')}</p>
      )}
      <div ref={sentinel} className="rd-browse__sentinel" aria-hidden="true" />
      {q.isFetchingNextPage ? <RdLoading /> : null}
    </RdPage>
  );
}

export function RdShowsPage() {
  const [genre, setGenre] = useState('');
  const q = useSeriesList({ genre });
  return <LibraryPage kind="shows" genre={genre} setGenre={setGenre} q={q} />;
}

export function RdMoviesPage() {
  const [genre, setGenre] = useState(takeHandedGenre);
  const q = useMovies({ genre });
  return <LibraryPage kind="movies" genre={genre} setGenre={setGenre} q={q} />;
}

/** My List: the same grid; the design's empty text. */
export function RdMyListPage() {
  const t = useT();
  const list = useMyList();
  const subs = useCardSubs();
  const act = useCardActions();
  const items = list.data?.items ?? [];
  useEffect(() => {
    document.title = `${t('player.redesign.nav.myList')} · ${t('player.documentTitle')}`;
  }, [t]);
  return (
    <RdPage className="rd-browse">
      <div className="rd-browse__sticky">
        <BrowseHead title={t('player.redesign.nav.myList')} count={list.isPending ? null : items.length} />
      </div>
      {list.isPending ? (
        <RdLoading />
      ) : list.isError ? (
        <RdError title={t('player.redesign.browse.failed')} error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length ? (
        <ul className="rd-grid">
          {items.map((c) => {
            const sub = subs.plainSub(c);
            return (
              <li key={`${c.kind}:${c.id}`}>
                <WideTile size="grid" title={c.title} sub={sub} image={c.backdropUrl ?? c.posterUrl} seed={c.title} href={act.href(c)} label={sub ? `${c.title}, ${sub}` : c.title} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rd-browse__empty">{t('player.redesign.myList.empty')}</p>
      )}
    </RdPage>
  );
}
