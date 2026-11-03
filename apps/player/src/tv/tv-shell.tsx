import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useT } from '@web/i18n/index';
import { usePlayer } from '@web/features/player/player-context';
import { useActiveProfile, useProfileSettings } from '../households/api';
import { Lockup } from '../kit/lockup';
import { ProfileAvatar } from '../kit/profile-avatar';
import { artBackground } from '../kit/placeholder';
import { TvStage } from './stage';
import { HOME_PATH, PROFILES_PATH } from './tv-runtime';
import './tv.css';

// The 10-foot frame (spec §4.3): the design's 72 px top header over a 100 px fade, and the page
// under it on the 1280×720 stage. Left: the lockup and the tabs Home, TV Shows, Movies, My List,
// Search. Right: the now-playing pill (while audio plays), Music and Audiobooks (each per the
// profile's toggles), a divider, Settings and the profile avatar, which opens the picker.

interface TabDef {
  id: string;
  to: string;
  label: string;
}

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export function activeTab(pathname: string): string | null {
  const p = norm(pathname);
  if (p === HOME_PATH || p === '/player/watch') return 'home';
  const map: Record<string, string> = {
    '/player/watch/shows': 'shows',
    '/player/watch/movies': 'movies',
    '/player/watch/my-list': 'my-list',
    '/player/search': 'search',
    '/player/music': 'music',
    '/player/books': 'books',
    '/player/settings': 'settings',
  };
  return map[p] ?? null;
}

function HeaderTab({ tab, active, className }: { tab: TabDef; active: boolean; className?: string }) {
  return (
    <Link to={tab.to} className={`tv-tab${className ? ` ${className}` : ''}`} data-tv-key={`tab-${tab.id}`} data-tv-r="8" aria-current={active ? 'page' : undefined}>
      {tab.label}
      {active ? <span className="tv-tab__dot" aria-hidden="true" /> : null}
    </Link>
  );
}

function NowPlayingPill() {
  const { state } = usePlayer();
  const cur = state.current;
  if (!cur || (cur.kind !== 'track' && cur.kind !== 'audiobook')) return null;
  const chapter = cur.kind === 'audiobook' && state.chapterIndex >= 0 ? cur.chapters[state.chapterIndex]?.title : null;
  // Template: "track · artist" for music, "chapter · book" for audiobooks.
  const label = cur.kind === 'audiobook' ? `${chapter ?? cur.title} · ${cur.title}` : `${cur.title} · ${cur.subtitle ?? cur.context ?? ''}`.replace(/ · $/, '');
  return (
    <Link to="/player/now-playing" className="tv-np" data-tv-key="np-pill" data-tv-r="17">
      <span className="tv-np__art" style={{ background: artBackground(cur.artworkUrl, cur.title) }} aria-hidden="true" />
      <span className="tv-np__label">{label}</span>
    </Link>
  );
}

export function TvHeader() {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const settings = useProfileSettings();
  const { profile } = useActiveProfile();
  const active = activeTab(pathname);
  const onListen = norm(pathname) === '/player/now-playing';
  const tabs: TabDef[] = [
    { id: 'home', to: HOME_PATH, label: t('app.tv.tab.home') },
    { id: 'shows', to: '/player/watch/shows', label: t('app.tv.tab.shows') },
    { id: 'movies', to: '/player/watch/movies', label: t('app.tv.tab.movies') },
    { id: 'my-list', to: '/player/watch/my-list', label: t('app.tv.tab.myList') },
    { id: 'search', to: '/player/search', label: t('app.tv.tab.search') },
  ];
  const side: TabDef[] = [
    ...(settings.showMusic ? [{ id: 'music', to: '/player/music', label: t('app.tv.tab.music') }] : []),
    ...(settings.showAudiobooks ? [{ id: 'books', to: '/player/books', label: t('app.tv.tab.books') }] : []),
  ];
  return (
    <>
      <div className="tv-hfade" aria-hidden="true" />
      <header className="tv-header" data-tv-row="" data-tv-fixed="">
        <Lockup height={22} />
        <nav className="tv-tabs" aria-label={t('app.nav.label')}>
          {tabs.map((tab) => (
            <HeaderTab key={tab.id} tab={tab} active={active === tab.id} />
          ))}
        </nav>
        <div className="tv-hright">
          {!onListen ? <NowPlayingPill /> : null}
          {side.map((tab) => (
            <HeaderTab key={tab.id} tab={tab} active={active === tab.id} className="tv-tab--side" />
          ))}
          <span className="tv-hdiv" aria-hidden="true" />
          <HeaderTab tab={{ id: 'settings', to: '/player/settings', label: t('app.tv.tab.settings') }} active={active === 'settings'} className="tv-tab--settings" />
          {profile ? (
            <Link to={PROFILES_PATH} className="tv-avatar-btn" data-tv-key="tab-profile" data-tv-r="17" aria-label={t('app.tv.switchProfile')}>
              <ProfileAvatar color={profile.color} initial={profile.initial} size={34} style={{ fontSize: 15 }} />
            </Link>
          ) : null}
        </div>
      </header>
    </>
  );
}

export function TvFrame({ children, bare }: { children: ReactNode; bare?: boolean | undefined }) {
  const settings = useProfileSettings();
  return (
    <TvStage focusStyle={settings.focusStyle} reduceMotion={settings.reduceMotion} className={settings.reduceMotion ? 'tv-motion-off' : undefined}>
      {!bare ? <TvHeader /> : null}
      <main className="tv-page" id="player-main" data-tv-group="main">
        {children}
      </main>
    </TvStage>
  );
}
