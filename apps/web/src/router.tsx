import { Suspense, lazy } from 'react';
import { Outlet, createRootRouteWithContext, createRoute, createRouter, redirect, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

import { ErrorView } from './components/error-boundary.js';
import { Skeleton } from './arclight/index.js';
import { AppShell } from './layout/app-shell.js';
import { AuthProvider } from './auth/auth-context.js';
import { SHELLLESS_PATHS, isPublicPath, loadAuthStatus, resolveAuthRedirect } from './auth/guard.js';
import { LoginPage } from './pages/login.js';
import { SetupWizard } from './pages/setup/setup-wizard.js';
import { SecurityPage } from './pages/settings/security/security-page.js';

import { DashboardPage } from './pages/dashboard.js';
import { NotFoundPage } from './pages/not-found.js';
import { SearchPage } from './pages/search.js';
import { CalendarPage } from './pages/calendar/calendar-page.js';
import { AddNewPage } from './pages/library/add-new.js';
import { MovieLibraryPage, SeriesLibraryPage } from './pages/library/library-index.js';
import { MovieDetailsPage } from './pages/library/movie-details.js';
import { SeriesDetailsPage } from './pages/library/series-details.js';
import { CollectionDetailPage, CollectionsPage } from './pages/library/collections.js';
import { HealthDocsPage } from './pages/docs/health-docs-page.js';
import { SolverSettingsPage } from './pages/settings/solver/solver-page.js';
import { UpdatesSettingsPage } from './pages/settings/updates/updates-settings-page.js';
import { WantedCutoffPage, WantedMismatchPage, WantedMissingPage } from './pages/wanted/wanted-page.js';
import { SystemHealthPage } from './pages/system/health.js';
import { SystemStatusPage } from './pages/system/status.js';
import { SystemTasksPage } from './pages/system/tasks.js';
import { SystemLogsPage } from './pages/system/logs.js';
import { SystemDebuggingPage } from './pages/system/debugging.js';
import { SystemBackupsPage } from './pages/system/backups.js';
import { SystemMigratePage } from './pages/system/migrate.js';
import { SystemUpdatesPage } from './pages/system/updates.js';
import { BlocklistPage } from './pages/activity/blocklist-page.js';
import { HistoryPage } from './pages/activity/history-page.js';
import { parseHistorySearch } from './pages/activity/history-search.js';
import { QueuePage } from './pages/activity/queue-page.js';
import { PendingReleasesPage } from './pages/activity/pending-page.js';
import { ManualImportPage, parseManualImportSearch } from './pages/activity/manual-import/manual-import-page.js';
import { CustomFormatsPage } from './pages/settings/custom-formats/custom-formats-page.js';
import { DownloadClientsPage } from './pages/settings/download-clients/download-clients-page.js';
import { GeneralPage } from './pages/settings/general/general-page.js';
import { IndexersPage } from './pages/settings/indexers/indexers-page.js';
import { IndexerProxiesPage } from './pages/settings/indexer-proxies/indexer-proxies-page.js';
import { IndexerOptionsPage } from './pages/settings/indexer-options/indexer-options-page.js';
import { IndexerCataloguePage } from './pages/settings/indexer-catalogue/indexer-catalogue-page.js';
import { IndexerStatsPage } from './pages/indexers/stats-page.js';
import { MediaManagementPage } from './pages/settings/media-management/media-management-page.js';
import { ImportListsPage } from './pages/settings/import-lists/import-lists-page.js';
import { NotificationsPage } from './pages/settings/notifications/notifications-page.js';
import { ProfilesPage } from './pages/settings/profiles/profiles-page.js';
import { QualityPage } from './pages/settings/quality/quality-page.js';
import { VpnSettingsPage } from './pages/settings/vpn.js';
import { TorrentSettingsPage } from './pages/settings/torrent.js';
import { WantedSubtitlesPage } from './pages/subtitles/wanted-subtitles-page.js';
import { SubtitleHistoryPage } from './pages/subtitles/subtitle-history-page.js';
import { SubtitleBlacklistPage } from './pages/subtitles/subtitle-blacklist-page.js';
import { SubtitleSettingsPage } from './pages/settings/subtitles/subtitle-settings-page.js';
import { DiscoverHomePage } from './pages/discover/discover-home.js';
import { discoverChildren } from './pages/discover/discover-routes.js';
import { RequestsPage } from './pages/requests/requests-page.js';
import { MyRequestsPage } from './pages/requests/my-requests-page.js';
import { WatchlistPage } from './pages/requests/watchlist-page.js';
import { IssueDetailPage, IssuesPage } from './pages/issues/issues-page.js';
import { RequestsSettingsPage } from './pages/settings/requests/requests-settings-page.js';
import { UsersPage } from './pages/settings/users/users-page.js';
import { ProfilePage } from './pages/profile-page.js';
import { GuidesSettingsPage } from './pages/settings/guides/guides-page.js';
import { MediaServersPage } from './pages/settings/media-servers/media-servers-page.js';
import { SystemFeedsPage } from './pages/system/feeds.js';
import { SystemStatsPage } from './pages/system/stats/stats-page.js';
import { SystemAuditPage } from './pages/system/audit/audit-page.js';
import { RetentionPage } from './pages/library/retention/retention-page.js';
import { HygienePage } from './pages/library/hygiene/hygiene-page.js';
import { RequestDeepLinkPage, parseRequestActionSearch } from './pages/requests/request-deep-link.js';
import { CrossSeedSettingsPage } from './pages/settings/cross-seed/cross-seed-settings-page.js';
import { CrossSeedActivityPage } from './pages/activity/cross-seed-page.js';
import { TranscodeSettingsPage } from './pages/settings/transcode/transcode-settings-page.js';
import { TranscodeJobsPage } from './pages/activity/transcode-jobs-page.js';
import { DiscordBotSettingsPage } from './pages/settings/discord-bot/discord-bot-page.js';
import { PortalHomePage, PortalIssueDetailPage, PortalIssuesPage, PortalLayout, PortalProfilePage, PortalRequestsPage } from './pages/portal/portal-page.js';
import { portalOnlyRedirect, portalRewrite } from './features/discover/portal-location.js';
import type { PortalDocument } from '@arclight/shared';
import { TrackerStatsPage } from './pages/indexers/tracker-stats-page.js';

// Code-based route tree. Every page is a createRoute whose component is the page. The
// rail and the section sub-navs live in nav.ts.

export interface RouterContext {
  queryClient: QueryClient;
  /** How this page relates to the request portal (portal paths / hostnames); null: plain app page. */
  portal?: PortalDocument | null;
}

function RouteError({ error, reset }: ErrorComponentProps) {
  return <ErrorView error={error} onRetry={reset} />;
}

/** /login, /setup, /design and the portal draw their own chrome; everything else lives in the app shell. */
function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <AuthProvider>{SHELLLESS_PATHS.has(pathname) || isPublicPath(pathname) ? <Outlet /> : <AppShell />}</AuthProvider>;
}

