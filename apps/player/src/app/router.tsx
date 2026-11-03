import { Suspense, type ComponentType, type FC, type ReactNode } from 'react';
import { createHashHistory, createRootRouteWithContext, createRoute, createRouter, Navigate, Outlet, redirect, type RouterHistory } from '@tanstack/react-router';
import { Skeleton } from '@web/arclight/index';
import { browseRoutes } from '@web/features/player/browse/index';
import { PlayerControllerScope } from '@web/features/player/player-context';
import { NowPlayingPage } from '@web/features/player/ui/now-playing';
import { getSession } from '../core/session';
import { useActiveProfile } from '../households/api';
import { shouldShowPicker } from '../households/gate';
import { AppAuthBridge } from '../households/web-auth';
import { AddServerPage, SignInPage, WelcomePage } from '../ui/onboarding';
import { AppHome } from '../ui/home';
import { DownloadsPage } from '../ui/downloads';
import { QueuePage } from '../ui/queue';
import { SettingsPage } from '../ui/settings';
import { Shell } from '../ui/shell';
import { DEVICE_SETTINGS_PATH, PhoneProfilesPage, PhoneSettingsPage } from '../ui/phone-pages';
import { isTvMode } from '../tv/tv-mode';
import { TvMoviesScreen, TvMyListScreen, TvShowsScreen } from '../tv/screens/browse';
import { TvMovieScreen, TvShowScreen } from '../tv/screens/detail';
import { TvHomeScreen } from '../tv/screens/home';
import { TvListenScreen } from '../tv/screens/listen';
import { TvManageProfilesScreen } from '../tv/screens/manage-profiles';
import { TvBooksScreen, TvMusicScreen } from '../tv/screens/music';
import { TvProfilesScreen } from '../tv/screens/profiles';
import { TvSearchScreen } from '../tv/screens/search';
import { MANAGE_PROFILES_PATH, ownsAccount, TvSettingsScreen } from '../tv/screens/settings';
import { useServices } from './context';
import type { AppServices } from './services';

// Hash history: the bundle is served from capacitor://localhost / https://localhost as files,
// so every route lives after the "#". The /player paths match the web portal's, so the reused
// web pages (browse, now playing, mini-player) link correctly.

export interface RouterContext {
  services: AppServices;
}

export interface SignInSearch {
  server?: string | undefined;
  code?: string | undefined;
  expired?: boolean | undefined;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Where to go when there is no usable session: sign in again to an expired account, or start over. */
function signedOutTarget(services: AppServices): { to: string; search?: SignInSearch } {
  const active = services.accounts.active();
  if (active) return { to: '/sign-in', search: { server: active.serverUrl, expired: true } };
  return { to: '/welcome' };
}

// AppAuthBridge: the shared web pages read the signed-in user and profile from the web's auth state.
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppAuthBridge>
      <Outlet />
    </AppAuthBridge>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    throw redirect(getSession() ? { to: '/player' } : signedOutTarget(context.services));
  },
});

const welcomeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/welcome', component: WelcomePage });

const addServerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/add-server',
  validateSearch: (s: Record<string, unknown>): { address?: string | undefined } => ({ address: str(s.address) }),
  component: AddServerPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (s: Record<string, unknown>): SignInSearch => ({
    server: str(s.server),
    code: str(s.code),
    expired: s.expired === true || s.expired === 'true' || undefined,
  }),
  component: SignInPage,
});

/**
 * "Who's watching?" before the first /player page of an app run, for accounts with 2 or more
 * profiles (§9 Q9). Null: go on.
 */
export async function pickerRedirect(services: Pick<AppServices, 'qc'>, accountId: string, check: typeof shouldShowPicker = shouldShowPicker): Promise<{ to: string } | null> {
  return (await check(services.qc, accountId)) ? { to: '/profiles' } : null;
}

const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/player',
  beforeLoad: async ({ context }) => {
    const session = getSession();
    if (!session) throw redirect(signedOutTarget(context.services));
    const to = await pickerRedirect(context.services, session.accountId);
    if (to) throw redirect(to);
  },
  component: Shell,
});

const profilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profiles',
  beforeLoad: ({ context }) => {
    if (!getSession()) throw redirect(signedOutTarget(context.services));
  },
  component: () => <PickerScope>{isTvMode() ? <TvProfilesScreen /> : <PhoneProfilesPage gate />}</PickerScope>,
});

