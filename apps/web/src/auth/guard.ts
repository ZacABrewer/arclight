import type { QueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@arclight/shared';
import { authApi } from '../api/auth.js';

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

/** Sections only admins may open; users are sent home. */
export const ADMIN_ONLY_PREFIXES: readonly string[] = ['/settings', '/system', '/activity', '/indexers', '/subtitles'];

export function isAdminOnlyPath(pathname: string): boolean {
  return ADMIN_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** A redirect target taken from the query string: same-origin app paths only. */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return '/';
  if ((target.split('?')[0] ?? '') === '/login') return '/';
  return target;
}

export function loginHref(returnTo: string): string {
  return returnTo === '/' ? '/login' : `/login?redirect=${encodeURIComponent(returnTo)}`;
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
  if (status.needsSetup) {
    // During setup /login stays reachable so an admin who lost the cookie can resume.
    if (pathname === '/setup' || pathname === '/login') return null;
    return '/setup';
  }
  if (pathname === '/setup') return '/';
  if (!status.authenticated) return pathname === '/login' ? null : loginHref(href);
  if (pathname === '/login') return safeRedirect(redirectParam);
  if (status.session && !status.session.isAdmin && isAdminOnlyPath(pathname)) return '/';
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