function PendingPage() {
  return <Skeleton lines={4} />;
}

// The component gallery is only for admins checking the design system: load it on demand.
const LazyDesignPage = lazy(() => import('./pages/design.js').then((m) => ({ default: m.DesignPage })));
function DesignRoute() {
  return (
    <Suspense fallback={<PendingPage />}>
      <LazyDesignPage />
    </Suspense>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  // Guard every navigation: the admin account first (first launch), setup, sign-in, then what
  // the person may open (non-admins: the portal plus any app areas an admin granted).
  beforeLoad: async ({ context, location }) => {
    // A portal-only hostname never shows the app (signed-in admins included).
    const portalOnly = portalOnlyRedirect(context.portal, location.pathname);
    if (portalOnly) throw redirect({ href: portalOnly, replace: true });
    const status = await loadAuthStatus(context.queryClient);
    const search = location.search as Record<string, unknown>;
    const target = resolveAuthRedirect(status, location.pathname, location.href, search['redirect']);
    if (target && target !== location.href) throw redirect({ href: target, replace: true });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // `expired` comes from the 401 handler in main.tsx and shows the "session expired" banner.
  validateSearch: (search: Record<string, unknown>): { redirect?: string; expired?: true } => ({
    ...(typeof search.redirect === 'string' ? { redirect: search.redirect } : {}),
    ...(search.expired === true || search.expired === 1 || search.expired === '1' ? { expired: true as const } : {}),
  }),
  component: LoginPage,
});

const page = <TPath extends string>(path: TPath, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });


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
  | '/wanted/mismatch'
  | '/settings/mediamanagement'
  | '/settings/customformats'
  | '/settings/downloadclients'
  | '/subtitles/wanted'
  | '/system/status';

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
  component: SearchPage,
});

