import { APP_AREAS, type AppArea } from './auth.js';
import { Permission, hasAnyPermission } from './requests.js';

// Who may open what, shared by the web app (apps/web/src/auth/access.ts) and the api
// (GET /playback/me fills `appHome` and `canRequest` for the phone and TV apps, which hold no
// session permissions). The api's route guards stay the real enforcer.

/** First app page of each read-only area, in nav order. */
export const APP_AREA_HOME: Readonly<Record<AppArea, string>> = {
  library: '/library/tv',
  calendar: '/calendar',
  activity: '/activity/queue',
  wanted: '/wanted/missing',
};

/** Permissions that open the request pages in the app (manage, or view everyone's). */
export const MANAGE_REQUEST_PERMISSIONS: readonly number[] = [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW];
/** Permissions that open the issues pages in the app. */
export const VIEW_ISSUE_PERMISSIONS: readonly number[] = [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES];
/** Any one of these lets a person ask for something in the request portal. */
export const REQUEST_PERMISSIONS: readonly number[] = [
  Permission.REQUEST,
  Permission.REQUEST_MOVIE,
  Permission.REQUEST_TV,
  Permission.REQUEST_MUSIC,
  Permission.REQUEST_AUDIOBOOK,
];

/**
 * Where "Open Arclight" goes: the dashboard for admins, else the first granted area, else the
 * request or issue pages the person may manage; null: no app pages at all (portal and player only).
 */
export function appHomeOf(admin: boolean, areas: readonly AppArea[], permissions: number): string | null {
  if (admin || (permissions & Permission.ADMIN) !== 0) return '/';
  const area = APP_AREAS.find((a) => areas.includes(a));
  if (area) return APP_AREA_HOME[area];
  if (hasAnyPermission(permissions, MANAGE_REQUEST_PERMISSIONS)) return '/requests';
  if (hasAnyPermission(permissions, VIEW_ISSUE_PERMISSIONS)) return '/issues';
  return null;
}

/** May request something (any request permission, or ADMIN). */
export function canRequest(permissions: number): boolean {
  return hasAnyPermission(permissions, REQUEST_PERMISSIONS);
}
