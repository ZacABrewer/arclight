import { createRootRouteWithContext, createRoute, createRouter, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { ComingSoon } from './components/coming-soon.js';
import { ErrorView } from './components/error-boundary.js';
import { LoadingBlock } from './components/spinner.js';
import { AppShell } from './layout/app-shell.js';
import { navEntry } from './nav.js';
import { DashboardPage } from './pages/dashboard.js';
import { NotFoundPage } from './pages/not-found.js';
import { SearchPage } from './pages/search.js';
import { SystemHealthPage } from './pages/system/health.js';
import { SystemStatusPage } from './pages/system/status.js';
import { SystemTasksPage } from './pages/system/tasks.js';

// Code-based route tree. To build a real page: replace its `placeholder(...)` with a
// createRoute whose component is the page. The sidebar lives in nav.ts.

export interface RouterContext {
  queryClient: QueryClient;
}

function RouteError({ error, reset }: ErrorComponentProps) {
  return <ErrorView error={error} onRetry={reset} />;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

const page = <TPath extends string>(path: TPath, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const placeholder = <TPath extends string>(path: TPath) =>
  page(path, function Placeholder() {
    const entry = navEntry(path);
    return <ComingSoon title={entry?.label ?? path} {...(entry?.phase ? { phase: entry.phase } : {})} />;
  });

/** Section roots (e.g. /settings) send you to their first child. */
const sectionRedirect = <TPath extends string>(path: TPath, to: AppPathLiteral) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to, replace: true });
    },
  });

// Literal list used by sectionRedirect before the router type exists.
type AppPathLiteral =
  | '/library/tv'
  | '/activity/queue'
  | '/wanted/missing'
  | '/settings/media-management'
  | '/system/status';

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
  component: SearchPage,
});

export const routeTree = rootRoute.addChildren([
  page('/', DashboardPage),
  searchRoute,

  sectionRedirect('/library', '/library/tv'),
  placeholder('/library/tv'),
  placeholder('/library/movies'),

  placeholder('/discover'),
  placeholder('/requests'),
  placeholder('/calendar'),

  sectionRedirect('/activity', '/activity/queue'),
  placeholder('/activity/queue'),
  placeholder('/activity/history'),
  placeholder('/activity/blocklist'),

  sectionRedirect('/wanted', '/wanted/missing'),
  placeholder('/wanted/missing'),
  placeholder('/wanted/cutoff-unmet'),

  placeholder('/subtitles'),
  placeholder('/indexers'),

  sectionRedirect('/settings', '/settings/media-management'),
  placeholder('/settings/media-management'),
  placeholder('/settings/profiles'),
  placeholder('/settings/quality'),
  placeholder('/settings/custom-formats'),
  placeholder('/settings/indexers'),
  placeholder('/settings/download-clients'),
  placeholder('/settings/notifications'),
  placeholder('/settings/general'),

  sectionRedirect('/system', '/system/status'),
  page('/system/status', SystemStatusPage),
  page('/system/tasks', SystemTasksPage),
  placeholder('/system/logs'),
  page('/system/health', SystemHealthPage),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPendingComponent: () => <LoadingBlock />,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFoundPage,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
/** Every concrete path in the app; the sidebar config is typed against it. */
export type AppPath = keyof AppRouter['routesByPath'];

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
