import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { HouseholdProfile } from '@arclight/shared';
import { Mark } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { Lockup } from '../../../arclight/lockup.js';
import { useAuth } from '../../../auth/auth-context.js';
import { appHomeFor, canRequest } from '../../../auth/access.js';
import { readPortalDocument } from '../../discover/portal-location.js';
import { portalHref } from '../../discover/portal-href.js';
import { appHref } from '../app-href.js';
import { readPlayerDocument } from '../player-location.js';
import { readUiPreferences } from '../../../lib/ui-preferences.js';
import { useT } from '../../../i18n/index.js';
import { usePlaybackCapabilities } from '../api.js';
import { usePlayer } from '../player-context.js';
import { PlayerLink } from '../browse/kit.js';
import { AppSignInDialog } from '../ui/app-sign-in.js';
import { useHouseholdProfiles, useIsOwnerProfile, useProfileSettings, useSelectProfile } from './api.js';
import { RdIcon, type RdIconName } from './icons.js';
import { useLayout, tileScale, type PlayerLayout } from './layout.js';
import { usePlayerTheme } from './player-theme.js';
import { ProfileAvatar } from './profile-avatar.js';
import { markProfilePicked } from './profile-session.js';
import { redesignPaths } from './paths.js';
import { BottomSheet } from './sheet.js';
import { Art } from './tiles.js';
import './redesign.css';

// The redesign's chrome (redesign spec §4.4-§4.6): the wide header (logo, tabs as links, the
// now-playing pill, Music and Audiobooks, Settings, the avatar) or, in portrait, the top bar,
// the bottom tab bar and the mini player. The theme follows the profile (cinema by default),
// and the profile's Reduce motion and Focus highlight settings apply to everything inside.

interface Tab {
  id: string;
  to: string;
  label: string;
  icon: RdIconName;
  match: (path: string) => boolean;
}

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

export function useTabs() {
  const t = useT();
  const main: Tab[] = [
    { id: 'home', to: redesignPaths.home, label: t('player.redesign.nav.home'), icon: 'home', match: (p) => p === '/player' || p === '/player/watch' },
    { id: 'shows', to: redesignPaths.shows, label: t('player.redesign.nav.shows'), icon: 'tv', match: (p) => p.startsWith('/player/watch/shows') },
    { id: 'movies', to: redesignPaths.movies, label: t('player.redesign.nav.movies'), icon: 'film', match: (p) => p.startsWith('/player/watch/movies') },
    { id: 'my-list', to: redesignPaths.myList, label: t('player.redesign.nav.myList'), icon: 'list', match: (p) => p.startsWith('/player/watch/my-list') },
    { id: 'search', to: redesignPaths.search, label: t('player.redesign.nav.search'), icon: 'search', match: (p) => p.startsWith('/player/watch/search') || p.startsWith('/player/search') },
  ];
  const side: Tab[] = [
    { id: 'music', to: '/player/music', label: t('player.redesign.nav.music'), icon: 'music', match: (p) => p.startsWith('/player/music') },
    { id: 'books', to: '/player/books', label: t('player.redesign.nav.books'), icon: 'book', match: (p) => p.startsWith('/player/books') },
  ];
  return { main, side };
}

/** Which sections the tabs show: Movies & TV when the server has it on, Music / Audiobooks also by profile toggle. */
export function useSections() {
  const caps = usePlaybackCapabilities();
  const settings = useProfileSettings();
  const s = caps.data?.sections;
  return {
    video: s?.video ?? false,
    music: Boolean(s?.music) && settings.showMusic,
    books: Boolean(s?.audiobooks || s?.books) && settings.showAudiobooks,
  };
}

/** Pages that are the old music / audiobook / utility pages: they get the classic page frame. */
export function isLegacyPage(path: string): boolean {
  return ['/player/music', '/player/books', '/player/now-playing', '/player/link', '/player/search'].some((p) => path === p || path.startsWith(`${p}/`));
}

