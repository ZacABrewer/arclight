import { Input } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { usePlayerSearch } from './api.js';
import { AlbumCard, ArtistCard, BookCard } from './cards.js';
import { Empty, GridSkeleton, LoadError, PageTitle, useDebounced, useUrlQuery } from './kit.js';
import { TrackList } from './tracks.js';
import { MovieCard, SeriesCard } from '../video/cards.js';
import '../video/watch.css';

export const SEARCH_DEBOUNCE_MS = 300;

/** /player/search: one box across movies, shows, tracks, albums, artists and audiobooks. */
export function PlayerSearchPage() {
  const t = useT();
  const [text, setText] = useUrlQuery();
  const q = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);
  const res = usePlayerSearch(q);

  let body;
  if (!q) body = <Empty title={t('player.browse.search.startTitle')}>{t('player.browse.search.startBody')}</Empty>;
  else if (res.isPending) body = <GridSkeleton count={6} label={t('player.browse.search.searching')} />;
  else if (res.isError) body = <LoadError title={t('player.browse.search.failed')} error={res.error} onRetry={() => void res.refetch()} />;
  else {
    const d = res.data;
    const movies = d.movies ?? [];
    const series = d.series ?? [];
    const none = !d.tracks.length && !d.albums.length && !d.artists.length && !d.audiobooks.length && !movies.length && !series.length;
    body = none ? (
      <Empty title={t('player.browse.search.noResults', { query: q })}>{t('player.browse.search.noResultsBody')}</Empty>
    ) : (
      <>
        {movies.length ? (
          <section className="pb-section" aria-labelledby="pb-s-movies">
            <h2 className="pb-section__title" id="pb-s-movies">
              {t('player.video.nav.movies')}
            </h2>
            <ul className="vw-grid">
              {movies.map((m) => (
                <MovieCard key={m.id} movie={m} />
              ))}
            </ul>
          </section>
        ) : null}
        {series.length ? (
          <section className="pb-section" aria-labelledby="pb-s-shows">
            <h2 className="pb-section__title" id="pb-s-shows">
              {t('player.video.nav.shows')}
            </h2>
            <ul className="vw-grid">
              {series.map((sr) => (
                <SeriesCard key={sr.id} series={sr} />
              ))}
            </ul>
          </section>
        ) : null}
        {d.artists.length ? (
          <section className="pb-section" aria-labelledby="pb-s-artists">
            <h2 className="pb-section__title" id="pb-s-artists">
              {t('player.browse.nav.artists')}
            </h2>
            <ul className="pb-grid">
              {d.artists.map((a) => (
                <ArtistCard key={a.id} artist={a} />
              ))}
            </ul>
          </section>
        ) : null}
        {d.tracks.length ? (
          <section className="pb-section" aria-labelledby="pb-s-tracks">
            <h2 className="pb-section__title" id="pb-s-tracks">
              {t('player.browse.search.tracks')}
            </h2>
            <TrackList tracks={d.tracks} source={`search:${q}`.slice(0, 100)} label={t('player.browse.search.tracks')} showAlbum />
          </section>
        ) : null}
        {d.albums.length ? (
          <section className="pb-section" aria-labelledby="pb-s-albums">
            <h2 className="pb-section__title" id="pb-s-albums">
              {t('player.browse.nav.albums')}
            </h2>
            <ul className="pb-grid">
              {d.albums.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </ul>
          </section>
        ) : null}
        {d.audiobooks.length ? (
          <section className="pb-section" aria-labelledby="pb-s-books">
            <h2 className="pb-section__title" id="pb-s-books">
              {t('player.browse.books.title')}
            </h2>
            <ul className="pb-grid">
              {d.audiobooks.map((b) => (
                <BookCard key={b.id} book={b} />
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div className="pb-page">
      <PageTitle>{t('player.browse.search.title')}</PageTitle>
      <form role="search" className="pb-search" onSubmit={(e) => e.preventDefault()}>
        <label className="pb-filters__search">
          <span className="pb-visually-hidden">{t('player.browse.search.label')}</span>
          <Input type="search" size="lg" value={text} autoFocus onChange={(e) => setText(e.target.value)} placeholder={t('player.browse.search.placeholder')} />
        </label>
      </form>
      {body}
    </div>
  );
}
