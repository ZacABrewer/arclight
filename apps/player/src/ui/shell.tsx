import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Backdrop, Button, EmptyState, Icon, Mark, Pane, Skeleton, buttonClass, type IconName } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { usePlaybackCapabilities } from '@web/features/player/api';
import { BrowsePlayerContext, type BrowsePlayerActions } from '@web/features/player/browse/player-hooks';
import { PlayerProvider, usePlayer } from '@web/features/player/player-context';
import { MiniPlayer } from '@web/features/player/ui/mini-player';
import '@web/features/player/player.css';
import { useNet, useServices, useSession } from '../app/context';
import { signedOutTarget } from '../app/router';
import { useBrowseDownloads } from './downloads';

// Chrome of every signed-in screen: a slim top bar (back, mark, offline badge, settings), the
// page, the mini-player and the bottom tabs. The player lives here so playback carries on
// between screens.

interface Tab {
  id: string;
  to: string;
  icon: IconName;
  label: string;
  match: (path: string) => boolean;
}

/** Gives the web browse pages the actions they use from the shared player. */
function BrowsePlayerBridge({ children }: { children: ReactNode }) {
  const { state, playItems, playItem, playNext, addToQueue, toggle } = usePlayer();
  const downloads = useBrowseDownloads();
  const currentItemKey = state.current?.itemKey ?? null;
  const value = useMemo<BrowsePlayerActions>(
    () => ({ currentItemKey, playing: state.playing, playItems, playItem: (key) => playItem(key), playNext, addToQueue, toggle, ...downloads }),
    [currentItemKey, state.playing, playItems, playItem, playNext, addToQueue, toggle, downloads],
  );
  return <BrowsePlayerContext.Provider value={value}>{children}</BrowsePlayerContext.Provider>;
}

export function Shell() {
  const services = useServices();
  const session = useSession();
  const net = useNet();
  const navigate = useNavigate();
  const caps = usePlaybackCapabilities(Boolean(session) && net.online);
  const [gen, setGen] = useState(0);

  useEffect(() => services.subscribePlayer(() => setGen((g) => g + 1)), [services]);

  // Signed out underneath us (token refused, account removed): leave the player.
  useEffect(() => {
    if (!session) void navigate({ ...signedOutTarget(services), replace: true });
  }, [session, services, navigate]);

  useEffect(() => {
    if (caps.data) services.setCaps(caps.data);
  }, [caps.data, services]);

  if (!session) return null;
  if (caps.data && (!caps.data.enabled || !caps.data.allowed)) {
    return (
      <Frame bare>
        <PlayerOffNotice onRetry={() => void caps.refetch()} />
      </Frame>
    );
  }
  if (caps.isPending && net.online) {
    return (
      <Frame bare>
        <Skeleton lines={6} />
      </Frame>
    );
  }
  const controller = services.player().controller;
  return (
    <PlayerProvider key={`${session.accountId}:${gen}`} controller={controller} capabilities={caps.data} restoreQueue={net.online}>
      <BrowsePlayerBridge>
        <Frame>
          <Outlet />
        </Frame>
      </BrowsePlayerBridge>
    </PlayerProvider>
  );
}

function PlayerOffNotice({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <Pane chamfer="both" strong className="app-card">
      <EmptyState
        title={t('app.player.off')}
        action={
          <div className="app-row">
            <Button variant="secondary" onClick={onRetry}>
              {t('app.player.retry')}
            </Button>
            <Link to="/player/settings" className={buttonClass({ variant: 'ghost' })}>
              {t('app.nav.settings')}
            </Link>
          </div>
        }
      >
        {t('app.player.offHelp')}
      </EmptyState>
    </Pane>
  );
}

function Frame({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const t = useT();
  const net = useNet();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs: Tab[] = [
    { id: 'home', to: '/player', icon: 'home', label: t('app.nav.home'), match: (p) => p === '/player' || p === '/player/' },
    { id: 'music', to: '/player/music', icon: 'library', label: t('app.nav.music'), match: (p) => p.startsWith('/player/music') },
    { id: 'books', to: '/player/books', icon: 'file', label: t('app.nav.books'), match: (p) => p.startsWith('/player/books') },
    { id: 'search', to: '/player/search', icon: 'search', label: t('app.nav.search'), match: (p) => p.startsWith('/player/search') },
    { id: 'downloads', to: '/player/downloads', icon: 'download', label: t('app.nav.downloads'), match: (p) => p.startsWith('/player/downloads') },
  ];
  const isRoot = ['/player', '/player/', '/player/music', '/player/books', '/player/search', '/player/downloads'].includes(pathname);
  const onNowPlaying = pathname.startsWith('/player/now-playing');
  return (
    <div className="al-app pl-app app-shell">
      <Backdrop vx={0.5} horizon={0.7} />
      <header className="app-top">
        {isRoot || bare ? (
          <Link to="/player" className="app-top__brand app-touch" aria-label={t('app.nav.home')}>
            <Mark size={26} />
          </Link>
        ) : (
          <Button variant="ghost" className="app-touch" icon={<Icon name="chevronLeft" size={24} />} aria-label={t('app.nav.back')} onClick={() => router.history.back()} />
        )}
        <div className="app-top__mid">
          {!net.online ? (
            <span className="app-badge" role="status" title={t('app.offlineHelp')}>
              {t('app.offline')}
            </span>
          ) : null}
        </div>
        <Link
          to="/player/settings"
          className={buttonClass({ variant: 'ghost', iconOnly: true, className: 'app-touch' })}
          aria-label={t('app.nav.settings')}
          aria-current={pathname.startsWith('/player/settings') ? 'page' : undefined}
        >
          <Icon name="settings" size={24} />
        </Link>
      </header>
      <main className="pl-main app-main" id="player-main">
        {children}
      </main>
      {!bare ? (
        <div className="app-dock">
          {!onNowPlaying ? <MiniPlayer /> : null}
          <nav className="app-tabs" aria-label={t('app.nav.label')}>
            {tabs.map((tab) => {
              const active = tab.match(pathname);
              return (
                // exact: TanStack marks a Link active (and sets aria-current) for child routes too, which
                // would light Home on every tab.
                <Link key={tab.id} to={tab.to} activeOptions={{ exact: true }} className="app-tabs__link" aria-current={active ? 'page' : undefined}>
                  <Icon name={tab.icon} size={24} />
                  <span>{tab.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
