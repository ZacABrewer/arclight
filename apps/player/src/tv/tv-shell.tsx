import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Backdrop, Icon, Mark, type IconName } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { usePlayer } from '@web/features/player/player-context';
import { MiniPlayer } from '@web/features/player/ui/mini-player';
import { useNet } from '../app/context';
import './tv.css';

// The 10-foot frame: a rail on the left (Home, Movies, Shows, Search, Music, Settings), the page
// beside it, and an ambient backdrop of whatever poster or still has focus. No downloads, no car
// screens, no hover-only controls; everything is reached with the remote's arrows and OK.

interface RailItem {
  id: string;
  to: string;
  icon: IconName;
  label: string;
  match: (path: string) => boolean;
}

/** The art of the focused card (data-tv-backdrop, or the card's own image), for the ambient layer. */
function useAmbientArt(): string | null {
  const [art, setArt] = useState<string | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || el.closest('[data-tv-group="rail"]')) return;
      const explicit = el.closest<HTMLElement>('[data-tv-backdrop]')?.dataset.tvBackdrop;
      const card = el.closest('.vw-card, .pb-card, li');
      const img = card?.querySelector('img')?.getAttribute('src');
      const next = explicit ?? img ?? null;
      if (next) setArt(next);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  return art;
}

export function TvFrame({ children, bare }: { children: ReactNode; bare?: boolean | undefined }) {
  const t = useT();
  const net = useNet();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const art = useAmbientArt();
  const onHome = pathname === '/player' || pathname === '/player/';
  const items: RailItem[] = [
    { id: 'home', to: '/player', icon: 'home', label: t('app.nav.home'), match: (p) => p === '/player' || p === '/player/' || p === '/player/watch' },
    { id: 'movies', to: '/player/watch/movies', icon: 'film', label: t('app.tv.movies'), match: (p) => p.startsWith('/player/watch/movies') },
    { id: 'shows', to: '/player/watch/shows', icon: 'tv', label: t('app.tv.shows'), match: (p) => p.startsWith('/player/watch/shows') },
    { id: 'search', to: '/player/search', icon: 'search', label: t('app.nav.search'), match: (p) => p.startsWith('/player/search') },
    { id: 'music', to: '/player/music', icon: 'library', label: t('app.nav.music'), match: (p) => p.startsWith('/player/music') || p.startsWith('/player/books') },
    { id: 'settings', to: '/player/settings', icon: 'settings', label: t('app.nav.settings'), match: (p) => p.startsWith('/player/settings') },
  ];
  return (
    <div className="al-app pl-app tv-shell">
      <Backdrop vx={0.5} horizon={0.7} />
      {/* The home page draws its own hero; elsewhere the focused art tints the background. */}
      {art && !onHome ? <div className="tv-ambient" style={{ backgroundImage: `url("${art.replace(/"/g, '%22')}")` }} aria-hidden="true" /> : null}
      {!bare ? (
        <nav className="tv-rail" data-tv-group="rail" aria-label={t('app.nav.label')}>
          <span className="tv-rail__brand" aria-hidden="true">
            <Mark size={34} />
          </span>
          {items.map((item) => {
            const active = item.match(pathname);
            return (
              <Link key={item.id} to={item.to} activeOptions={{ exact: true }} className="tv-rail__link" aria-current={active ? 'page' : undefined} data-tv-key={`rail-${item.id}`}>
                <Icon name={item.icon} size={24} />
                <span className="tv-rail__label">{item.label}</span>
              </Link>
            );
          })}
          {!net.online ? (
            <span className="tv-rail__offline" role="status">
              {t('app.offline')}
            </span>
          ) : null}
        </nav>
      ) : null}
      <main className="pl-main tv-main" id="player-main" data-tv-group="main">
        {children}
      </main>
      {!bare ? <TvMini /> : null}
    </div>
  );
}

/** Music still plays on a TV: a small now-playing bar, only while something is loaded. */
function TvMini() {
  const { state } = usePlayer();
  if (!state.current) return null;
  return (
    <div className="tv-mini" data-tv-group="mini">
      <MiniPlayer />
    </div>
  );
}

