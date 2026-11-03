import { useEffect, useId, useState } from 'react';
import { useT } from '../../../../i18n/index.js';
import { usePlayerSearch } from '../../browse/api.js';
import { useDebounced } from '../../browse/kit.js';
import { useVideoHome } from '../../video/api.js';
import { watchPaths } from '../../video/paths.js';
import { RdIcon } from '../icons.js';
import { useSections } from '../shell.js';
import { WideTile } from '../tiles.js';
import { onePerSeries, RdLoading, RdPage, useCardActions, useListen } from './common.js';

// Search (the template's Search screen, spec §4.4 / §4.5): the input on top with the system
// keyboard, then "Popular right now" or the results: movies and shows, plus albums and
// audiobooks when those sections are on (§9 Q25), at most 12, as 16:9 tiles.

const MAX_RESULTS = 12;

interface Result {
  key: string;
  title: string;
  sub: string;
  image: string | null;
  href?: string | undefined;
  onOpen?: (() => void) | undefined;
}

export function RdSearchPage() {
  const t = useT();
  const inputId = useId();
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const search = usePlayerSearch(query);
  const home = useVideoHome();
  const sections = useSections();
  const act = useCardActions();
  const listen = useListen();

  useEffect(() => {
    document.title = `${t('player.redesign.nav.search')} · ${t('player.documentTitle')}`;
  }, [t]);

  const kindYear = (kind: 'movie' | 'series', year: number | null) => {
    if (year === null) return kind === 'series' ? t('player.redesign.detail.series') : t('player.redesign.detail.movie');
    return t(kind === 'series' ? 'player.redesign.search.seriesSub' : 'player.redesign.search.movieSub', { year });
  };

  let results: Result[] = [];
  if (query && search.data) {
    const d = search.data;
    results = [
      ...d.series.map((s) => ({ key: `series:${s.id}`, title: s.title, sub: kindYear('series', s.year), image: s.backdropUrl ?? s.posterUrl, href: watchPaths.show(s.id) })),
      ...d.movies.map((m) => ({ key: `movie:${m.id}`, title: m.title, sub: kindYear('movie', m.year), image: m.backdropUrl ?? m.posterUrl, href: watchPaths.movie(m.id) })),
      ...(sections.music
        ? d.albums.map((a) => ({ key: `album:${a.id}`, title: a.title, sub: t('player.redesign.search.albumSub', { artist: a.artistName }), image: a.artworkUrl, onOpen: () => void listen.album(a.id) }))
        : []),
      ...(sections.books
        ? d.audiobooks.map((b) => ({ key: `book:${b.id}`, title: b.title, sub: t('player.redesign.search.audiobookSub', { author: b.authors.join(', ') }), image: b.artworkUrl, onOpen: () => listen.item(b.itemKey) }))
        : []),
    ].slice(0, MAX_RESULTS);
  } else if (!query && home.data) {
    const popular = home.data.trending?.length ? home.data.trending : onePerSeries([...home.data.recentMovies, ...home.data.recentEpisodes]);
    results = popular.slice(0, 6).map((c) => ({
      key: `${c.kind}:${c.id}`,
      title: c.title,
      sub: kindYear(c.kind === 'movie' ? 'movie' : 'series', c.year),
      image: c.backdropUrl ?? c.posterUrl,
      href: act.href(c),
    }));
  }

  const heading = !query
    ? t('player.redesign.search.popular')
    : search.isPending
      ? null
      : results.length
        ? t('player.redesign.search.results', { query })
        : t('player.redesign.search.noMatches', { query });

  return (
    <RdPage className="rd-search">
      <div className="rd-search__bar">
        <label htmlFor={inputId} className="rd-visually-hidden">
          {t('player.redesign.nav.search')}
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
          placeholder={t('player.redesign.search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, 100))}
        />
        {q ? (
          <button type="button" className="rd-iconbtn rd-search__clear" aria-label={t('player.redesign.search.clear')} onClick={() => setQ('')}>
            <RdIcon name="close" size={18} />
          </button>
        ) : null}
      </div>
      <section className="rd-search__results" aria-live="polite" aria-busy={Boolean(query) && search.isPending}>
        {heading ? <h1 className="rd-search__heading">{heading}</h1> : null}
        {query && search.isPending ? <RdLoading /> : null}
        {results.length ? (
          <ul className="rd-grid rd-grid--search">
            {results.map((r) => (
              <li key={r.key}>
                <WideTile size="grid" title={r.title} sub={r.sub} image={r.image} seed={r.title} href={r.href} onOpen={r.onOpen} label={`${r.title}, ${r.sub}`} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </RdPage>
  );
}
