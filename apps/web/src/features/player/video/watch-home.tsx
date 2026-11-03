import { useRouterState } from '@tanstack/react-router';
import { useT } from '../../../i18n/index.js';
import { Empty, GridSkeleton, LoadError, PageTitle, PlayerLink, Shelf, playerPaths } from '../browse/kit.js';
import { useVideoHome } from './api.js';
import { HomeCard } from './cards.js';
import { watchPaths } from './paths.js';
import './watch.css';

const TABS = [
  { to: watchPaths.home, key: 'player.video.nav.home', exact: true },
  { to: watchPaths.movies, key: 'player.video.nav.movies', exact: false },
  { to: watchPaths.shows, key: 'player.video.nav.shows', exact: false },
] as const;

/** Movies & TV sub-navigation (Home, Movies, Shows). */
export function WatchNav() {
  const t = useT();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="pb-subnav" aria-label={t('player.video.nav.label')}>
      {TABS.map((tab) => {
        const active = tab.exact ? path === tab.to || path === `${tab.to}/` : path.startsWith(tab.to);
        return (
          <PlayerLink key={tab.to} to={tab.to} className="pb-subnav__link" aria-current={active ? 'page' : undefined}>
            {t(tab.key)}
          </PlayerLink>
        );
      })}
    </nav>
  );
}

/** /player/watch: continue watching, next up, recently added. */
export function WatchHomePage() {
  const t = useT();
  const home = useVideoHome();

  let body;
  if (home.isPending) body = <GridSkeleton count={6} label={t('player.browse.loading')} />;
  else if (home.isError) body = <LoadError title={t('player.video.homeFailed')} error={home.error} onRetry={() => void home.refetch()} />;
  else {
    const d = home.data;
    const nothing = !d.continueWatching.length && !d.nextUp.length && !d.recentMovies.length && !d.recentEpisodes.length;
    body = nothing ? (
      <Empty title={t('player.video.emptyTitle')}>{t('player.video.emptyBody')}</Empty>
    ) : (
      <>
        {d.continueWatching.length ? (
          <Shelf title={t('player.video.continueWatching')}>
            {d.continueWatching.map((c) => (
              <HomeCard key={`${c.kind}:${c.id}`} card={c} />
            ))}
          </Shelf>
        ) : null}
        {d.nextUp.length ? (
          <Shelf title={t('player.video.nextUp')}>
            {d.nextUp.map((c) => (
              <HomeCard key={`${c.kind}:${c.id}`} card={c} />
            ))}
          </Shelf>
        ) : null}
        {d.recentMovies.length ? (
          <Shelf title={t('player.video.recentMovies')} action={<PlayerLink to={watchPaths.movies} className="al-link">{t('player.browse.seeAll')}</PlayerLink>}>
            {d.recentMovies.map((c) => (
              <HomeCard key={`${c.kind}:${c.id}`} card={c} shape="poster" />
            ))}
          </Shelf>
        ) : null}
        {d.recentEpisodes.length ? (
          <Shelf title={t('player.video.recentEpisodes')} action={<PlayerLink to={watchPaths.shows} className="al-link">{t('player.browse.seeAll')}</PlayerLink>}>
            {d.recentEpisodes.map((c) => (
              <HomeCard key={`${c.kind}:${c.id}`} card={c} />
            ))}
          </Shelf>
        ) : null}
        {d.genres.length ? (
          <section className="vw-genres" aria-labelledby="vw-genres-title">
            <h2 className="pb-shelf__title" id="vw-genres-title">
              {t('player.video.genres')}
            </h2>
            <ul className="vw-chips">
              {d.genres.map((g) => (
                <li key={g}>
                  <PlayerLink to={watchPaths.movies} className="vw-chip" onClick={() => handOffGenre(g)}>
                    {g}
                  </PlayerLink>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div className="pb-page">
      <PageTitle actions={<PlayerLink to={playerPaths.search} className="al-btn al-btn--secondary">{t('player.browse.search.open')}</PlayerLink>}>
        {t('player.video.title')}
      </PageTitle>
      <WatchNav />
      {body}
    </div>
  );
}

// Genre chips hand the genre to the Movies page through sessionStorage (a search param would
// not survive the app's hash router the same way).
export const GENRE_HANDOFF_KEY = 'arclight.player.watch.genre';

function handOffGenre(genre: string) {
  try {
    sessionStorage.setItem(GENRE_HANDOFF_KEY, genre);
  } catch {
    // Blocked storage: the Movies page opens unfiltered.
  }
}

/** The genre a home chip handed over (read once). */
export function takeHandedGenre(): string {
  try {
    const g = sessionStorage.getItem(GENRE_HANDOFF_KEY) ?? '';
    sessionStorage.removeItem(GENRE_HANDOFF_KEY);
    return g;
  } catch {
    return '';
  }
}
