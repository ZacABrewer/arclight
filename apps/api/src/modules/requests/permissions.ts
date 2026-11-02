import { hasAnyPermission, Permission, requestTypesOfSettings, type MediaType, type RequestTypeKey } from '@arclight/shared';
import { RequestsError } from './errors.js';

// Permission rules from docs/spec/requests.md section 3.3, as pure functions over a
// permission bitfield. ADMIN passes everything (hasAnyPermission handles that).

/** Who is calling. `userId` is null for API-key and local-bypass callers, who act as admin. */
export interface Actor {
  userId: number | null;
  permissions: number;
  /** An anonymous visitor of the public portal (no permissions, never a real user). */
  anonymous?: boolean;
}

export const SYSTEM_ACTOR: Actor = { userId: null, permissions: Permission.ADMIN };
/** Public-portal visitors: user id 0 matches nobody's rows. */
export const ANONYMOUS_ACTOR: Actor = { userId: 0, permissions: Permission.NONE, anonymous: true };

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

/** Music and audiobook requests: the general REQUEST flag covers both domains. */
export function canRequestAudio(held: number, domain: 'music' | 'audiobook'): boolean {
  return can(held, Permission.REQUEST, domain === 'music' ? Permission.REQUEST_MUSIC : Permission.REQUEST_AUDIOBOOK);
}

/** Podcast suggestions: any request flag (there is no podcast-specific permission bit). */
export function canSuggestPodcast(held: number): boolean {
  return can(held, Permission.REQUEST, Permission.REQUEST_MUSIC, Permission.REQUEST_AUDIOBOOK);
}

/** Subtitle and audio language requests: the general REQUEST flag covers them too. */
export function canRequestLanguage(held: number): boolean {
  return can(held, Permission.REQUEST, Permission.REQUEST_LANGUAGE);
}

/** Language requests have no auto-approve flags of their own: AUTO_APPROVE or MANAGE_REQUESTS. */
export const canAutoApproveLanguage = (held: number): boolean => can(held, Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS);

/** Audio requests have no per-domain auto-approve flags: AUTO_APPROVE or MANAGE_REQUESTS. */
export const canAutoApproveAudio = (held: number): boolean => can(held, Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS);

export function canAutoRequest(held: number, type: MediaType): boolean {
  return can(held, Permission.AUTO_REQUEST, type === 'movie' ? Permission.AUTO_REQUEST_MOVIE : Permission.AUTO_REQUEST_TV);
}

/** Words for the refusal: "music requests are turned off for this user". */
const REQUEST_TYPE_WORDS: Record<RequestTypeKey, string> = {
  movie: 'movie',
  series: 'series',
  music: 'music',
  audiobook: 'audiobook',
  ebook: 'ebook',
  comic: 'comic',
  subtitles: 'subtitle',
  audioLanguages: 'audio language',
  podcast: 'podcast',
};

/**
 * The per-user request type filter (users.settings.requestTypes): false when the user's filter
 * turns `type` off. It only ever denies; the permission checks above still decide everything
 * else. ADMIN is never filtered; callers without a user row (system, anonymous) pass `settings`
 * as null, which leaves every type on.
 */
export function requestTypeAllowed(user: { permissions: number; settings: unknown }, type: RequestTypeKey): boolean {
  if ((user.permissions & Permission.ADMIN) !== 0) return true;
  return requestTypesOfSettings(user.settings)[type];
}

/** Throws FORBIDDEN when the user's request type filter turns `type` off. */
export function assertRequestTypeAllowed(user: { permissions: number; settings: unknown }, type: RequestTypeKey): void {
  if (!requestTypeAllowed(user, type)) throw RequestsError.forbidden(`${REQUEST_TYPE_WORDS[type]} requests are turned off for this user`);
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
