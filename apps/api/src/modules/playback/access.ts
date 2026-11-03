import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { PlayerAccess, type PlayerCapabilities, type PlayerSettings } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { credentialsOf } from '../auth/hook.js';
import { sessions, userApiKeys } from '../auth/schema.js';
import { appDevices } from '../app-auth/schema.js';
import { householdProfiles } from '../households/schema.js';
import { allLocal } from '../auth/network.js';
import { getSection } from '../settings/service.js';

// Who may use the player. The player is on only when an admin enabled it (Settings → Player); then
// admins always may play and other users need `users.settings.player.allowed`. Requests from
// outside the home network (auth/network.ts) also need remote streaming allowed server-wide and
// for the user. Every /playback and /stream route runs this check; GET /playback/me reports it.

export type PlayerDenial = 'PLAYER_DISABLED' | 'PLAYER_NOT_ALLOWED' | 'REMOTE_NOT_ALLOWED' | 'NO_USER';

export const DENIAL_MESSAGES: Record<PlayerDenial, string> = {
  PLAYER_DISABLED: 'the player is turned off (Settings → Player)',
  PLAYER_NOT_ALLOWED: 'your account may not use the player; ask an admin to allow it',
  REMOTE_NOT_ALLOWED: 'playing from outside the home network is not allowed for your account',
  NO_USER: 'this request is not signed in as a user',
};

/** What the player decided for one request. */
export interface PlayerDecision {
  enabled: boolean;
  allowed: boolean;
  remote: boolean;
  canStream: boolean;
  /** Effective bitrate cap in kbps; 0: none. */
  maxBitrateKbps: number;
  denial: PlayerDenial | null;
}

/** Who is asking: the signed-in user, or an admin credential without a user (API key, bypass). */
export interface PlayerSubject {
  userId: number | null;
  isAdmin: boolean;
  /** users.settings of the user (null without one). */
  settings: unknown;
}

export function playerSettings(db: Db): PlayerSettings {
  return getSection(db, 'player');
}

/** The stored per-user access; absent or invalid: none. */
export function playerAccessOf(settings: unknown): PlayerAccess | null {
  const raw = ((settings ?? {}) as Record<string, unknown>)['player'];
  if (raw === undefined || raw === null) return null;
  const parsed = PlayerAccess.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the request came from outside the home network (any hop not local). */
export function isRemoteRequest(req: FastifyRequest): boolean {
  return !allLocal(credentialsOf(req).addresses);
}

/** The smaller of two bitrate caps where 0 means "no cap". */
export function stricterCap(a: number, b: number): number {
  if (a > 0 && b > 0) return Math.min(a, b);
  return a > 0 ? a : b > 0 ? b : 0;
}

/** The pure access rule (tests drive it directly). */
export function decide(settings: PlayerSettings, subject: PlayerSubject, remote: boolean): PlayerDecision {
  const access = subject.isAdmin ? null : playerAccessOf(subject.settings);
  const allowed = subject.isAdmin || access?.allowed === true;
  const userCap = access?.maxBitrateKbps ?? 0;
  // Remote: the stricter of the user's cap and the server-wide remote cap (0 on either: none).
  const maxBitrateKbps = remote ? stricterCap(userCap, settings.remoteMaxBitrateKbps) : userCap;
  let denial: PlayerDenial | null = null;
  if (!settings.enabled) denial = 'PLAYER_DISABLED';
  else if (!allowed) denial = 'PLAYER_NOT_ALLOWED';
  else if (remote && (!settings.allowRemote || (!subject.isAdmin && access?.allowRemote === false))) denial = 'REMOTE_NOT_ALLOWED';
  return { enabled: settings.enabled, allowed: settings.enabled && allowed, remote, canStream: denial === null, maxBitrateKbps, denial };
}

export function subjectOf(req: FastifyRequest): PlayerSubject {
  const auth = req.auth;
  // Player access is the account's: a non-owner household profile is masked to a plain user
  // (auth/service withProfile) but keeps its account's player permission (accountIsAdmin).
  return { userId: auth?.user?.id ?? null, isAdmin: auth?.accountIsAdmin ?? auth?.isAdmin ?? false, settings: auth?.user?.settings ?? null };
}

export function capabilitiesOf(db: Db, decision: PlayerDecision): PlayerCapabilities {
  const features = getSection(db, 'features');
  const on = decision.allowed;
  return {
    enabled: decision.enabled,
    allowed: decision.allowed,
    remote: decision.remote,
    canStream: decision.canStream,
    maxBitrateKbps: decision.maxBitrateKbps,
    sections: {
      music: on && features.music,
      audiobooks: on && features.audiobooks,
      podcasts: on && features.podcasts,
      books: on && features.books === true,
      video: on && playerSettings(db).video,
    },
    playerUrl: null,
    portalUrl: null,
    canRequest: false,
    appHome: null,
  };
}

const decisions = new WeakMap<FastifyRequest, PlayerDecision>();

/** The decision the guard made for this request. */
export function decisionOf(req: FastifyRequest): PlayerDecision | undefined {
  return decisions.get(req);
}

export function rememberDecision(req: FastifyRequest, decision: PlayerDecision): void {
  decisions.set(req, decision);
}

export function denialReply(reply: FastifyReply, denial: PlayerDenial) {
  return reply.code(denial === 'NO_USER' ? 400 : 403).send({ error: DENIAL_MESSAGES[denial], code: denial });
}

/**
 * preHandler for player routes: 403 unless the caller may use the player from where they are.
 * `needsUser`: the route keeps per-user state (progress, queue ...), so API-key callers without a
 * user get 400 NO_USER.
 */
export function requirePlayer(db: Db, opts: { needsUser?: boolean } = {}) {
  return async function playerGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const decision = decide(playerSettings(db), subjectOf(req), isRemoteRequest(req));
    rememberDecision(req, decision);
    if (decision.denial) {
      await denialReply(reply, decision.denial);
      return;
    }
    if (opts.needsUser && !req.auth?.user) await denialReply(reply, 'NO_USER');
  };
}

/**
 * A signed link stays usable while its user may still sign in: some unexpired session, a
 * personal API key or a signed-in Arclight app device. "Sign out everywhere", a password
 * change and deleting the user end it.
 */
export function linkUserStillActive(db: Db, userId: number, nowMs: number, profileId: number | null = null): boolean {
  // A link naming a profile ends when that profile is deleted (or never belonged to the user).
  if (profileId !== null) {
    const profile = db
      .select({ id: householdProfiles.id })
      .from(householdProfiles)
      .where(and(eq(householdProfiles.id, profileId), eq(householdProfiles.userId, userId)))
      .get();
    if (!profile) return false;
  }
  const device = db.select({ id: appDevices.id }).from(appDevices).where(eq(appDevices.userId, userId)).get();
  if (device) return true;
  const at = new Date(nowMs).toISOString();
  const session = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, at)))
    .get();
  if (session) return true;
  const key = db
    .select({ id: userApiKeys.id })
    .from(userApiKeys)
    .where(and(eq(userApiKeys.userId, userId), or(isNull(userApiKeys.expiresAt), gt(userApiKeys.expiresAt, at))))
    .get();
  return key !== undefined;
}
