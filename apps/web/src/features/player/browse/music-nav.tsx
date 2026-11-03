import { useRouterState } from '@tanstack/react-router';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { PlayerLink, playerPaths } from './kit.js';

const TABS = [
  { to: playerPaths.albums, key: 'player.browse.nav.albums' },
  { to: playerPaths.artists, key: 'player.browse.nav.artists' },
  { to: playerPaths.playlists, key: 'player.browse.nav.playlists' },
] as const;

/**
 * Music sections as the redesign chip row (the chips of the Movies and Shows pages): Albums,
 * Artists, Playlists. Music itself is the header's tab, so there is no Home chip.
 */
export function MusicNav() {
  const t = useT();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="rd-chips rd-music-chips" aria-label={t('player.browse.nav.label')}>
      {TABS.map((tab) => {
        const active = path === tab.to || path === `${tab.to}/`;
        return (
          <PlayerLink key={tab.to} to={tab.to} className={cx('rd-chip', active && 'is-on')} aria-current={active ? 'page' : undefined}>
            {t(tab.key)}
          </PlayerLink>
        );
      })}
    </nav>
  );
}
