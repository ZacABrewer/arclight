import { Suspense, type ComponentType, type FC } from 'react';
import { createHashHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, redirect, type RouterHistory } from '@tanstack/react-router';
import { Skeleton } from '@web/arclight/index';
import { browseRoutes } from '@web/features/player/browse/index';
import { NowPlayingPage } from '@web/features/player/ui/now-playing';
import { getSession } from '../core/session';
import { shouldShowPicker } from '../households/gate';
import { AddServerPage, SignInPage, WelcomePage } from '../ui/onboarding';
import { AppHome } from '../ui/home';
import { DownloadsPage } from '../ui/downloads';
import { QueuePage } from '../ui/queue';
import { SettingsPage } from '../ui/settings';
import { Shell } from '../ui/shell';
import { MyListPage } from '../ui/my-list';
import { PhoneProfilesScreen } from '../ui/profiles';
import { isTvMode } from '../tv/tv-mode';
import { TvMoviesScreen, TvMyListScreen, TvShowsScreen } from '../tv/screens/browse';
import { TvMovieScreen, TvShowScreen } from '../tv/screens/detail';
import { TvHomeScreen } from '../tv/screens/home';
import { TvListenScreen } from '../tv/screens/listen';
import { TvManageProfilesScreen } from '../tv/screens/manage-profiles';
import { TvBooksScreen, TvMusicScreen } from '../tv/screens/music';
import { TvProfilesScreen } from '../tv/screens/profiles';
import { TvSearchScreen } from '../tv/screens/search';
import { MANAGE_PROFILES_PATH, TvSettingsScreen } from '../tv/screens/settings';
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

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: () => <Outlet /> });

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
  component: () => (isTvMode() ? <TvProfilesScreen /> : <PhoneProfilesScreen />),
});

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
  createRoute({ getParentRoute: () => playerRoute, path: 'settings', component: byDevice(TvSettingsScreen, SettingsPage) }),
  createRoute({ getParentRoute: () => playerRoute, path: childPath(MANAGE_PROFILES_PATH), component: byDevice(TvManageProfilesScreen, SettingsPage) }),
  createRoute({ getParentRoute: () => playerRoute, path: 'watch/my-list', component: byDevice(TvMyListScreen, MyListPage) }),
  ...browseRoutes.map((r) => {
    const path = childPath(r.path);
    const web = lazyPage(r.component);
    const tv = TV_PAGES[path];
    return createRoute({ getParentRoute: () => playerRoute, path, component: tv ? byDevice(tv, web) : web });
  }),
];

const routeTree = rootRoute.addChildren([indexRoute, welcomeRoute, addServerRoute, signInRoute, profilesRoute, playerRoute.addChildren(playerChildren)]);

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
