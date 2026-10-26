import { Outlet, createRootRouteWithContext, createRoute, createRouter, redirect, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { ComingSoon } from './components/coming-soon.js';
import { ErrorView } from './components/error-boundary.js';
import { LoadingBlock } from './components/spinner.js';
import { AppShell } from './layout/app-shell.js';
import { AuthProvider } from './auth/auth-context.js';
import { BARE_PATHS, loadAuthStatus, resolveAuthRedirect } from './auth/guard.js';
import { LoginPage } from './pages/login.js';
import { SetupWizard } from './pages/setup/setup-wizard.js';
import { SecurityPage } from './pages/settings/security/security-page.js';
import { navEntry } from './nav.js';
import { DashboardPage } from './pages/dashboard.js';
import { NotFoundPage } from './pages/not-found.js';
import { SearchPage } from './pages/search.js';
import { CalendarPage } from './pages/calendar/calendar-page.js';
import { AddNewPage } from './pages/library/add-new.js';
import { MovieLibraryPage, SeriesLibraryPage } from './pages/library/library-index.js';
import { MovieDetailsPage } from './pages/library/movie-details.js';
import { SeriesDetailsPage } from './pages/library/series-details.js';
import { WantedCutoffPage, WantedMissingPage } from './pages/wanted/wanted-page.js';
import { SystemHealthPage } from './pages/system/health.js';
import { SystemStatusPage } from './pages/system/status.js';
import { SystemTasksPage } from './pages/system/tasks.js';
import { SystemLogsPage } from './pages/system/logs.js';
import { BlocklistPage } from './pages/activity/blocklist-page.js';
import { HistoryPage } from './pages/activity/history-page.js';
import { QueuePage } from './pages/activity/queue-page.js';
import { CustomFormatsPage } from './pages/settings/custom-formats/custom-formats-page.js';
import { DownloadClientsPage } from './pages/settings/download-clients/download-clients-page.js';
import { GeneralPage } from './pages/settings/general/general-page.js';
import { IndexersPage } from './pages/settings/indexers/indexers-page.js';
import { MediaManagementPage } from './pages/settings/media-management/media-management-page.js';
import { NotificationsPage } from './pages/settings/notifications/notifications-page.js';
import { ProfilesPage } from './pages/settings/profiles/profiles-page.js';
import { QualityPage } from './pages/settings/quality/quality-page.js';
import { VpnSettingsPage } from './pages/settings/vpn.js';

// Code-based route tree. To build a real page: replace its `placeholder(...)` with a
// createRoute whose component is the page. The sidebar lives in nav.ts.

export interface RouterContext {
  queryClient: QueryClient;
}

function RouteError({ error, reset }: ErrorComponentProps) {
  return <ErrorView error={error} onRetry={reset} />;
}

/** /login and /setup render bare; everything else inside the app shell. */
function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <AuthProvider>{BARE_PATHS.has(pathname) ? <Outlet /> : <AppShell />}</AuthProvider>;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  // Guard every navigation: setup first, then sign-in, then admin-only sections.
  beforeLoad: async ({ context, location }) => {
    const status = await loadAuthStatus(context.queryClient);
    const search = location.search as Record<string, unknown>;
    const target = resolveAuthRedirect(status, location.pathname, location.href, search['redirect']);
    if (target && target !== location.href) throw redirect({ href: target, replace: true });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: LoginPage,
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
  | '/wanted/cutoff'
  | '/settings/mediamanagement'
  | '/settings/customformats'
  | '/settings/downloadclients'
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
  loginRoute,
  page('/setup', SetupWizard),
  page('/', DashboardPage),
  searchRoute,

  // Library (pages/library, pages/calendar, pages/wanted).
  sectionRedirect('/library', '/library/tv'),
  page('/library/tv', SeriesLibraryPage),
  page('/library/movies', MovieLibraryPage),
  page('/library/add', AddNewPage),
  page('/library/series/$id', SeriesDetailsPage),
  page('/library/movie/$id', MovieDetailsPage),

  placeholder('/discover'),
  placeholder('/requests'),
  page('/calendar', CalendarPage),

  sectionRedirect('/activity', '/activity/queue'),
  // Activity (pages/activity).
  page('/activity/queue', QueuePage),
  page('/activity/history', HistoryPage),
  page('/activity/blocklist', BlocklistPage),

  sectionRedirect('/wanted', '/wanted/missing'),
  page('/wanted/missing', WantedMissingPage),
  page('/wanted/cutoff', WantedCutoffPage),
  sectionRedirect('/wanted/cutoff-unmet', '/wanted/cutoff'),

  placeholder('/subtitles'),
  placeholder('/indexers'),

  // Settings (pages/settings). Paths follow the *arr convention (no hyphens); the earlier
  // hyphenated paths redirect so old links keep working.
  sectionRedirect('/settings', '/settings/mediamanagement'),
  page('/settings/mediamanagement', MediaManagementPage),
  page('/settings/profiles', ProfilesPage),
  page('/settings/quality', QualityPage),
  page('/settings/customformats', CustomFormatsPage),
  page('/settings/indexers', IndexersPage),
  page('/settings/downloadclients', DownloadClientsPage),
  page('/settings/notifications', NotificationsPage),
  page('/settings/general', GeneralPage),
  page('/settings/security', SecurityPage),
  page('/settings/vpn', VpnSettingsPage),
  sectionRedirect('/settings/media-management', '/settings/mediamanagement'),
  sectionRedirect('/settings/custom-formats', '/settings/customformats'),
  sectionRedirect('/settings/download-clients', '/settings/downloadclients'),

  sectionRedirect('/system', '/system/status'),
  page('/system/status', SystemStatusPage),
  page('/system/tasks', SystemTasksPage),
  page('/system/logs', SystemLogsPage),
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
