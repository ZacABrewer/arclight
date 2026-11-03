import { Suspense, type ComponentType } from 'react';
import { createHashHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { Skeleton } from '@web/arclight/index';
import { browseRoutes } from '@web/features/player/browse/index';
import { NowPlayingPage } from '@web/features/player/ui/now-playing';
import { getSession } from '../core/session';
import { AddServerPage, SignInPage, WelcomePage } from '../ui/onboarding';
import { AppHome } from '../ui/home';
import { DownloadsPage } from '../ui/downloads';
import { QueuePage } from '../ui/queue';
import { SettingsPage } from '../ui/settings';
import { Shell } from '../ui/shell';
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

const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/player',
  beforeLoad: ({ context }) => {
    if (!getSession()) throw redirect(signedOutTarget(context.services));
  },
  component: Shell,
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

const playerChildren = [
  createRoute({ getParentRoute: () => playerRoute, path: '/', component: AppHome }),
  createRoute({ getParentRoute: () => playerRoute, path: 'now-playing', component: NowPlayingPage }),
  createRoute({ getParentRoute: () => playerRoute, path: 'queue', component: QueuePage }),
  createRoute({ getParentRoute: () => playerRoute, path: 'downloads', component: DownloadsPage }),
  createRoute({ getParentRoute: () => playerRoute, path: 'settings', component: SettingsPage }),
  ...browseRoutes.map((r) => createRoute({ getParentRoute: () => playerRoute, path: childPath(r.path), component: lazyPage(r.component) })),
];

const routeTree = rootRoute.addChildren([indexRoute, welcomeRoute, addServerRoute, signInRoute, playerRoute.addChildren(playerChildren)]);

export function createAppRouter(services: AppServices) {
  return createRouter({
    routeTree,
    history: createHashHistory(),
    context: { services },
    defaultPreload: false,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export { signedOutTarget };
