import { hasAnyPermission, Permission, type MediaType } from '@media-tron/shared';

// Permission rules from docs/spec/requests.md section 3.3, as pure functions over a
// permission bitfield. ADMIN passes everything (hasAnyPermission handles that).

/** Who is calling. `userId` is null for API-key and local-bypass callers, who act as admin. */
export interface Actor {
  userId: number | null;
  permissions: number;
}

export const SYSTEM_ACTOR: Actor = { userId: null, permissions: Permission.ADMIN };

export function can(actor: Actor | number, ...flags: number[]): boolean {
  const held = typeof actor === 'number' ? actor : actor.permissions;
  return hasAnyPermission(held, flags);
}

export function canRequest(held: number, type: MediaType, is4k: boolean): boolean {
  if (is4k) {
    return can(held, Permission.REQUEST_4K, type === 'movie' ? Permission.REQUEST_4K_MOVIE : Permission.REQUEST_4K_TV);
  }
  return can(held, Permission.REQUEST, type === 'movie' ? Permission.REQUEST_MOVIE : Permission.REQUEST_TV);
}

/** The 4K rule does not accept the non-4K flags and vice versa; MANAGE_REQUESTS satisfies both. */
export function canAutoApprove(held: number, type: MediaType, is4k: boolean): boolean {
  if (is4k) {
    return can(
      held,
      Permission.AUTO_APPROVE_4K,
      type === 'movie' ? Permission.AUTO_APPROVE_4K_MOVIE : Permission.AUTO_APPROVE_4K_TV,
      Permission.MANAGE_REQUESTS,
    );
  }
  return can(held, Permission.AUTO_APPROVE, type === 'movie' ? Permission.AUTO_APPROVE_MOVIE : Permission.AUTO_APPROVE_TV, Permission.MANAGE_REQUESTS);
}

export function canAutoRequest(held: number, type: MediaType): boolean {
  return can(held, Permission.AUTO_REQUEST, type === 'movie' ? Permission.AUTO_REQUEST_MOVIE : Permission.AUTO_REQUEST_TV);
}

export const canManageRequests = (held: number): boolean => can(held, Permission.MANAGE_REQUESTS);
export const canViewAllRequests = (held: number): boolean => can(held, Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW);
export const canRequestAdvanced = (held: number): boolean => can(held, Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED);
export const canManageUsers = (held: number): boolean => can(held, Permission.MANAGE_USERS);
export const canManageSettings = (held: number): boolean => can(held, Permission.MANAGE_SETTINGS);
export const canManageIssues = (held: number): boolean => can(held, Permission.MANAGE_ISSUES);
export const canViewAllIssues = (held: number): boolean => can(held, Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES);
export const canCreateIssues = (held: number): boolean => can(held, Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES);
/** Exempt from quotas (section 4.4). */
export const isQuotaExempt = (held: number): boolean => can(held, Permission.MANAGE_USERS);

/** A user row's effective bits: the role decides ADMIN. */
export function effectivePermissions(row: { role: string; permissions: number }): number {
  return row.role === 'admin' ? row.permissions | Permission.ADMIN : row.permissions & ~Permission.ADMIN;
}
