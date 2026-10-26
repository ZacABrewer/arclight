import { APP_AREAS, Permission, hasAnyPermission, type AppArea, type Session } from '@arclight/shared';

// What the signed-in person may open in the web app, kept free of React. The api is the real
// enforcer (apps/api/src/modules/auth/hook.ts: every route is admin-only unless it opts in);
// this decides which pages and navigation to show and where to send the browser.
//
// Admins see everything. Everyone else lives in the request portal (/portal) and sees, in the
// app, only the read-only areas an admin granted them (Users → edit user → App access), plus
// the request/issue management pages when an admin gave them those permissions.

export interface Access {
  admin: boolean;
  /** Granted read-only app areas (every area for admins). */
  areas: readonly AppArea[];
  /** Permission bits (Permission in @arclight/shared). */
  permissions: number;
}

export const ADMIN_ACCESS: Access = { admin: true, areas: APP_AREAS, permissions: Permission.ADMIN };
export const PORTAL_ACCESS: Access = { admin: false, areas: [], permissions: 0 };

/**
 * Access of a session. No session (the api did not answer /auth/status, or nobody is signed
 * in) is treated like the old fallback, admin: the guard sends anonymous visitors to /login and
 * the api refuses what the caller may not do.
 */
export function accessOf(session: Session | null | undefined): Access {
  if (!session || session.isAdmin) return ADMIN_ACCESS;
  return { admin: false, areas: session.user?.appAccess ?? [], permissions: (session.user?.permissions ?? 0) & ~Permission.ADMIN };
}

/** `true`/`false` (admin or not) as older callers pass it, or a full Access. */
export function toAccess(access: Access | boolean): Access {
  if (typeof access === 'boolean') return access ? ADMIN_ACCESS : PORTAL_ACCESS;
  return access;
}

/** App pages each area opens (read-only; the api refuses writes). */
export const AREA_PATHS: Readonly<Record<AppArea, readonly string[]>> = {
  library: ['/library/tv', '/library/movies', '/library/series', '/library/movie', '/library/collections'],
  calendar: ['/calendar'],
  activity: ['/activity/queue', '/activity/history', '/activity/blocklist'],
  wanted: ['/wanted/missing', '/wanted/cutoff', '/wanted/mismatch'],
};

/** First page of each area, in nav order. */
export const AREA_HOME: Readonly<Record<AppArea, string>> = {
  library: '/library/tv',
  calendar: '/calendar',
  activity: '/activity/queue',
  wanted: '/wanted/missing',
};

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

export const canManageRequestsIn = (a: Access) => a.admin || hasAnyPermission(a.permissions, [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW]);
export const canViewIssuesIn = (a: Access) => a.admin || hasAnyPermission(a.permissions, [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES]);

/** Whether `pathname` (an app page outside the portal) may be shown to this person. */
export function canOpenAppPath(access: Access, pathname: string): boolean {
  if (access.admin) return true;
  if (access.areas.some((a) => AREA_PATHS[a].some((base) => under(pathname, base)))) return true;
  // Request and issue management, for people an admin gave those permissions.
  if (under(pathname, '/requests') && canManageRequestsIn(access)) return true;
  if (under(pathname, '/issues') && canViewIssuesIn(access)) return true;
  // Their own profile inside the app shell, once they have any app page at all.
  if (pathname === '/profile' && hasAppPages(access)) return true;
  return false;
}

/** The person has at least one app page (else the portal is all they get). */
export function hasAppPages(access: Access): boolean {
  return access.admin || access.areas.length > 0 || canManageRequestsIn(access) || canViewIssuesIn(access);
}

/** Where "Open Arclight" goes from the portal: the dashboard for admins, else the first granted page; null: none. */
export function appHomeFor(access: Access): string | null {
  if (access.admin) return '/';
  const area = APP_AREAS.find((a) => access.areas.includes(a));
  if (area) return AREA_HOME[area];
  if (canManageRequestsIn(access)) return '/requests';
  if (canViewIssuesIn(access)) return '/issues';
  return null;
}

/**
 * Where a non-admin goes instead of an app page they may not open: the portal's twin of the
 * page when it has one (discover pages, my requests, issues, profile), else portal home.
 */
export function portalTargetFor(pathname: string): string {
  if (pathname === '/profile') return '/portal/profile';
  if (pathname === '/requests/mine') return '/portal/requests';
  if (under(pathname, '/issues')) return `/portal${pathname}`;
  if (under(pathname, '/discover')) return `/portal${pathname.slice('/discover'.length)}`;
  return '/portal';
}
