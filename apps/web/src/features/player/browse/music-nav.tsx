import { useRouterState } from '@tanstack/react-router';
import { useT } from '../../../i18n/index.js';
import { PlayerLink, playerPaths } from './kit.js';

const TABS = [
  { to: playerPaths.music, key: 'player.browse.nav.home', exact: true },
  { to: playerPaths.albums, key: 'player.browse.nav.albums', exact: false },
  { to: playerPaths.artists, key: 'player.browse.nav.artists', exact: false },
  { to: playerPaths.playlists, key: 'player.browse.nav.playlists', exact: false },
] as const;

/** Music sub-navigation (Home, Albums, Artists, Playlists). */
export function MusicNav() {
  const t = useT();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="pb-subnav" aria-label={t('player.browse.nav.label')}>
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