// ?eventType=&seriesId=|episodeId=|movieId= deep links (decision log "View grab in History").
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity/history',
  validateSearch: parseHistorySearch,
  component: HistoryPage,
});

const manualImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity/manual-import',
  validateSearch: parseManualImportSearch,
  component: ManualImportPage,
});

// Discover (pages/discover) in the app, and the same pages in the public request portal.
const discoverRoute = createRoute({ getParentRoute: () => rootRoute, path: '/discover', component: Outlet });
const portalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/portal', component: PortalLayout });
const portalRequestsRoute = createRoute({ getParentRoute: () => portalRoute, path: 'requests', component: PortalRequestsPage });
const portalProfileRoute = createRoute({ getParentRoute: () => portalRoute, path: 'profile', component: PortalProfilePage });
const portalIssuesRoute = createRoute({ getParentRoute: () => portalRoute, path: 'issues', component: PortalIssuesPage });
const portalIssueRoute = createRoute({ getParentRoute: () => portalRoute, path: 'issues/$id', component: PortalIssueDetailPage });

// Notification deep links: /requests/:id?action=approve|decline.
const requestDeepLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/requests/$id',
  validateSearch: parseRequestActionSearch,
  component: RequestDeepLinkPage,
});


export const routeTree = rootRoute.addChildren([
  loginRoute,
  page('/setup', SetupWizard),
  // Public request portal: reachable without signing in (auth/guard.ts PUBLIC_PATHS).
  portalRoute.addChildren([...discoverChildren(() => portalRoute, PortalHomePage), portalRequestsRoute, portalProfileRoute, portalIssuesRoute, portalIssueRoute]),
  page('/', DashboardPage),
  searchRoute,

  // Library (pages/library, pages/calendar, pages/wanted).
  sectionRedirect('/library', '/library/tv'),
  page('/library/tv', SeriesLibraryPage),
  page('/library/movies', MovieLibraryPage),
  page('/library/add', AddNewPage),
  page('/library/series/$id', SeriesDetailsPage),
  page('/library/movie/$id', MovieDetailsPage),
  page('/library/collections', CollectionsPage),
  page('/library/collections/$tmdbId', CollectionDetailPage),
  page('/library/retention', RetentionPage),
  page('/library/hygiene', HygienePage),

  // Discover, requests, issues, watchlist (Phase 4).
  discoverRoute.addChildren(discoverChildren(() => discoverRoute, DiscoverHomePage)),
  page('/requests', RequestsPage),
  page('/requests/mine', MyRequestsPage),
  requestDeepLinkRoute,
  page('/issues', IssuesPage),
  page('/issues/$id', IssueDetailPage),
  page('/watchlist', WatchlistPage),
  page('/profile', ProfilePage),
  page('/calendar', CalendarPage),

  sectionRedirect('/activity', '/activity/queue'),
  // Activity (pages/activity).
  page('/activity/queue', QueuePage),
  historyRoute,
  page('/activity/blocklist', BlocklistPage),
  page('/activity/pending', PendingReleasesPage),
  page('/activity/crossseed', CrossSeedActivityPage),
  page('/activity/transcode', TranscodeJobsPage),
  manualImportRoute,

  sectionRedirect('/wanted', '/wanted/missing'),
  page('/wanted/missing', WantedMissingPage),
  page('/wanted/cutoff', WantedCutoffPage),
  page('/wanted/mismatch', WantedMismatchPage),
  sectionRedirect('/wanted/cutoff-unmet', '/wanted/cutoff'),

  sectionRedirect('/subtitles', '/subtitles/wanted'),
  page('/subtitles/wanted', WantedSubtitlesPage),
  page('/subtitles/history', SubtitleHistoryPage),
  page('/subtitles/blacklist', SubtitleBlacklistPage),
  // Indexers (the list is shared with Settings → Indexers).
  page('/indexers', IndexersPage),
  page('/indexers/stats', IndexerStatsPage),
  page('/indexers/trackers', TrackerStatsPage),

  // Settings (pages/settings). Paths follow the *arr convention (no hyphens); the earlier
  // hyphenated paths redirect so old links keep working.
  sectionRedirect('/settings', '/settings/mediamanagement'),
  page('/settings/mediamanagement', MediaManagementPage),
  page('/settings/profiles', ProfilesPage),
  page('/settings/quality', QualityPage),
  page('/settings/customformats', CustomFormatsPage),
  page('/settings/guides', GuidesSettingsPage),
  page('/settings/mediaservers', MediaServersPage),
  page('/settings/indexers', IndexersPage),
  page('/settings/indexerproxies', IndexerProxiesPage),
  page('/settings/indexeroptions', IndexerOptionsPage),
  page('/settings/indexercatalogue', IndexerCataloguePage),
  page('/settings/downloadclients', DownloadClientsPage),
  page('/settings/importlists', ImportListsPage),
  page('/settings/notifications', NotificationsPage),
  page('/settings/general', GeneralPage),
  page('/settings/security', SecurityPage),
  page('/settings/requests', RequestsSettingsPage),
  page('/settings/users', UsersPage),
  page('/settings/vpn', VpnSettingsPage),
  page('/settings/torrent', TorrentSettingsPage),
  page('/settings/crossseed', CrossSeedSettingsPage),
  page('/settings/transcode', TranscodeSettingsPage),
  page('/settings/discordbot', DiscordBotSettingsPage),
  page('/settings/subtitles', SubtitleSettingsPage),
  page('/settings/solver', SolverSettingsPage),
  page('/settings/updates', UpdatesSettingsPage),
  sectionRedirect('/settings/media-management', '/settings/mediamanagement'),
  sectionRedirect('/settings/custom-formats', '/settings/customformats'),
  sectionRedirect('/settings/download-clients', '/settings/downloadclients'),

  sectionRedirect('/system', '/system/status'),
  page('/system/status', SystemStatusPage),
  page('/system/tasks', SystemTasksPage),
  page('/system/logs', SystemLogsPage),
  page('/system/debugging', SystemDebuggingPage),
  page('/system/backup', SystemBackupsPage),
  page('/system/health', SystemHealthPage),
  page('/system/migrate', SystemMigratePage),
  page('/system/updates', SystemUpdatesPage),
  page('/system/feeds', SystemFeedsPage),
  page('/system/stats', SystemStatsPage),
  page('/system/audit', SystemAuditPage),
  // In-app health check docs: the health checks' wikiUrl links point here.
  page('/docs/system/health', HealthDocsPage),

  // Component gallery (admins; rendered without the shell, loaded on demand).
  page('/design', DesignRoute),
]);

export function createAppRouter(queryClient: QueryClient, portal: PortalDocument | null = null) {
  const rewrite = portalRewrite(portal);
  return createRouter({
    routeTree,
    context: { queryClient, portal },
    ...(rewrite ? { rewrite } : {}),
    defaultPreload: 'intent',
    defaultPendingComponent: PendingPage,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFoundPage,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
/**
 * Every concrete path in the app; the sidebar config is typed against it. Index routes of
 * layout routes (/discover/, /portal/) are reached through their parent path.
 */
export type AppPath = Exclude<keyof AppRouter['routesByPath'], `${string}/`> | '/';

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