/**
 * The picker opened on purpose (avatar menu, Settings > Profiles): the web's /player/profiles,
 * with `?select=<id>` (that profile's PIN) and `?manage=1` (Manage profiles). Outside the /player
 * shell so the launch gate never sends it back to itself.
 */
const playerProfilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/player/profiles',
  validateSearch: (s: Record<string, unknown>): { select?: unknown; manage?: unknown; add?: unknown } => ({ select: s.select, manage: s.manage, add: s.add }),
  beforeLoad: ({ context }) => {
    if (!getSession()) throw redirect(signedOutTarget(context.services));
  },
  component: () => <PickerScope>{isTvMode() ? <TvProfilesScreen /> : <PhoneProfilesPage />}</PickerScope>,
});

/** This device's settings (accounts, streaming, language) on TV: the app page, under the TV header. */
function TvDeviceSettings() {
  const { profile } = useActiveProfile();
  // Owner only (TV Settings shows the row to the owner profile alone).
  if (!ownsAccount(profile)) return <Navigate to="/player/settings" replace />;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-browse">
        <SettingsPage />
      </div>
    </div>
  );
}

/** The pickers sit outside the shell's player; a switch still hands the player over (the queue is per profile). */
function PickerScope({ children }: { children: ReactNode }) {
  const services = useServices();
  return <PlayerControllerScope controller={services.player().controller}>{children}</PlayerControllerScope>;
}

/** Phones manage profiles on the shared picker page. */
function PhoneManageProfiles() {
  return <Navigate to="/player/profiles" search={{ manage: 1 }} replace />;
}

function lazyPage(Component: ComponentType) {
  return function LazyPage() {
    return (
      <Suspense fallback={<Skeleton lines={6} />}>
        <Component />
      </Suspense>
    );
  };
}

const childPath = (full: string) => full.replace(/^\/player\//, '');

/** TV screens by child path (§4.3); everything else is the shared web page. */
const TV_PAGES: Record<string, FC> = {
  watch: TvHomeScreen,
  'watch/movies': TvMoviesScreen,
  'watch/shows': TvShowsScreen,
  'watch/movies/$id': TvMovieScreen,
  'watch/shows/$id': TvShowScreen,
  'watch/my-list': TvMyListScreen,
  'watch/search': TvSearchScreen,
  search: TvSearchScreen,
  music: TvMusicScreen,
  books: TvBooksScreen,
};

/** The TV screen on a TV, the phone page otherwise (decided when it renders). */
function byDevice(Tv: FC, Phone: FC): FC {
  return function DevicePage() {
    return isTvMode() ? <Tv /> : <Phone />;
  };
}

const playerChildren = [
  createRoute({ getParentRoute: () => playerRoute, path: '/', component: byDevice(TvHomeScreen, AppHome) }),
  createRoute({ getParentRoute: () => playerRoute, path: 'now-playing', component: byDevice(TvListenScreen, NowPlayingPage) }),
  createRoute({ getParentRoute: () => playerRoute, path: 'queue', component: QueuePage }),
  createRoute({ getParentRoute: () => playerRoute, path: 'downloads', component: DownloadsPage }),
  createRoute({ getParentRoute: () => playerRoute, path: 'settings', component: byDevice(TvSettingsScreen, PhoneSettingsPage) }),
  createRoute({ getParentRoute: () => playerRoute, path: childPath(DEVICE_SETTINGS_PATH), component: byDevice(TvDeviceSettings, SettingsPage) }),
  createRoute({ getParentRoute: () => playerRoute, path: childPath(MANAGE_PROFILES_PATH), component: byDevice(TvManageProfilesScreen, PhoneManageProfiles) }),
  ...browseRoutes.map((r) => {
    const path = childPath(r.path);
    const web = lazyPage(r.component);
    const tv = TV_PAGES[path];
    return createRoute({ getParentRoute: () => playerRoute, path, component: tv ? byDevice(tv, web) : web });
  }),
];

const routeTree = rootRoute.addChildren([indexRoute, welcomeRoute, addServerRoute, signInRoute, profilesRoute, playerProfilesRoute, playerRoute.addChildren(playerChildren)]);

export function createAppRouter(services: AppServices, history: RouterHistory = createHashHistory()) {
  return createRouter({
    routeTree,
    history,
    context: { services },
    defaultPreload: false,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export { signedOutTarget };
