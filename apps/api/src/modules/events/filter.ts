import { eq } from 'drizzle-orm';
import { Permission, type AppArea, type ServerEvent } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { issues, mediaRequests } from '../../db/schema.js';
import type { RequestAuth } from '../auth/index.js';

// What the live feed (/api/v1/events) may show a caller. Admins (and API-key / bypass callers)
// see every event. Everyone else sees only what their own pages would show: their own requests
// and issues (all of them with the "view all" permissions), and library / activity events for
// the app areas an admin granted them. Every other event type is admin-only, so a new event
// type stays hidden from non-admins until it is listed here.

export interface EventViewer {
  isAdmin: boolean;
  userId: number | null;
  appAccess: readonly AppArea[];
  permissions: number;
}

export function eventViewerOf(auth: RequestAuth): EventViewer {
  return {
    isAdmin: auth.isAdmin,
    userId: auth.user?.id ?? null,
    appAccess: auth.appAccess,
    permissions: (auth.user?.permissions ?? 0) & ~Permission.ADMIN,
  };
}

/** Owner lookups for request and issue events (null: gone or unknown). */
export interface EventOwners {
  requestOwner(id: number): number | null;
  issueOwner(id: number): number | null;
}

export function dbEventOwners(db: Db): EventOwners {
  return {
    requestOwner: (id) => db.select({ by: mediaRequests.requestedById }).from(mediaRequests).where(eq(mediaRequests.id, id)).get()?.by ?? null,
    issueOwner: (id) => db.select({ by: issues.createdById }).from(issues).where(eq(issues.id, id)).get()?.by ?? null,
  };
}

const holds = (v: EventViewer, ...bits: number[]) => bits.some((b) => (v.permissions & b) === b);
const granted = (v: EventViewer, ...areas: AppArea[]) => areas.some((a) => v.appAccess.includes(a));

export function eventVisibleTo(event: ServerEvent, viewer: EventViewer, owners: EventOwners): boolean {
  if (viewer.isAdmin) return true;
  switch (event.type) {
    case 'hello':
      return true;
    case 'request':
      if (holds(viewer, Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW)) return true;
      return viewer.userId !== null && owners.requestOwner(event.id) === viewer.userId;
    case 'issue':
      if (holds(viewer, Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES)) return true;
      return viewer.userId !== null && owners.issueOwner(event.id) === viewer.userId;
    case 'library':
      return granted(viewer, 'library', 'calendar', 'wanted');
    case 'queue':
    case 'download':
    case 'history':
    case 'release':
    case 'import':
      return granted(viewer, 'activity');
    default:
      return false;
  }
}