/** The account's profiles, the active one first in mind: what the avatar and picker show. */
export function useProfilesView() {
  const { session, user } = useAuth();
  const list = useHouseholdProfiles(Boolean(session || user));
  const active = session?.activeProfile ?? null;
  const fallbackName = user?.displayName || user?.username || '';
  const me = active
    ? { name: active.name, color: active.color, initial: active.initial }
    : { name: fallbackName, color: 'var(--al-pl-accent)', initial: (fallbackName[0] ?? '?').toUpperCase() };
  return { profiles: list.data?.profiles ?? [], canManage: list.data?.canManage ?? false, activeId: list.data?.activeProfileId ?? active?.id ?? null, me, loaded: !list.isPending };
}

interface RedesignRootProps {
  children: ReactNode;
  className?: string | undefined;
  layoutOverride?: PlayerLayout | undefined;
}

/** Root wrapper: layout, tile scale, profile theme and display settings. */
export function RedesignRoot(props: RedesignRootProps) {
  const { user, isAdmin } = useAuth();
  const settings = useProfileSettings();
  usePlayerTheme(settings.theme, user ? readUiPreferences(user.settings).theme : null, isAdmin);
  return <RedesignFrame {...props} />;
}

/**
 * RedesignRoot without the theme: layout, tile scale and the profile's display settings. For a
 * host that applies the profile theme itself (the Arclight app loads theme packs its own way).
 */
export function RedesignFrame({ children, className, layoutOverride }: RedesignRootProps) {
  const settings = useProfileSettings();
  const live = useLayout();
  const layout = layoutOverride ?? live;
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return (
    <div
      className={cx('rd-root', settings.reduceMotion && 'rd-reduce-motion', settings.focusStyle === 'cyan-glow' && 'rd-focus-glow', className)}
      data-layout={layout}
      style={{ '--rd-scale': tileScale(width).toFixed(3) } as CSSProperties}
    >
      {children}
    </div>
  );
}

function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > threshold);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [threshold]);
  return scrolled;
}

/** The wide header (template header: 72 px, logo 22, tabs 16/600). */
export function WideHeader({ transparent }: { transparent?: boolean | undefined }) {
  const t = useT();
  const path = strip(useRouterState({ select: (s) => s.location.pathname }));
  const { main, side } = useTabs();
  const sections = useSections();
  const scrolled = useScrolled();
  const tabs = sections.video ? main : main.filter((x) => x.id === 'home' || x.id === 'search');
  const sideTabs = side.filter((x) => (x.id === 'music' ? sections.music : sections.books));
  const settingsOn = path.startsWith('/player/settings');
  return (
    <header className={cx('rd-header', scrolled && 'is-scrolled', transparent && 'is-transparent')}>
      <PlayerLink to={redesignPaths.home} className="rd-header__brand" aria-label={t('player.redesign.nav.home')}>
        <Lockup height={22} />
      </PlayerLink>
      <nav className="rd-header__tabs" aria-label={t('player.redesign.nav.label')}>
        {tabs.map((tab) => (
          <HeaderTab key={tab.id} tab={tab} active={tab.match(path)} />
        ))}
      </nav>
      <div className="rd-header__end">
        <NowPlayingPill />
        {sideTabs.map((tab) => (
          <HeaderTab key={tab.id} tab={tab} active={tab.match(path)} side />
        ))}
        <span className="rd-header__divider" aria-hidden="true" />
        <HeaderTab tab={{ id: 'settings', to: redesignPaths.settings, label: t('player.redesign.nav.settings'), icon: 'settings', match: () => settingsOn }} active={settingsOn} side />
        <AvatarMenu layout="wide" />
      </div>
    </header>
  );
}

function HeaderTab({ tab, active, side }: { tab: Tab; active: boolean; side?: boolean }) {
  return (
    <PlayerLink to={tab.to} className={cx('rd-tab', side && 'rd-tab--side')} aria-current={active ? 'page' : undefined}>
      {side ? <RdIcon name={tab.icon} size={20} className="rd-tab__icon" /> : null}
      <span className="rd-tab__label">{tab.label}</span>
      {active ? <span className="rd-tab__dot" aria-hidden="true" /> : null}
    </PlayerLink>
  );
}

