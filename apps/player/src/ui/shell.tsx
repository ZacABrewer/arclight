import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Backdrop, Button, EmptyState, Icon, Mark, Pane, Skeleton, buttonClass, type IconName } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { usePlaybackCapabilities } from '@web/features/player/api';
import { BrowsePlayerContext, type BrowsePlayerActions } from '@web/features/player/browse/player-hooks';
import { PlayerProvider, usePlayer } from '@web/features/player/player-context';
import { MiniPlayer } from '@web/features/player/ui/mini-player';
import '@web/features/player/player.css';
import { useAccounts, useNet, useServices, useSession } from '../app/context';
import { signOut } from '../core/sign-in';
import { DEFAULT_SETTINGS, useActiveProfile, useProfileSettings } from '../households/api';
import { ProfileAvatar } from '@web/features/player/redesign/profile-avatar';
import { RedesignFrame } from '@web/features/player/redesign/shell';
import { rememberReduceMotion } from '../intro/launch';
import { useProfileTheme } from './profile-theme';
import { signedOutTarget } from '../app/router';
import { useBrowseDownloads } from './downloads';
import { TvFrame } from '../tv/tv-shell';
import { AddProfileRow } from './add-profile-row';

// Chrome of every signed-in screen. TV: the design's top header on the stage (tv-shell). Phone
// (§4.4): a top bar (back or the Mark, offline badge, Music and Audiobooks, the profile avatar
// with its sheet), the page, the mini-player and the bottom tabs. The player lives here so
// playback carries on between screens.

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
  const services = useServices();
  const browseDownloads = useBrowseDownloads();
  // Downloads are phone-only: a TV keeps nothing offline.
  const downloads = services.tv ? null : browseDownloads;
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
  const services = useServices();
  const settings = useProfileSettings();
  // The player follows the profile's theme (null: Cinema, §4.1, §9 Q7).
  useProfileTheme(settings.theme);
  // The intro on the next cold launch follows the profile's Reduce motion (§9 Q16), once the
  // settings are loaded (not from the defaults shown before).
  const loaded = settings !== DEFAULT_SETTINGS;
  useEffect(() => {
    if (loaded) rememberReduceMotion(settings.reduceMotion);
  }, [loaded, settings.reduceMotion]);
  if (services.tv) return <TvFrame bare={bare}>{children}</TvFrame>;
  return <PhoneFrame bare={bare}>{children}</PhoneFrame>;
}

