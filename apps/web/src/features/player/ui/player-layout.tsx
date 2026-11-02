import { useEffect, type ReactNode } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Backdrop, Button, EmptyState, ErrorBlock, Icon, Mark, Menu, Pane, Popover, Skeleton, buttonClass, isTypingTarget, type MenuItem } from '../../../arclight/index.js';
import { useAuth } from '../../../auth/auth-context.js';
import { appHomeFor } from '../../../auth/access.js';
import { errorMessage } from '../../../api/client.js';
import { t } from '../../../i18n/index.js';
import { usePlaybackCapabilities } from '../api.js';
import { BOOK_SKIP_MS } from '../engine/media-session.js';
import { PlayerProvider, usePlayer } from '../player-context.js';
import { MiniPlayer } from './mini-player.js';
import '../player.css';

// Layout of every /player page: header (mark, sections, search, account), the page, and the
// mini-player docked at the bottom. The PlayerProvider lives here, so playback carries on
// while moving between player pages.

/** Music track skip for the arrow keys; audiobooks use BOOK_SKIP_MS. */
export const KEY_SKIP_MS = 10_000;

interface Section {
  id: string;
  to: string;
  label: () => string;
  /** Not built yet: shown greyed out with "Coming soon". */
  soon?: boolean;
}

const SECTIONS: readonly Section[] = [
  { id: 'music', to: '/player/music', label: () => t('player.nav.music') },
  { id: 'books', to: '/player/books', label: () => t('player.nav.books') },
  { id: 'video', to: '', label: () => t('player.nav.video'), soon: true },
  { id: 'podcasts', to: '', label: () => t('player.nav.podcasts'), soon: true },
];

function sectionOf(pathname: string): string | null {
  if (pathname.startsWith('/player/music')) return 'music';
  if (pathname.startsWith('/player/books')) return 'books';
  return null;
}

/** Guard + chrome. */
export function PlayerLayout() {
  const { status, user } = useAuth();
  const signedIn = status?.authenticated ?? Boolean(user);
  const caps = usePlaybackCapabilities(signedIn);

  useEffect(() => {
    document.title = t('player.documentTitle');
  }, []);

  let body: ReactNode;
  if (!signedIn || caps.isPending) body = <PlayerShell bare><Skeleton lines={6} /></PlayerShell>;
  else if (caps.data && caps.data.enabled && caps.data.allowed) {
    return (
      <PlayerProvider capabilities={caps.data}>
        <PlayerShell>
          <Outlet />
        </PlayerShell>
        <PlayerShortcuts />
      </PlayerProvider>
    );
  } else body = <PlayerShell bare><PlayerOff error={caps.isError ? caps.error : null} /></PlayerShell>;
  return body;
}

function PlayerShell({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionOf(pathname);
  return (
    <div className="al-app pl-app">
      <Backdrop vx={0.5} horizon={0.7} />
      <header className="pl-head">
        <Link to="/player" className="pl-brand" aria-label={t('player.nav.home')}>
          <Mark size={28} />
        </Link>
        {!bare ? (
          <nav className="pl-tabs" aria-label={t('player.nav.label')}>
            {SECTIONS.map((s) =>
              s.soon ? (
                <span key={s.id} className="pl-tabs__link is-soon" aria-disabled="true" title={t('player.nav.comingSoon')}>
                  {s.label()}
                  <span className="pl-tabs__soon">{t('player.nav.comingSoon')}</span>
                </span>
              ) : (
                // Browse routes register under /player (router.tsx playerSectionRoutes).
                <Link key={s.id} to={s.to as '/player'} className="pl-tabs__link" aria-current={section === s.id ? 'page' : undefined}>
                  {s.label()}
                </Link>
              ),
            )}
          </nav>
        ) : null}
        <div className="pl-head__end">
          {!bare ? (
            <Link to={'/player/search' as '/player'} className={buttonClass({ variant: 'ghost', iconOnly: true, className: 'pl-head__btn' })} aria-label={t('player.nav.search')}>
              <Icon name="search" size={20} />
            </Link>
          ) : null}
          <AccountMenu />
        </div>
      </header>
      <main className="pl-main" id="player-main">
        {children}
      </main>
      {!bare ? <DockedMiniPlayer /> : null}
    </div>
  );
}

/** The mini-player, except on Now playing (which is the full version of it). */
function DockedMiniPlayer() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname.startsWith('/player/now-playing')) return null;
  return <MiniPlayer />;
}

function AccountMenu() {
  const { user, access, logout } = useAuth();
  const appHref = appHomeFor(access);
  const items: MenuItem[] = [
    ...(appHref ? [{ id: 'app', label: t('player.account.openApp'), href: appHref }] : []),
    { id: 'portal', label: t('player.account.portal'), href: '/portal' },
    { id: 'signout', label: t('player.account.signOut'), onSelect: () => void logout(), separatorBefore: true },
  ];
  return (
    <Popover
      placement="bottom-end"
      width={240}
      label={t('player.account.menu')}
      trigger={(props) => (
        <Button variant="ghost" className="pl-head__btn" icon={<Icon name="user" size={20} />} aria-label={t('player.account.menu')} {...props} />
      )}
    >
      {(close) => <Menu items={items} onDone={close} header={user ? <span className="pl-account__name">{user.displayName || user.username}</span> : null} />}
    </Popover>
  );
}

/** Shown when the player is off, or this account may not use it. */
export function PlayerOff({ error }: { error?: unknown }) {
  const { access } = useAuth();
  const back = appHomeFor(access) ?? '/portal';
  return (
    <Pane chamfer="both" strong className="pl-card pl-off">
      {error && !isAccessError(error) ? (
        <ErrorBlock title={t('player.off.couldNotLoad')}>{errorMessage(error)}</ErrorBlock>
      ) : (
        <EmptyState
          title={t('player.off.title')}
          action={
            <a href={back} className={buttonClass({ variant: 'primary' })}>
              {back === '/portal' ? t('player.off.backPortal') : t('player.off.backApp')}
            </a>
          }
        >
          {t('player.off.help')}
        </EmptyState>
      )}
    </Pane>
  );
}

function isAccessError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}

/**
 * Keyboard: Space play / pause, ←/→ back / forward 10 s (30 s for audiobooks), N next, P
 * previous, M mute. Ignored while typing, with modifiers, and where the focused control
 * already uses the key (buttons, links, sliders).
 */
export function PlayerShortcuts() {
  const player = usePlayer();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      // Space presses a focused button or link; arrows move sliders, tabs and menus.
      const pressable = Boolean(el?.closest('button, a, summary, input, [role="tab"], [role="menuitem"]'));
      const arrowed = Boolean(el?.closest('input, [role="slider"], [role="tab"], [role="tablist"], [role="menu"], [role="listbox"]'));
      const book = player.state.current?.kind === 'audiobook';
      const step = book ? BOOK_SKIP_MS : KEY_SKIP_MS;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        case ' ':
          if (pressable) return;
          player.toggle();
          break;
        case 'ArrowLeft':
          if (arrowed) return;
          player.skip(-step);
          break;
        case 'ArrowRight':
          if (arrowed) return;
          player.skip(step);
          break;
        case 'n':
          player.next();
          break;
        case 'p':
          player.previous();
          break;
        case 'm':
          player.toggleMute();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);
  return null;
}
