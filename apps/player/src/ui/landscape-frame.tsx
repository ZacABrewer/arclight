import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Backdrop, Icon, cx } from '@web/arclight/index';
import { Lockup } from '@web/arclight/lockup';
import { useT } from '@web/i18n/index';
import { MiniPlayer } from '@web/features/player/ui/mini-player';
import { RdIcon } from '@web/features/player/redesign/icons';
import { ProfileAvatar } from '@web/features/player/redesign/profile-avatar';
import { RedesignFrame, isLegacyPage, useTabs } from '@web/features/player/redesign/shell';
import { useNet } from '../app/context';
import { useActiveProfile, useProfileSettings } from '../households/api';
import { DEVICE_SETTINGS_PATH } from './phone-pages';
import './landscape-frame.css';

// Phone landscape (features spec §5.5, D2): the design's wide header (72 px, 56 px when the
// screen is under 430 px tall) over the page, as the web does in landscape. No bottom tabs; the
// mini-player docks at the bottom right. The header and the page keep clear of the side insets
// (the notch and the rounded corners).

const strip = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** Pages whose art runs under the header: the hero on Home, the backdrop on title pages. */
export const isOverlayPage = (p: string) => p === '/player' || p === '/player/watch' || /^\/player\/watch\/(movies|shows)\/[^/]+$/.test(p);

/** The app's own pages (and the two the redesign left alone) keep the plain page frame. */
export const isPlainPage = (p: string) =>
  isLegacyPage(p) || ['/player/queue', '/player/downloads', DEVICE_SETTINGS_PATH].some((x) => p === x || p.startsWith(`${x}/`));

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

interface LandscapeFrameProps {
  children: ReactNode;
  bare?: boolean | undefined;
  /** The avatar's sheet (switch profile, Settings, Sign out), the same one as in portrait. */
  sheet: (close: () => void) => ReactNode;
}

export function LandscapeFrame({ children, bare, sheet }: LandscapeFrameProps) {
  const t = useT();
  const net = useNet();
  const settings = useProfileSettings();
  const { profile } = useActiveProfile();
  const { main, side } = useTabs();
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);
  const path = strip(useRouterState({ select: (s) => s.location.pathname }));
  const sideTabs = side.filter((x) => (x.id === 'music' ? settings.showMusic : settings.showAudiobooks));
  const settingsOn = path === '/player/settings' || path.startsWith('/player/settings/');
  // Offline, Home is the downloads list, not the hero.
  const overlay = !bare && net.online && isOverlayPage(path);
  const plain = bare || isPlainPage(path) || (!net.online && path === '/player');
  const onNowPlaying = path.startsWith('/player/now-playing');
  return (
    <RedesignFrame layoutOverride="wide" className="al-app pl-app app-shell app-wide rd-shell--wide">
      <Backdrop vx={0.5} horizon={0.7} />
      <header className={cx('rd-header app-wide__header', scrolled && 'is-scrolled', overlay && 'is-transparent')}>
        <Link to="/player" className="rd-header__brand" aria-label={t('app.tv.tab.home')}>
          <Lockup height={22} />
        </Link>
        <nav className="rd-header__tabs" aria-label={t('app.nav.label')}>
          {main.map((tab) => (
            <HeaderLink key={tab.id} to={tab.to} label={tab.label} active={tab.match(path)} />
          ))}
        </nav>
        <div className="rd-header__end">
          {!net.online ? (
            <span className="app-badge" role="status">
              {t('app.offline')}
            </span>
          ) : null}
          {sideTabs.map((tab) => (
            <HeaderLink key={tab.id} to={tab.to} label={tab.label} active={tab.match(path)} icon={<RdIcon name={tab.icon} size={20} className="rd-tab__icon" />} />
          ))}
          <span className="rd-header__divider" aria-hidden="true" />
          <HeaderLink to="/player/settings" label={t('app.tv.tab.settings')} active={settingsOn} icon={<RdIcon name="settings" size={20} className="rd-tab__icon" />} />
          <button type="button" className="app-top__avatar app-touch" aria-label={profile?.name ?? t('app.tv.switchProfile')} aria-haspopup="dialog" onClick={() => setOpen(true)}>
            {profile ? <ProfileAvatar color={profile.color} initial={profile.initial} size={32} /> : <Icon name="user" size={24} />}
          </button>
        </div>
      </header>
      <main className={cx('rd-main app-wide__main', plain && 'pl-main rd-legacy')} id="player-main" data-overlay={overlay || undefined}>
        {children}
      </main>
      {!bare && !onNowPlaying ? (
        <div className="app-wide__mini">
          <MiniPlayer />
        </div>
      ) : null}
      {open ? sheet(() => setOpen(false)) : null}
    </RedesignFrame>
  );
}

function HeaderLink({ to, label, active, icon }: { to: string; label: string; active: boolean; icon?: ReactNode }) {
  return (
    // exact: TanStack marks a Link active (and sets aria-current) for child routes too.
    <Link to={to} activeOptions={{ exact: true }} className={cx('rd-tab', icon ? 'rd-tab--side' : null)} aria-current={active ? 'page' : undefined}>
      {icon}
      <span className="rd-tab__label">{label}</span>
      {active ? <span className="rd-tab__dot" aria-hidden="true" /> : null}
    </Link>
  );
}