/** The avatar's bottom sheet on phones (§4.4): switch profile, Settings, Manage profiles, Sign out. */
function AvatarSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const services = useServices();
  const navigate = useNavigate();
  const { accounts, active } = useAccounts();
  const { profile, profiles, canManage } = useActiveProfile();
  const go = (to: string) => {
    onClose();
    void navigate({ to });
  };
  return (
    <div className="app-sheet" role="dialog" aria-modal="true" aria-label={profile?.name ?? t('app.tv.switchProfile')} onClick={onClose}>
      <div className="app-sheet__panel" onClick={(e) => e.stopPropagation()}>
        {profiles.length > 1 ? (
          <button type="button" className="app-sheet__row" onClick={() => go('/player/profiles')}>
            <Icon name="user" size={20} />
            <span>{t('app.tv.switchProfile')}</span>
            <span className="app-sheet__value">{profile?.name}</span>
          </button>
        ) : null}
        <button type="button" className="app-sheet__row" onClick={() => go('/player/settings')}>
          <Icon name="settings" size={20} />
          <span>{t('app.tv.tab.settings')}</span>
        </button>
        {canManage ? (
          <button type="button" className="app-sheet__row" onClick={() => go('/player/profiles?manage=1')}>
            <Icon name="edit" size={20} />
            <span>{t('app.tv.settings.manageProfiles')}</span>
          </button>
        ) : null}
        <AddProfileRow go={go} />
        {active ? (
          <button
            type="button"
            className="app-sheet__row app-sheet__row--danger"
            onClick={async () => {
              onClose();
              await signOut(services.accounts, active.id);
              if (accounts.length > 1) await services.switchAccount(null);
            }}
          >
            <Icon name="logout" size={20} />
            <span>{t('app.settings.signOut')}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PhoneFrame({ children, bare }: { children: ReactNode; bare?: boolean | undefined }) {
  const t = useT();
  const net = useNet();
  const router = useRouter();
  const settings = useProfileSettings();
  const { profile } = useActiveProfile();
  const [sheet, setSheet] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // §4.4: Home, TV Shows, Movies, My List, Search; Music and Audiobooks sit in the top bar.
  const tabs: Tab[] = [
    { id: 'home', to: '/player', icon: 'home', label: t('app.tv.tab.home'), match: (p) => p === '/player' || p === '/player/' || p === '/player/watch' },
    { id: 'shows', to: '/player/watch/shows', icon: 'tv', label: t('app.tv.tab.shows'), match: (p) => p.startsWith('/player/watch/shows') },
    { id: 'movies', to: '/player/watch/movies', icon: 'film', label: t('app.tv.tab.movies'), match: (p) => p.startsWith('/player/watch/movies') },
    { id: 'my-list', to: '/player/watch/my-list', icon: 'star', label: t('app.tv.tab.myList'), match: (p) => p.startsWith('/player/watch/my-list') },
    { id: 'search', to: '/player/watch/search', icon: 'search', label: t('app.tv.tab.search'), match: (p) => p.startsWith('/player/watch/search') || p.startsWith('/player/search') },
  ];
  const isRoot = ['/player', '/player/', '/player/watch', '/player/watch/shows', '/player/watch/movies', '/player/watch/my-list', '/player/music', '/player/books', '/player/search', '/player/watch/search', '/player/settings'].includes(pathname);
  const onNowPlaying = pathname.startsWith('/player/now-playing');
  return (
    <div className="al-app pl-app app-shell">
      <Backdrop vx={0.5} horizon={0.7} />
      <header className="app-top">
        {isRoot || bare ? (
          <Link to="/player" className="app-top__brand app-touch" aria-label={t('app.tv.tab.home')}>
            <Mark size={24} />
          </Link>
        ) : (
          <Button variant="ghost" className="app-touch" icon={<Icon name="chevronLeft" size={24} />} aria-label={t('app.nav.back')} onClick={() => router.history.back()} />
        )}
        <div className="app-top__mid">
          {!net.online ? (
            <span className="app-badge" role="status">
              {t('app.offline')}
            </span>
          ) : null}
        </div>
        {settings.showMusic ? (
          <Link
            to="/player/music"
            className={buttonClass({ variant: 'ghost', iconOnly: true, className: 'app-touch' })}
            aria-label={t('app.tv.tab.music')}
            aria-current={pathname.startsWith('/player/music') ? 'page' : undefined}
          >
            <Icon name="library" size={20} />
          </Link>
        ) : null}
        {settings.showAudiobooks ? (
          <Link
            to="/player/books"
            className={buttonClass({ variant: 'ghost', iconOnly: true, className: 'app-touch' })}
            aria-label={t('app.tv.tab.books')}
            aria-current={pathname.startsWith('/player/books') ? 'page' : undefined}
          >
            <Icon name="file" size={20} />
          </Link>
        ) : null}
        <button type="button" className="app-top__avatar app-touch" aria-label={profile?.name ?? t('app.tv.switchProfile')} aria-haspopup="dialog" onClick={() => setSheet(true)}>
          {profile ? <ProfileAvatar color={profile.color} initial={profile.initial} size={32} /> : <Icon name="user" size={24} />}
        </button>
      </header>
      <main className="pl-main app-main" id="player-main">
        {/* The shared redesign pages (Home, browse, detail, My List, search, settings) need its layout and display classes. */}
        <RedesignFrame>{children}</RedesignFrame>
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
      {sheet ? <AvatarSheet onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
