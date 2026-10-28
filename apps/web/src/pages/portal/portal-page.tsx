import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import type { DiscoverItem, PortalDocument, PublicPortal } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { kindOf, publicPortalApi } from '../../api/requests.js';
import { Backdrop, Button, EmptyState, ErrorBlock, Icon, Mark, Pane, Popover, Skeleton, buttonClass, type IconName } from '../../arclight/index.js';
import { ThemeChoice } from '../../features/themes/theme-choice.js';
import { useThemeCatalog } from '../../features/themes/use-themes.js';
import { useAuth } from '../../auth/auth-context.js';
import { DLink, DiscoverBaseProvider, type DiscoverPath } from '../../features/discover/base.js';
import { PORTAL_ROOT } from '../../features/discover/portal-location.js';
import { DiscoverSliders, BrowseLinks } from '../discover/discover-home.js';
import { DiscoverSearchBox } from '../discover/discover-search.js';
import { MyRequestsPage } from '../requests/my-requests-page.js';
import { ProfilePage } from '../profile-page.js';
import { IssueDetailPage, IssuesPage } from '../issues/issues-page.js';
import { ADMIN_ACCESS, appHomeFor, type Access } from '../../auth/access.js';
import '../../components/media/media-kit.css';
import '../discover/discover.css';
import './portal.css';
import { t } from '../../i18n/index.js';

// Public request portal: the full Discover catalogue (home sliders, browse, search, title,
// person and collection pages) and "My requests" in the portal's own chrome, without the app
// shell. It answers at /portal, at every extra portal path and at the root of portal
// hostnames (Settings > Requests > Public request portal; features/discover/portal-location.ts).
// Anonymous visitors browse when the admin allows it; requesting always needs sign-in.

export const portalKeys = {
  portal: ['public', 'portal'] as const,
};

/** The app path of a title page (outside the portal). */
export function titlePath(item: Pick<DiscoverItem, 'mediaType' | 'tmdbId'>): string {
  return `/discover/${kindOf(item.mediaType)}/${item.tmdbId}`;
}

export interface PortalLoginOption {
  id: 'local' | 'jellyfin' | 'emby' | 'plex';
  label: string;
}

/** Sign-in buttons for the portal's login methods (each goes to /login, which offers them). */
export function portalLoginOptions(methods: PublicPortal['loginMethods']): PortalLoginOption[] {
  const out: PortalLoginOption[] = [];
  if (methods.local) out.push({ id: 'local', label: t('portal.signInLocal') });
  const server = methods.mediaServer;
  if (server && (server.kind === 'jellyfin' || server.kind === 'emby')) {
    const name = server.name || (server.kind === 'jellyfin' ? t('common.jellyfin') : t('common.emby'));
    out.push({ id: server.kind, label: t('portal.signInWith', { name }) });
  }
  if (methods.plex || server?.kind === 'plex') out.push({ id: 'plex', label: t('portal.signInWith', { name: t('common.plex') }) });
  return out;
}

/** Why the portal cannot be shown: off (401/403/404 from the api) or another failure. */
export function portalUnavailable(err: unknown): 'off' | 'error' {
  return err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404) ? 'off' : 'error';
}

/**
 * Where "Open Arclight" goes from a portal page (a full page load, which leaves portal mode), or
 * null: on a portal-only hostname, and for people without any app page (the portal is all a
 * non-admin gets unless an admin granted app access).
 */
export function openAppHref(doc: PortalDocument | null | undefined, access: Access = ADMIN_ACCESS): string | null {
  if (doc?.mode === 'host' && doc.portalOnly) return null;
  if (!access.admin) return appHomeFor(access);
  if (!doc || doc.mode === 'path') return '/';
  return '/discover';
}

/** What a signed-in person sees when /public/portal did not answer. */
const SIGNED_IN_FALLBACK: PublicPortal = {
  enabled: true,
  title: '',
  applicationUrl: '',
  message: '',
  allowAnonymousDiscover: false,
  loginMethods: { local: true, mediaServer: null, plex: false },
};

function usePortal() {
  return useQuery({ queryKey: portalKeys.portal, queryFn: publicPortalApi.get, retry: false, staleTime: 60_000 });
}

function useSignedIn(): boolean {
  return useAuth().status?.authenticated ?? false;
}

/** /login, coming back to the current portal page afterwards. */
function SignInLink({ variant = 'primary', block, children }: { variant?: 'primary' | 'secondary'; block?: boolean; children: ReactNode }) {
  const href = useRouterState({ select: (s) => s.location.href });
  return (
    <Link to="/login" search={{ redirect: href }} className={buttonClass({ variant, ...(block ? { block } : {}) })}>
      {children}
    </Link>
  );
}

