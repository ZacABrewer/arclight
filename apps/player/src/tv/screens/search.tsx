import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerSearchResponse, VideoCard } from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { usePlayerSearch } from '@web/features/player/browse/api';
import { useVideoHome } from '@web/features/player/video/api';
import { useProfileSettings } from '../../households/api';
import { useAccounts } from '../../app/context';
import { cardArt, useAudioActions, useVideoActions } from '../actions';
import { Qr } from '../device-code-panel';
import { typeInto, type Translate } from '../format';
import { TvPanel } from '../profile-parts';
import { WideTile } from '../tiles';

// Search (template "search"): the input and the 6-column on-screen keyboard on the left; on the
// right "Popular right now" (Home's Trending), or the mixed results for the query (movies, shows,
// and, when those sections are on, albums and audiobooks; §9 Q25), at most 12. No matches (S15)
// is never a blank pane: request it from the web app (a QR code), search music and audiobooks
// too when they are hidden, and "Did you mean" from the titles Home knows.

export const SEARCH_MAX = 12;
const NEAR_MAX = 3;
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

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}
/** Dice similarity of two strings' letter pairs (0–1). */
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let both = 0;
  for (const [k, n] of x) both += Math.min(n, y.get(k) ?? 0);
  return (2 * both) / (a.length - 1 + (b.length - 1));
}

/** "Did you mean": the closest titles to the query (against the whole title or any of its words). */
export function nearMisses(q: string, cards: readonly VideoCard[], max = NEAR_MAX): VideoCard[] {
  const nq = norm(q);
  if (nq.length < 3) return [];
  const seen = new Set<string>();
  const scored: { c: VideoCard; score: number }[] = [];
  for (const c of cards) {
    if (c.kind === 'episode') continue;
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const words = [c.title, ...c.title.split(/\s+/)].map(norm).filter((w) => w.length >= 2);
    const score = Math.max(0, ...words.map((w) => dice(nq, w)));
    if (score >= 0.4) scored.push({ c, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.c);
}

/** Where "Request it from the web app" sends you: Discover's search (the portal's, for non-admins). */
export function requestUrl(serverUrl: string, q: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/discover/search?q=${encodeURIComponent(q)}`;
}

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
  const { active } = useAccounts();
  const [everything, setEverything] = useState(false);
  const [qr, setQr] = useState(false);
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
      { music: everything || settings.showMusic, books: everything || settings.showAudiobooks },
      { movie: (id) => openTitle('movie', id), series: (id) => openTitle('series', id), album: (id) => void startAlbum(id), book: startBook },
      t,
    );
  }, [debounced, results.data, home.data, settings.showMusic, settings.showAudiobooks, everything, openTitle, openCard, startAlbum, startBook, t]);

  const none = !!debounced && results.isSuccess && !tiles.length;
  const heading = !debounced ? t('app.tv.popular') : none ? t('app.tv.noMatches', { q: debounced }) : t('app.tv.resultsFor', { q: debounced });
  const near = useMemo(() => {
    if (!none || !home.data) return [];
    const cards = Object.values(home.data)
      .filter(Array.isArray)
      .flat()
      .filter((c): c is VideoCard => !!c && typeof c === 'object' && 'kind' in c && 'title' in c);
    return nearMisses(debounced, cards);
  }, [none, debounced, home.data]);
  const hidden = !everything && (!settings.showMusic || !settings.showAudiobooks);

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
        <p className="tv-search__hint">{t('app.tv.searchHint')}</p>
      </div>
      <div className="tv-search__right">
        <h2 className="tv-search__heading">{heading}</h2>
        {none ? (
          <div className="tv-search__none">
            <div className="tv-more-menu__list">
              {active ? (
                <button type="button" className="tv-opt" data-tv-key="sr-request" onClick={() => setQr(true)}>
                  <span className="tv-opt__text">
                    <span className="tv-opt__label">{t('app.tv.requestFromWeb', { q: debounced })}</span>
                    <span className="tv-opt__desc">{t('app.tv.requestFromWebText')}</span>
                  </span>
                  <span className="tv-chev" aria-hidden="true">
                    ›
                  </span>
                </button>
              ) : null}
              {hidden ? (
                <button type="button" className="tv-opt" data-tv-key="sr-everything" onClick={() => setEverything(true)}>
                  <span className="tv-opt__text">
                    <span className="tv-opt__label">{t('app.tv.searchEverything')}</span>
                  </span>
                  <span className="tv-chev" aria-hidden="true">
                    ›
                  </span>
                </button>
              ) : null}
            </div>
            {near.length ? (
              <>
                <p className="tv-search__near">{t('app.tv.didYouMean')}</p>
                <div className="tv-search__nearrow" data-tv-row="">
                  {near.map((c) => (
                    <WideTile
                      key={`${c.kind}:${c.id}`}
                      id={`near-${c.kind}:${c.id}`}
                      title={c.title}
                      sub={[t(c.kind === 'movie' ? 'app.tv.movie' : 'app.tv.series'), c.year].filter(Boolean).join(' · ')}
                      art={cardArt(c)}
                      onOpen={() => openCard(c)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="tv-search__scroll" data-tv-scroll="y" data-tv-mtop="6">
            <div className="tv-search__grid">
              {tiles.map((x) => (
                <WideTile key={x.id} id={x.id} title={x.title} sub={x.sub} art={x.art} onOpen={x.open} />
              ))}
            </div>
          </div>
        )}
      </div>
      {qr && active ? (
        <TvPanel label={t('app.tv.requestFromWeb', { q: debounced })} onClose={() => setQr(false)}>
          <div className="tv-request">
            <Qr value={requestUrl(active.serverUrl, debounced)} label={t('app.tv.requestQr')} />
            <div className="tv-request__body">
              <h2 className="tv-profiles__title">{t('app.tv.requestFromWeb', { q: debounced })}</h2>
              <p className="tv-noresults__text">{t('app.tv.requestQrText')}</p>
              <div className="tv-btns">
                <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="qr-close" data-tv-autofocus="" onClick={() => setQr(false)}>
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        </TvPanel>
      ) : null}
    </div>
  );
}
