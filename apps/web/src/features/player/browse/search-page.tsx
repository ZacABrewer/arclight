import { useEffect, useId } from 'react';
import { useT } from '../../../i18n/index.js';
import { RdIcon } from '../redesign/icons.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { WideTile } from '../redesign/tiles.js';
import { watchPaths } from '../video/paths.js';
import { usePlayerSearch } from './api.js';
import { AlbumTile, ArtistTile, BookTile } from './cards.js';
import { useDebounced, useUrlQuery } from './kit.js';
import { AudioNotice, AudioPage, AudioSection } from './rd-audio.js';
import { TrackList } from './tracks.js';

export const SEARCH_DEBOUNCE_MS = 300;

/**
 * /player/search: one box across movies, shows, tracks, albums, artists and audiobooks. The bar
 * is the redesign search bar; each kind is a titled section of the tiles its own pages use.
 */
export function PlayerSearchPage() {
  const t = useT();
  const inputId = useId();
  const [text, setText] = useUrlQuery();
  const q = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);
  const res = usePlayerSearch(q);

  useEffect(() => {
    document.title = `${t('player.browse.search.title')} · ${t('player.documentTitle')}`;
  }, [t]);

  let body;
  if (!q) body = <AudioNotice title={t('player.browse.search.startTitle')}>{t('player.browse.search.startBody')}</AudioNotice>;
  else if (res.isPending) body = <RdLoading />;
  else if (res.isError) body = <RdError title={t('player.browse.search.failed')} error={res.error} onRetry={() => void res.refetch()} />;
  else {
    const d = res.data;
    const movies = d.movies ?? [];
    const series = d.series ?? [];
    const none = !d.tracks.length && !d.albums.length && !d.artists.length && !d.audiobooks.length && !movies.length && !series.length;
    body = none ? (
      <AudioNotice title={t('player.browse.search.noResults', { query: q })}>{t('player.browse.search.noResultsBody')}</AudioNotice>
    ) : (
      <>
        {movies.length ? (
          <AudioSection title={t('player.video.nav.movies')}>
            <ul className="rd-grid rd-grid--search" aria-label={t('player.video.nav.movies')}>
              {movies.map((m) => (
                <li key={m.id}>
                  <WideTile size="grid" title={m.title} sub={m.year ? String(m.year) : null} image={m.backdropUrl ?? m.posterUrl} href={watchPaths.movie(m.id)} />
                </li>
              ))}
            </ul>
          </AudioSection>
        ) : null}
        {series.length ? (
          <AudioSection title={t('player.video.nav.shows')}>
            <ul className="rd-grid rd-grid--search" aria-label={t('player.video.nav.shows')}>
              {series.map((sr) => (
                <li key={sr.id}>
                  <WideTile size="grid" title={sr.title} sub={sr.year ? String(sr.year) : null} image={sr.backdropUrl ?? sr.posterUrl} href={watchPaths.show(sr.id)} />
                </li>
              ))}
            </ul>
          </AudioSection>
        ) : null}
        {d.artists.length ? (
          <AudioSection title={t('player.browse.nav.artists')}>
            <ul className="rd-music-grid rd-music-grid--round" aria-label={t('player.browse.nav.artists')}>
              {d.artists.map((a) => (
                <li key={a.id}>
                  <ArtistTile artist={a} fill />
                </li>
              ))}
            </ul>
          </AudioSection>
        ) : null}
        {d.tracks.length ? (
          <AudioSection title={t('player.browse.search.tracks')}>
            <TrackList tracks={d.tracks} source={`search:${q}`.slice(0, 100)} label={t('player.browse.search.tracks')} showAlbum />
          </AudioSection>
        ) : null}
        {d.albums.length ? (
          <AudioSection title={t('player.browse.nav.albums')}>
            <ul className="rd-music-grid" aria-label={t('player.browse.nav.albums')}>
              {d.albums.map((a) => (
                <li key={a.id}>
                  <AlbumTile album={a} fill />
                </li>
              ))}
            </ul>
          </AudioSection>
        ) : null}
        {d.audiobooks.length ? (
          <AudioSection title={t('player.browse.books.title')}>
            <ul className="rd-music-grid" aria-label={t('player.browse.books.title')}>
              {d.audiobooks.map((b) => (
                <li key={b.id}>
                  <BookTile book={b} fill />
                </li>
              ))}
            </ul>
          </AudioSection>
        ) : null}
      </>
    );
  }

  return (
    <AudioPage className="rd-music-search">
      <h1 className="rd-visually-hidden">{t('player.browse.search.title')}</h1>
      <form role="search" className="rd-search__bar" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={inputId} className="rd-visually-hidden">
          {t('player.browse.search.label')}
        </label>
        <RdIcon name="search" className="rd-search__icon" />
        <input
          id={inputId}
          className="rd-search__input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          placeholder={t('player.browse.search.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 100))}
        />
        {text ? (
          <button type="button" className="rd-iconbtn rd-search__clear" aria-label={t('player.redesign.search.clear')} onClick={() => setText('')}>
            <RdIcon name="close" size={18} />
          </button>
        ) : null}
      </form>
      <div className="rd-music-search__results" aria-live="polite" aria-busy={Boolean(q) && res.isPending}>
        {body}
      </div>
    </AudioPage>
  );
}