const NAV: ReadonlyArray<{ to: DiscoverPath; label: () => string; icon: IconName; signedIn?: boolean }> = [
  { to: '', label: () => t('portal.navHome'), icon: 'home' },
  { to: '/movies', label: () => t('common.movies'), icon: 'film' },
  { to: '/tv', label: () => t('common.series'), icon: 'tv' },
  { to: '/search', label: () => t('common.search'), icon: 'search' },
  { to: '/requests', label: () => t('common.myRequests'), icon: 'inbox', signedIn: true },
  { to: '/issues', label: () => t('common.issues'), icon: 'alert', signedIn: true },
  { to: '/profile', label: () => t('portal.navAccount'), icon: 'user', signedIn: true },
];

/** The nav entry a portal route path belongs to. */
export function portalSection(pathname: string): DiscoverPath {
  const rest = pathname.slice(PORTAL_ROOT.length);
  if (rest === '' || rest === '/') return '';
  if (rest.startsWith('/movies')) return '/movies';
  if (rest === '/tv' || rest.startsWith('/tv?')) return '/tv';
  if (rest.startsWith('/search')) return '/search';
  if (rest.startsWith('/requests')) return '/requests';
  if (rest.startsWith('/profile')) return '/profile';
  if (rest.startsWith('/issues')) return '/issues';
  return '/movies';
}

/** Layout of every /portal page: header, gate, page, mobile tab bar. */
export function PortalLayout() {
  const signedIn = useSignedIn();
  const { logout, access } = useAuth();
  const portal = usePortal();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const title = portal.data?.title || t('common.arclight');
  const appHref = openAppHref((useRouter().options.context as { portal?: PortalDocument | null } | undefined)?.portal, access);

  useEffect(() => {
    document.title = t('portal.documentTitle', { title });
  }, [title]);

  // "Public portal off" only hides the portal from anonymous visitors: signed-in people always
  // have it (for non-admins it is the whole app).
  const off = !signedIn && (portal.isError || (portal.data !== undefined && !portal.data.enabled));
  const isHome = pathname === PORTAL_ROOT || pathname === `${PORTAL_ROOT}/`;
  const gated = portal.data && !signedIn && !portal.data.allowAnonymousDiscover && !isHome;
  const section = portalSection(pathname);
  const nav = NAV.filter((n) => !n.signedIn || signedIn);

  return (
    <DiscoverBaseProvider base="/portal">
      <div className="al-app portal">
        <Backdrop vx={0.5} horizon={0.62} />
        <header className="portal-head">
          <DLink to="" className="portal-brand" aria-label={t('portal.homeLink', { title })}>
            <Mark size={32} />
            <span className="al-title-m portal-title">{title}</span>
          </DLink>
          {!off ? (
            <nav className="portal-nav" aria-label={t('portal.navigation')}>
              {nav.map((n) => (
                <DLink key={n.to} to={n.to} className="portal-nav__link" aria-current={section === n.to ? 'page' : undefined}>
                  {n.label()}
                </DLink>
              ))}
            </nav>
          ) : null}
          <div className="portal-head__end">
            {!off && (signedIn || portal.data?.allowAnonymousDiscover) ? (
              <div className="portal-head__search">
                <DiscoverSearchBox />
              </div>
            ) : null}
            <PortalThemeMenu />
            {signedIn ? (
              <>
                {appHref ? (
                  <a href={appHref} className={buttonClass({ variant: 'ghost' })}>
                    {t('portal.openApp')}
                  </a>
                ) : null}
                <Button variant="ghost" onClick={() => void logout()}>
                  {t('portal.signOut')}
                </Button>
              </>
            ) : (
              <SignInLink>{t('portal.signIn')}</SignInLink>
            )}
          </div>
        </header>
        <main className="portal-main">
          {portal.isPending && !signedIn ? (
            <Skeleton lines={6} />
          ) : off ? (
            <PortalOff reason={portal.isError ? portalUnavailable(portal.error) : 'off'} error={portal.error} />
          ) : gated ? (
            <Pane chamfer="tl" strong className="portal-card" aria-label={t('portal.signInTitle')}>
              <EmptyState title={t('portal.discoverNeedsSignIn')} action={<SignInLink>{t('portal.signIn')}</SignInLink>}>
                {t('portal.gatedHelp')}
              </EmptyState>
            </Pane>
          ) : (
            <Outlet />
          )}
        </main>
        {!off ? (
          <nav className="al-tabbar portal-tabbar" aria-label={t('portal.tabs')}>
            {nav.map((n) => (
              <DLink key={n.to} to={n.to} className="al-tabbar__item" aria-current={section === n.to ? 'page' : undefined}>
                <span className="al-tabbar__bar" aria-hidden="true" />
                <Icon name={n.icon} size={20} />
                <span>{n.label()}</span>
              </DLink>
            ))}
          </nav>
        ) : null}
      </div>
    </DiscoverBaseProvider>
  );
}

