import type { QueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@arclight/shared';
import { authApi } from '../api/auth.js';
import { PORTAL_ACCESS, accessOf, canOpenAppPath, portalTargetFor, type Access } from './access.js';

// Route guard logic, kept free of React so it can be tested on its own. The api is the real
// enforcer (every /api/v1 route checks the session); this only decides where the browser
// should be.

export const authKeys = {
  all: ['auth'] as const,
  status: ['auth', 'status'] as const,
  me: ['auth', 'me'] as const,
  sessions: ['auth', 'sessions'] as const,
  setup: ['auth', 'setup'] as const,
  users: ['auth', 'users'] as const,
  security: ['auth', 'security'] as const,
};

/** Pages rendered without the app shell and reachable before sign-in. */
export const BARE_PATHS: ReadonlySet<string> = new Set(['/login', '/setup']);

/**
 * Pages anyone may open, signed in or not, once setup is done (the public request portal).
 * They render without the app shell; the api decides what an anonymous visitor may read.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/portal']);

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Every page of the portal (/portal/movie/603, /portal/search, ...).
  return [...PUBLIC_PATHS].some((p) => pathname.startsWith(`${p}/`));
}

/** Pages that draw their own chrome (the component gallery renders a full demo shell). */
export const SHELLLESS_PATHS: ReadonlySet<string> = new Set([...BARE_PATHS, ...PUBLIC_PATHS, '/design']);

/**
 * App pages a non-admin may open: only the granted app areas (and request/issue management
 * with those permissions). Everything else, the dashboard included, sends them to the portal.
 */
export function isAdminOnlyPath(pathname: string, access: Access = PORTAL_ACCESS): boolean {
  return !canOpenAppPath(access, pathname);
}

/** A redirect target taken from the query string: same-origin app paths only. */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return '/';
  if ((target.split('?')[0] ?? '') === '/login') return '/';
  return target;
}

/** /login, returning to `returnTo`; `expired` shows the "session expired" banner (Page 07). */
export function loginHref(returnTo: string, expired = false): string {
  const params: string[] = [];
  if (returnTo !== '/') params.push(`redirect=${encodeURIComponent(returnTo)}`);
  if (expired) params.push('expired=1');
  return params.length ? `/login?${params.join('&')}` : '/login';
}

/**
 * Where to send the browser for `status` at `pathname` (`href` includes the query string and
 * is what /login returns to). null: stay. A null status means the api did not answer
 * /auth/status; the page is then shown and the api decides each call.
 */
export function resolveAuthRedirect(
  status: AuthStatus | null,
  pathname: string,
  href: string = pathname,
  redirectParam?: unknown,
): string | null {
  if (!status) return null;
  // First launch: until the admin account exists the setup wizard is the only page.
  if (!status.adminExists) return pathname === '/setup' ? null : '/setup';
  if (status.needsSetup) {
    // During setup /login stays reachable so an admin who lost the cookie can resume. The
    // public portal has nothing to show before setup, so it goes to /setup like the rest.
    if (pathname === '/setup' || pathname === '/login') return null;
    return '/setup';
  }
  if (pathname === '/setup') return '/';
  // Public pages stay put for everyone (signed-in users may still look at the portal).
  if (isPublicPath(pathname)) return null;
  if (!status.authenticated) return pathname === '/login' ? null : loginHref(href);
  const access = accessOf(status.session);
  if (pathname === '/login') {
    const target = safeRedirect(redirectParam);
    // Non-admins land in the portal unless they were headed for a page they may open.
    return access.admin || (target !== '/' && canOpenAppPath(access, target.split('?')[0] ?? '')) ? target : '/portal';
  }
  // Non-admins never see the dashboard or an admin page: the portal is their home.
  if (!canOpenAppPath(access, pathname)) return portalTargetFor(pathname);
  return null;
}

export const authStatusQuery = {
  queryKey: authKeys.status,
  queryFn: authApi.status,
  staleTime: 30_000,
  retry: false,
} as const;

/** Cached auth status for route guards; null when the api does not answer it. */
export async function loadAuthStatus(queryClient: QueryClient): Promise<AuthStatus | null> {
  try {
    return await queryClient.fetchQuery(authStatusQuery);
  } catch {
    return null;
  }
}