/** "track · artist" while audio plays (the template's pill); opens Now playing. */
function NowPlayingPill() {
  const t = useT();
  const { state } = usePlayer();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const item = state.current;
  if (!item || path.startsWith('/player/now-playing')) return null;
  const label = item.subtitle ? `${item.title} · ${item.kind === 'audiobook' ? (item.context ?? item.subtitle) : item.subtitle}` : item.title;
  return (
    <PlayerLink to="/player/now-playing" className="rd-np" aria-label={t('player.redesign.nowPlaying', { title: label })}>
      <Art image={item.artworkUrl} seed={item.title} className="rd-np__art" />
      <span className="rd-np__label">{label}</span>
    </PlayerLink>
  );
}

/** Phone top bar (§4.4): Mark 24, Music and Audiobooks icon buttons, the 32 px avatar. */
export function PortraitTopBar({ transparent }: { transparent?: boolean | undefined }) {
  const t = useT();
  const sections = useSections();
  const scrolled = useScrolled();
  return (
    <header className={cx('rd-topbar', scrolled && 'is-scrolled', transparent && 'is-transparent')}>
      <PlayerLink to={redesignPaths.home} className="rd-topbar__brand" aria-label={t('player.redesign.nav.home')}>
        <Mark size={24} />
      </PlayerLink>
      <div className="rd-topbar__end">
        {sections.music ? (
          <PlayerLink to="/player/music" className="rd-iconbtn" aria-label={t('player.redesign.nav.music')}>
            <RdIcon name="music" />
          </PlayerLink>
        ) : null}
        {sections.books ? (
          <PlayerLink to="/player/books" className="rd-iconbtn" aria-label={t('player.redesign.nav.books')}>
            <RdIcon name="book" />
          </PlayerLink>
        ) : null}
        <AvatarMenu layout="portrait" />
      </div>
    </header>
  );
}

/** Phone bottom tab bar (§4.4): Home, TV Shows, Movies, My List, Search. */
export function BottomTabBar() {
  const t = useT();
  const path = strip(useRouterState({ select: (s) => s.location.pathname }));
  const { main } = useTabs();
  const sections = useSections();
  const tabs = sections.video ? main : main.filter((x) => x.id === 'home' || x.id === 'search');
  return (
    <nav className="rd-tabbar" aria-label={t('player.redesign.nav.label')}>
      {tabs.map((tab) => {
        const active = tab.match(path);
        return (
          <PlayerLink key={tab.id} to={tab.to} className="rd-tabbar__tab" aria-current={active ? 'page' : undefined}>
            <span className="rd-tabbar__icon">
              <RdIcon name={tab.icon} size={24} />
              {active ? <span className="rd-tab__dot" aria-hidden="true" /> : null}
            </span>
            <span className="rd-tabbar__label">{tab.label}</span>
          </PlayerLink>
        );
      })}
    </nav>
  );
}

/** Phone mini player (§4.4): art 40, "title · artist", play / pause; above the tab bar. */
export function PortraitMiniPlayer() {
  const t = useT();
  const { state, toggle } = usePlayer();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const item = state.current;
  if (!item || path.startsWith('/player/now-playing')) return null;
  const label = item.subtitle ? `${item.title} · ${item.subtitle}` : item.title;
  const pct = state.durationMs > 0 ? Math.min(100, (state.positionMs / state.durationMs) * 100) : 0;
  return (
    <section className="rd-mini" aria-label={t('player.mini.label')}>
      <span className="rd-mini__progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <PlayerLink to="/player/now-playing" className="rd-mini__open" aria-label={t('player.mini.open', { title: item.title })}>
        <Art image={item.artworkUrl} seed={item.title} className="rd-mini__art" />
        <span className="rd-mini__label">{label}</span>
      </PlayerLink>
      <button type="button" className="rd-iconbtn" onClick={toggle} aria-label={state.playing ? t('player.controls.pause') : t('player.controls.play')}>
        <RdIcon name={state.playing ? 'pause' : 'play'} size={state.playing ? 24 : 20} />
      </button>
    </section>
  );
}