/** Theme cards in a popover; hidden while there is only the built-in theme or users may not choose. */
function PortalThemeMenu() {
  const { isAdmin } = useAuth();
  const catalog = useThemeCatalog();
  if (!catalog.data || catalog.data.themes.length < 2 || (!catalog.data.allowUserChoice && !isAdmin)) return null;
  return (
    <Popover
      placement="bottom-end"
      width={380}
      label={t('portal.theme')}
      trigger={(props) => (
        <Button variant="ghost" aria-label={t('portal.theme')} title={t('portal.theme')} {...props}>
          <Icon name="palette" size={20} />
        </Button>
      )}
    >
      <div className="portal-theme">
        <p className="al-label">{t('portal.theme')}</p>
        <ThemeChoice />
      </div>
    </Popover>
  );
}

function PortalOff({ reason, error }: { reason: 'off' | 'error'; error: unknown }) {
  return (
    <Pane chamfer="both" strong className="portal-card" aria-label={t('portal.title')}>
      {reason === 'off' ? (
        <EmptyState
          title={t('portal.offTitle')}
          action={
            <Link to="/login" className={buttonClass({ variant: 'primary' })}>
              {t('portal.signIn')}
            </Link>
          }
        >
          {t('portal.offHelp')}
        </EmptyState>
      ) : (
        <ErrorBlock title={t('portal.couldNotLoad')}>{errorMessage(error)}</ErrorBlock>
      )}
    </Pane>
  );
}

/** Portal home: welcome and sign-in, then the Discover sliders. */
export function PortalHomePage() {
  const portal = usePortal();
  const signedIn = useSignedIn();
  // Signed-in people always get their portal, even when the descriptor did not load.
  const data = portal.data ?? (signedIn ? SIGNED_IN_FALLBACK : null);
  if (!data) return null;
  const logins = portalLoginOptions(data.loginMethods);
  const browse = signedIn || data.allowAnonymousDiscover;
  return (
    <div className="portal-stack">
      <div className={signedIn ? 'portal-top portal-top--single' : 'portal-top'}>
        <Pane chamfer="tl" strong className="portal-card" aria-label={t('portal.welcome')}>
          <p className="al-label portal-kicker">{t('portal.kicker')}</p>
          <h1 className="al-title-l portal-heading">{data.title || t('common.arclight')}</h1>
          <p className="portal-message">{data.message || (signedIn ? t('portal.signedInHelp') : t('portal.defaultMessage'))}</p>
          {browse ? (
            <div className="portal-links">
              <BrowseLinks />
            </div>
          ) : null}
        </Pane>
        {!signedIn ? (
          <Pane title={t('portal.signInTitle')} aria-label={t('portal.signInTitle')}>
            <ul className="portal-logins" aria-label={t('portal.loginMethods')}>
              {logins.map((o, i) => (
                <li key={o.id}>
                  <SignInLink variant={i === 0 ? 'primary' : 'secondary'} block>
                    {o.label}
                  </SignInLink>
                </li>
              ))}
            </ul>
            {browse ? <p className="al-caption portal-note">{t('portal.requestNeedsSignIn')}</p> : null}
          </Pane>
        ) : null}
      </div>
      {browse ? <DiscoverSliders /> : <p className="al-caption portal-note">{t('portal.discoverNeedsSignIn')}</p>}
    </div>
  );
}

/** Portal "Issues": the signed-in user's issues (everyone's with the issue permissions). */
export function PortalIssuesPage() {
  const signedIn = useSignedIn();
  if (!signedIn) {
    return (
      <Pane chamfer="tl" strong className="portal-card" aria-label={t('common.issues')}>
        <EmptyState title={t('portal.issuesNeedSignIn')} action={<SignInLink>{t('portal.signIn')}</SignInLink>}>
          {t('portal.requestsNeedSignInHelp')}
        </EmptyState>
      </Pane>
    );
  }
  return <IssuesPage />;
}

/** Portal issue thread (sign-in prompt for anonymous visitors). */
export function PortalIssueDetailPage() {
  const signedIn = useSignedIn();
  if (!signedIn) return <PortalIssuesPage />;
  return <IssueDetailPage />;
}

/** Portal "Account": the signed-in user's profile (password, linked accounts, notifications). */
export function PortalProfilePage() {
  const signedIn = useSignedIn();
  if (!signedIn) {
    return (
      <Pane chamfer="tl" strong className="portal-card" aria-label={t('portal.navAccount')}>
        <EmptyState title={t('portal.accountNeedsSignIn')} action={<SignInLink>{t('portal.signIn')}</SignInLink>}>
          {t('portal.requestsNeedSignInHelp')}
        </EmptyState>
      </Pane>
    );
  }
  return <ProfilePage />;
}

/** Portal "My requests": the signed-in user's requests (sign-in prompt otherwise). */
export function PortalRequestsPage() {
  const signedIn = useSignedIn();
  if (!signedIn) {
    return (
      <Pane chamfer="tl" strong className="portal-card" aria-label={t('common.myRequests')}>
        <EmptyState title={t('portal.requestsNeedSignIn')} action={<SignInLink>{t('portal.signIn')}</SignInLink>}>
          {t('portal.requestsNeedSignInHelp')}
        </EmptyState>
      </Pane>
    );
  }
  return <MyRequestsPage />;
}
