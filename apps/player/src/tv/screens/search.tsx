import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerSearchResponse, VideoCard } from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { usePlayerSearch } from '@web/features/player/browse/api';
import { useVideoHome } from '@web/features/player/video/api';
import { useProfileSettings } from '../../households/api';
import { cardArt, useAudioActions, useVideoActions } from '../actions';
import { typeInto, type Translate } from '../format';
import { WideTile } from '../tiles';

// Search (template "search"): the input and the 6-column on-screen keyboard on the left; on the
// right "Popular right now" (Home's Trending), or the mixed results for the query (movies, shows,
// and, when those sections are on, albums and audiobooks; §9 Q25), at most 12.

export const SEARCH_MAX = 12;
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'];

export interface SearchTile {
  id: string;
  title: string;
  sub: string;
  art: string | null;
  open: () => void;
}

type Openers = {
  movie: (id: number) => void;
  series: (id: number) => void;
  album: (id: number) => void;
  book: (b: { id: number; itemKey: string }) => void;
};

/** Mixed results in the template's order: video first, then albums, then audiobooks. */
export function searchTiles(r: PlayerSearchResponse, opts: { music: boolean; books: boolean }, open: Openers, t: Translate): SearchTile[] {
  const out: SearchTile[] = [];
  const year = (y: number | null) => (y ? ` · ${y}` : '');
  for (const s of r.series) out.push({ id: `sr-series:${s.id}`, title: s.title, sub: `${t('app.tv.series')}${year(s.year)}`, art: s.backdropUrl ?? s.posterUrl, open: () => open.series(s.id) });
  for (const m of r.movies) out.push({ id: `sr-movie:${m.id}`, title: m.title, sub: `${t('app.tv.movie')}${year(m.year)}`, art: m.backdropUrl ?? m.posterUrl, open: () => open.movie(m.id) });
  if (opts.music) for (const a of r.albums) out.push({ id: `sr-album:${a.id}`, title: a.title, sub: `${t('app.tv.album')} · ${a.artistName}`, art: a.artworkUrl, open: () => open.album(a.id) });
  if (opts.books)
    for (const b of r.audiobooks) out.push({ id: `sr-book:${b.id}`, title: b.title, sub: [t('app.tv.audiobook'), b.authors[0]].filter(Boolean).join(' · '), art: b.artworkUrl, open: () => open.book(b) });
  return out.slice(0, SEARCH_MAX);
}

export function TvSearchScreen() {
  const t = useT();
  const settings = useProfileSettings();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(id);
  }, [query]);
  const results = usePlayerSearch(debounced);
  const home = useVideoHome();
  const { openTitle, openCard } = useVideoActions();
  const { startAlbum, startBook } = useAudioActions();

  // A real keyboard (or the remote's number keys) types too.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 && /[\p{L}\p{N} ]/u.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        setQuery((q) => typeInto(q, e.key));
      } else if (e.key === 'Backspace' && queryRef.current) {
        // With an empty query Backspace is Back.
        e.preventDefault();
        e.stopPropagation();
        setQuery((q) => q.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const tiles = useMemo<SearchTile[]>(() => {
    if (!debounced) {
      return (home.data?.trending ?? []).slice(0, SEARCH_MAX).map((c: VideoCard) => ({
        id: `sr-${c.kind}:${c.id}`,
        title: c.title,
        sub: [t(c.kind === 'movie' ? 'app.tv.movie' : 'app.tv.series'), c.year].filter(Boolean).join(' · '),
        art: cardArt(c),
        open: () => openCard(c),
      }));
    }
    if (!results.data) return [];
    return searchTiles(
      results.data,
      { music: settings.showMusic, books: settings.showAudiobooks },
      { movie: (id) => openTitle('movie', id), series: (id) => openTitle('series', id), album: (id) => void startAlbum(id), book: startBook },
      t,
    );
  }, [debounced, results.data, home.data, settings.showMusic, settings.showAudiobooks, openTitle, openCard, startAlbum, startBook, t]);

  const heading = !debounced ? t('app.tv.popular') : results.isSuccess && !tiles.length ? t('app.tv.noMatches', { q: debounced }) : t('app.tv.resultsFor', { q: debounced });

  return (
    <div className="tv-search">
      <div className="tv-search__left">
        <div className="tv-input" aria-label={t('app.tv.searchPlaceholder')} role="textbox" aria-readonly="true">
          {query ? (
            <>
              <span className="tv-input__text">{query}</span>
              <span className="tv-input__caret" aria-hidden="true" />
            </>
          ) : (
            <>
              <span className="tv-input__caret" aria-hidden="true" />
              <span className="tv-input__placeholder">{t('app.tv.searchPlaceholder')}</span>
            </>
          )}
        </div>
        <div className="tv-keys">
          {KEYS.map((k) => (
            <button key={k} type="button" className="tv-key" data-tv-key={`key-${k}`} data-tv-autofocus={k === 'A' ? '' : undefined} onClick={() => setQuery((q) => typeInto(q, k))}>
              {k}
            </button>
          ))}
          <button type="button" className="tv-key tv-key--wide" data-tv-key="key-space" onClick={() => setQuery((q) => typeInto(q, ' '))}>
            {t('app.tv.key.space')}
          </button>
          <button type="button" className="tv-key tv-key--wide" data-tv-key="key-del" onClick={() => setQuery((q) => q.slice(0, -1))}>
            {t('app.tv.key.delete')}
          </button>
          <button type="button" className="tv-key tv-key--wide" data-tv-key="key-clear" onClick={() => setQuery('')}>
            {t('app.tv.key.clear')}
          </button>
        </div>
      </div>
      <div className="tv-search__right">
        <h2 className="tv-search__heading">{heading}</h2>
        <div className="tv-search__scroll" data-tv-scroll="y" data-tv-mtop="6">
          <div className="tv-search__grid">
            {tiles.map((x) => (
              <WideTile key={x.id} id={x.id} title={x.title} sub={x.sub} art={x.art} onOpen={x.open} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
