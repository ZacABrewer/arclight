import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { EmptyState, ErrorBlock, Pane, buttonClass, cx, isTypingTarget } from '../../../arclight/index.js';
import { useAuth } from '../../../auth/auth-context.js';
import { appHomeFor } from '../../../auth/access.js';
import { errorMessage } from '../../../api/client.js';
import { t } from '../../../i18n/index.js';
import { usePlaybackCapabilities } from '../api.js';
import { BOOK_SKIP_MS } from '../engine/media-session.js';
import { PlayerProvider, usePlayer } from '../player-context.js';
import { MiniPlayer } from './mini-player.js';
import { BrowsePlayerContext, type BrowsePlayerActions } from '../browse/player-hooks.js';
import { useLayout } from '../redesign/layout.js';
import { RdLoading } from '../redesign/pages/common.js';
import { RdProfilesPage } from '../redesign/pages/profiles.js';
import { wasProfilePicked } from '../redesign/profile-session.js';
import { BottomTabBar, PortraitMiniPlayer, PortraitTopBar, RedesignRoot, WideHeader, isLegacyPage, useProfilesView } from '../redesign/shell.js';
import '../player.css';

// Layout of every /player page: the redesign chrome (header or top bar and tab bar), the page,
// and the mini-player. The PlayerProvider lives here, so playback carries on
// while moving between player pages.

/** Music track skip for the arrow keys; audiobooks use BOOK_SKIP_MS. */
export const KEY_SKIP_MS = 10_000;

/** Gives the browse pages (features/player/browse) the actions they use from the shared player. */
function BrowsePlayerBridge({ children }: { children: ReactNode }) {
  const { state, playItems, playItem, playNext, addToQueue, toggle } = usePlayer();
  const currentItemKey = state.current?.itemKey ?? null;
  const value = useMemo<BrowsePlayerActions>(
    () => ({ currentItemKey, playing: state.playing, playItems, playItem: (key) => playItem(key), playNext, addToQueue, toggle }),
    [currentItemKey, state.playing, playItems, playItem, playNext, addToQueue, toggle],
  );
  return <BrowsePlayerContext.Provider value={value}>{children}</BrowsePlayerContext.Provider>;
}

/** The full-screen video player has its own keys and no chrome around it. */
const isVideoPlayer = (pathname: string) => pathname.startsWith('/player/watch/play');
/** Pages whose art runs under the header (the hero on Home, the backdrop on details). */
const isOverlayPage = (p: string) => p === '/player' || p === '/player/' || p === '/player/watch' || p === '/player/watch/' || /^\/player\/watch\/(movies|shows)\/[^/]+\/?$/.test(p);

/** Guard + chrome. */
export function PlayerLayout() {
  const { status, user } = useAuth();
  const signedIn = status?.authenticated ?? Boolean(user);
  const caps = usePlaybackCapabilities(signedIn);

  useEffect(() => {
    document.title = t('player.documentTitle');
  }, []);

  if (!signedIn || caps.isPending) {
    return (
      <RedesignRoot className="rd-bare">
        <RdLoading />
      </RedesignRoot>
    );
  }
  if (caps.data && caps.data.enabled && caps.data.allowed) {
    return (
      <PlayerProvider capabilities={caps.data}>
        <BrowsePlayerBridge>
          <PlayerShell>
            <Outlet />
          </PlayerShell>
        </BrowsePlayerBridge>
        <PlayerShortcuts />
      </PlayerProvider>
    );
  }
  return (
    <RedesignRoot className="rd-bare">
      <main className="pl-main rd-legacy">
        <PlayerOff error={caps.isError ? caps.error : null} />
      </main>
    </RedesignRoot>
  );
}

/**
 * The redesign chrome (spec §4.4-§4.6). Wide: the header over the page. Portrait: the top bar,
 * the bottom tab bar and the mini player. The music and audiobook pages keep their own page frame
 * inside it. "Who's watching?" comes first when the account has two or more profiles and none was
 * picked in this tab.
 */
function PlayerShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const layout = useLayout() === 'portrait' ? 'portrait' : 'wide';
  const { profiles, loaded } = useProfilesView();
  const onProfiles = pathname.startsWith('/player/profiles');
  const [picked, setPicked] = useState(wasProfilePicked);
  const gate = loaded && profiles.length >= 2 && !picked && !wasProfilePicked() && !onProfiles && !isVideoPlayer(pathname);

  if (gate) {
    return (
      <RedesignRoot className="rd-bare">
        <RdProfilesPage gate onPicked={() => setPicked(true)} />
      </RedesignRoot>
    );
  }
  if (isVideoPlayer(pathname) || onProfiles) {
    return <RedesignRoot className="rd-bare">{children}</RedesignRoot>;
  }

  const legacy = isLegacyPage(pathname);
  const overlay = isOverlayPage(pathname);
  return (
    <RedesignRoot className={cx('al-app', 'pl-app', `rd-shell--${layout}`)}>
      {layout === 'wide' ? <WideHeader transparent={overlay} /> : <PortraitTopBar transparent={overlay} />}
      <main className={cx('rd-main', legacy && 'pl-main rd-legacy')} id="player-main" data-overlay={overlay || undefined}>
        {children}
      </main>
      {layout === 'wide' ? (
        <DockedMiniPlayer />
      ) : (
        <>
          <PortraitMiniPlayer />
          <BottomTabBar />
        </>
      )}
    </RedesignRoot>
  );
}

/** Wide: the classic docked mini-player, except on Now playing (which is the full version of it). */
function DockedMiniPlayer() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname.startsWith('/player/now-playing')) return null;
  return <MiniPlayer />;
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
  const onVideo = useRouterState({ select: (s) => isVideoPlayer(s.location.pathname) });
  useEffect(() => {
    if (onVideo) return undefined;
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
  }, [player, onVideo]);
  return null;
}