/** The avatar and its menu: other profiles, Settings, Manage profiles (owner), the account links, Sign out. */
export function AvatarMenu({ layout }: { layout: 'wide' | 'portrait' }) {
  const t = useT();
  const navigate = useNavigate();
  const { access, user, logout } = useAuth();
  const { profiles, me, activeId, canManage } = useProfilesView();
  const owner = useIsOwnerProfile();
  const select = useSelectProfile();
  const [open, setOpen] = useState(false);
  const [appSignIn, setAppSignIn] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const caps = usePlaybackCapabilities().data;
  // Open Arclight: never the root of a player hostname (app-href.ts).
  const appLink = appHref(appHomeFor(access), readPlayerDocument(), caps?.appUrl, location.origin);
  // Request portal: people who may request. Its public address, else the built-in /portal.
  const portalUrl = caps?.portalUrl ?? null;
  const portalLink = canRequest(access) ? portalHref(portalUrl, location.origin, readPortalDocument()) : null;

  useEffect(() => {
    if (!open || layout !== 'wide') return undefined;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLElement>('.rd-avatarbtn')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, layout]);

  const go = (to: string) => {
    setOpen(false);
    void navigate({ to: to as '/player' });
  };
  const switchTo = (p: HouseholdProfile) => {
    setOpen(false);
    if (p.hasPin) {
      void navigate({ to: redesignPaths.profiles as '/player', search: { select: p.id } as never });
      return;
    }
    select.mutate(
      { id: p.id },
      {
        onSuccess: () => {
          markProfilePicked();
          void navigate({ to: redesignPaths.home as '/player' });
        },
        onError: () => void navigate({ to: redesignPaths.profiles as '/player', search: { select: p.id } as never }),
      },
    );
  };

  const others = profiles.filter((p) => p.id !== activeId);
  const items = (
    <div className="rd-menu__list">
      {others.length ? (
        <div className="rd-menu__group" role="group" aria-label={t('player.redesign.menu.switchTo')}>
          {others.map((p) => (
            <button key={p.id} type="button" className="rd-menu__item" onClick={() => switchTo(p)}>
              <ProfileAvatar color={p.color} initial={p.initial} size={28} />
              <span>{p.name}</span>
              {p.hasPin ? <RdIcon name="lock" size={16} className="rd-menu__trail" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="rd-menu__item" onClick={() => go(redesignPaths.settings)}>
        <RdIcon name="settings" />
        <span>{t('player.redesign.nav.settings')}</span>
      </button>
      {canManage ? (
        <button type="button" className="rd-menu__item" onClick={() => {
            setOpen(false);
            void navigate({ to: redesignPaths.profiles as '/player', search: { manage: 1 } as never });
          }}>
          <RdIcon name="users" />
          <span>{t('player.redesign.profiles.manage')}</span>
        </button>
      ) : null}
      {owner && appLink ? (
        <a className="rd-menu__item" href={appLink}>
          <RdIcon name="chevronRight" />
          <span>{t('player.account.openApp')}</span>
        </a>
      ) : null}
      {owner && portalLink ? (
        <a className="rd-menu__item" href={portalLink}>
          <RdIcon name="chevronRight" />
          <span>{t('player.account.portal')}</span>
        </a>
      ) : null}
      {user && owner ? (
        <button
          type="button"
          className="rd-menu__item"
          onClick={() => {
            setOpen(false);
            setAppSignIn(true);
          }}
        >
          <RdIcon name="tv" />
          <span>{t('player.account.appSignIn')}</span>
        </button>
      ) : null}
      <button type="button" className="rd-menu__item rd-menu__item--sep" onClick={() => void logout()}>
        <RdIcon name="signOut" />
        <span>{t('player.account.signOut')}</span>
      </button>
    </div>
  );

  return (
    <div className="rd-avatarmenu" ref={wrap}>
      <button
        type="button"
        className="rd-avatarbtn"
        aria-haspopup={layout === 'portrait' ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-label={t('player.redesign.menu.label', { name: me.name })}
        onClick={() => setOpen((v) => !v)}
      >
        <ProfileAvatar color={me.color} initial={me.initial} size={layout === 'portrait' ? 32 : 34} />
      </button>
      {layout === 'wide' ? (
        open ? (
          <div className="rd-menu" role="menu" aria-label={t('player.redesign.menu.label', { name: me.name })}>
            <div className="rd-menu__me">
              <ProfileAvatar color={me.color} initial={me.initial} size={40} />
              <span>{me.name}</span>
            </div>
            {items}
          </div>
        ) : null
      ) : (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={me.name}>
          {items}
        </BottomSheet>
      )}
      <AppSignInDialog open={appSignIn} onClose={() => setAppSignIn(false)} />
    </div>
  );
}
