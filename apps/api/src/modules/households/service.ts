import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import {
  HOUSEHOLD_PROFILE_COLORS,
  HOUSEHOLD_PROFILES_MAX,
  ProfileSettings,
  ProfileSettingsPatch,
  type ActiveProfileSummary,
  type AuthVia,
  type ContentRestrictions,
  type HouseholdErrorCode,
  type HouseholdProfile,
  type HouseholdProfileCreate,
  type HouseholdProfilesResponse,
  type HouseholdProfileUpdate,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { sessions } from '../auth/schema.js';
import { appDevices } from '../app-auth/schema.js';
import { audit } from '../audit/recorder.js';
import { playbackBookmarks, playbackPlays, playbackProgress, userPlaylists } from '../playback/schema.js';
import { defaultInitial, ownerProfileOf } from './backfill.js';
import { householdProfiles, profileMyList, profilePlaybackQueue, type HouseholdProfileRow } from './schema.js';

// Household profiles (spec §2.3): listing, managing (owner profile only), selecting with the
// PIN rule and its lockout, per-profile settings, and the per-request profile the auth service
// attaches to every credential that has a user.

/** The active household profile of a request (RequestAuth.profile). */
export interface RequestProfile {
  id: number;
  isOwner: boolean;
  /** The profile's own limit (null: only the account's). Always null on the owner profile. */
  restrictions: ContentRestrictions | null;
}

/** The credential a profile is selected on (only sessions and app devices can select). */
export interface ProfileCredential {
  via: AuthVia;
  userId: number;
  sessionId?: number | undefined;
  appDeviceId?: number | undefined;
  /** When the credential was created (ISO); within FRESH_CREDENTIAL_MS it may skip the PIN of its own profile. */
  createdAt?: string | undefined;
  /** The profile the credential is on now. */
  activeProfileId: number;
  ip?: string | null | undefined;
  username?: string | null | undefined;
}

export const HOUSEHOLD_ERROR_STATUS: Record<HouseholdErrorCode, number> = {
  'owner-immutable': 400,
  'pin-required': 401,
  'pin-wrong': 401,
  'pin-locked': 429,
  'manage-forbidden': 403,
  'profile-forbidden': 403,
  'not-found': 404,
  'unsupported-credential': 409,
  'limit-reached': 409,
};

export class HouseholdError extends Error {
  readonly status: number;
  constructor(
    readonly code: HouseholdErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.status = HOUSEHOLD_ERROR_STATUS[code];
  }

  body(): { error: HouseholdErrorCode; retryAfterSeconds?: number } {
    return { error: this.code, ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}) };
  }
}

/** Wrong PINs in a row allowed per profile before the lockout. */
export const PIN_MAX_FAILURES = 5;
/** The first lockout; each further one (without a right PIN between) doubles, up to PIN_LOCK_MAX_MS. */
export const PIN_LOCK_BASE_MS = 15 * 60_000;
export const PIN_LOCK_MAX_MS = 24 * 60 * 60_000;
/** A credential this young has just proven the password: it may re-select its own profile without the PIN. */
export const FRESH_CREDENTIAL_MS = 10 * 60_000;
/** How long a profile read for a request is reused. Cleared on every change. */
export const PROFILE_CACHE_MS = 30_000;
const MAX_TRACKED = 10_000;

/** How long the lockout after `previous` earlier lockouts lasts. */
export function pinLockMs(previous: number): number {
  return Math.min(PIN_LOCK_MAX_MS, PIN_LOCK_BASE_MS * 2 ** Math.min(Math.max(0, previous), 16));
}

export function settingsOfRow(stored: unknown): ProfileSettings {
  const patch = ProfileSettingsPatch.safeParse(stored ?? {});
  if (patch.success) return ProfileSettings.parse(stripUndefined(patch.data));
  // A stored value that no longer validates as a whole: keep the keys that still do.
  const out: Record<string, unknown> = {};
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    const one = ProfileSettingsPatch.safeParse({ [k]: v });
    if (one.success) Object.assign(out, one.data);
  }
  return ProfileSettings.parse(stripUndefined(out));
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function toHouseholdProfile(row: HouseholdProfileRow): HouseholdProfile {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    initial: row.initial,
    isOwner: row.isOwner,
    hasPin: row.pinHash !== null,
    contentRestrictions: row.isOwner ? null : (row.contentRestrictions ?? null),
    settings: settingsOfRow(row.settings),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSummary(row: HouseholdProfileRow): ActiveProfileSummary {
  return { id: row.id, name: row.name, color: row.color, initial: row.initial, isOwner: row.isOwner };
}

function toRequestProfile(row: HouseholdProfileRow): RequestProfile {
  return { id: row.id, isOwner: row.isOwner, restrictions: row.isOwner ? null : (row.contentRestrictions ?? null) };
}

export interface HouseholdServiceOptions {
  db: Db;
  now?: () => Date;
}

export class HouseholdService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly cache = new Map<number, { row: HouseholdProfileRow | null; at: number }>();
  private readonly owners = new Map<number, number>();
  /** PIN checks running now per profile (counted as failures until they finish). */
  private readonly pinInflight = new Map<number, number>();

  constructor(opts: HouseholdServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------------- lookups

  private rowById(id: number): HouseholdProfileRow | null {
    const t = this.now().getTime();
    const hit = this.cache.get(id);
    if (hit && t - hit.at < PROFILE_CACHE_MS) return hit.row;
    const row = this.db.select().from(householdProfiles).where(eq(householdProfiles.id, id)).get() ?? null;
    if (this.cache.size >= MAX_TRACKED) this.cache.clear();
    this.cache.set(id, { row, at: t });
    return row;
  }

  private invalidate(id: number): void {
    this.cache.delete(id);
  }

  /** The account's owner profile (created when missing). null when the user does not exist. */
  owner(userId: number): HouseholdProfileRow | null {
    const known = this.owners.get(userId);
    if (known !== undefined) {
      const row = this.rowById(known);
      if (row && row.userId === userId && row.isOwner) return row;
      this.owners.delete(userId);
    }
    const row = ownerProfileOf(this.db, userId, this.now);
    if (!row) return null;
    this.owners.set(userId, row.id);
    this.cache.set(row.id, { row, at: this.now().getTime() });
    return row;
  }

  /** A profile of the account, or null (other accounts' profiles read as missing). */
  find(userId: number, id: number): HouseholdProfileRow | null {
    const row = this.rowById(id);
    return row && row.userId === userId ? row : null;
  }

  private mustFind(userId: number, id: number): HouseholdProfileRow {
    const row = this.find(userId, id);
    if (!row) throw new HouseholdError('not-found');
    return row;
  }

  /**
   * The profile a credential is on: its stored profile when that still exists on the same
   * account, else the owner profile. null only when the user does not exist.
   */
  forCredential(userId: number, credentialProfileId: number | null | undefined): RequestProfile | null {
    if (credentialProfileId !== null && credentialProfileId !== undefined) {
      const row = this.find(userId, credentialProfileId);
      if (row) return toRequestProfile(row);
    }
    const owner = this.owner(userId);
    return owner ? toRequestProfile(owner) : null;
  }

  /** The profile a signed link names (`p`), null meaning the owner (links signed before profiles). */
  linkProfile(userId: number, profileId: number | null): RequestProfile | null {
    if (profileId === null) {
      const owner = this.owner(userId);
      return owner ? toRequestProfile(owner) : null;
    }
    const row = this.find(userId, profileId);
    return row ? toRequestProfile(row) : null;
  }

  summary(userId: number, profileId: number): ActiveProfileSummary | null {
    const row = this.find(userId, profileId) ?? this.owner(userId);
    return row ? toSummary(row) : null;
  }

  // ------------------------------------------------------------------------- listing

  rows(userId: number): HouseholdProfileRow[] {
    this.owner(userId);
    return this.db
      .select()
      .from(householdProfiles)
      .where(eq(householdProfiles.userId, userId))
      .orderBy(desc(householdProfiles.isOwner), asc(householdProfiles.sortOrder), asc(householdProfiles.id))
      .all();
  }

  list(userId: number, activeProfileId: number | null, canManage: boolean): HouseholdProfilesResponse {
    const rows = this.rows(userId);
    const owner = rows.find((r) => r.isOwner);
    const active = activeProfileId !== null && rows.some((r) => r.id === activeProfileId) ? activeProfileId : (owner?.id ?? rows[0]?.id ?? 0);
    return { profiles: rows.map(toHouseholdProfile), activeProfileId: active, canManage, max: HOUSEHOLD_PROFILES_MAX };
  }

  get(userId: number, id: number): HouseholdProfile {
    return toHouseholdProfile(this.mustFind(userId, id));
  }

  // ------------------------------------------------------------------------- managing

  async create(userId: number, input: HouseholdProfileCreate): Promise<HouseholdProfile> {
    const rows = this.rows(userId);
    if (rows.length === 0) throw new HouseholdError('not-found');
    if (rows.length >= HOUSEHOLD_PROFILES_MAX) throw new HouseholdError('limit-reached');
    const used = new Set(rows.map((r) => r.color.toLowerCase()));
    const color = input.color ?? HOUSEHOLD_PROFILE_COLORS.find((c) => !used.has(c)) ?? HOUSEHOLD_PROFILE_COLORS[rows.length % HOUSEHOLD_PROFILE_COLORS.length]!;
    const name = input.name.trim();
    const top = this.db.select({ v: max(householdProfiles.sortOrder) }).from(householdProfiles).where(eq(householdProfiles.userId, userId)).get();
    const at = this.now().toISOString();
    const pinHash = input.pin ? await hashPassword(input.pin) : null;
    // Re-count after the (slow) hash so two concurrent creates cannot pass the limit together.
    const count = this.db.select({ n: sql<number>`count(*)` }).from(householdProfiles).where(eq(householdProfiles.userId, userId)).get()?.n ?? 0;
    if (count >= HOUSEHOLD_PROFILES_MAX) throw new HouseholdError('limit-reached');
    const row = this.db
      .insert(householdProfiles)
      .values({
        userId,
        name,
        color,
        initial: input.initial?.trim() || defaultInitial(name),
        isOwner: false,
        pinHash,
        contentRestrictions: input.contentRestrictions ?? null,
        settings: stripUndefined(input.settings ?? {}),
        sortOrder: (top?.v ?? 0) + 1,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    this.invalidate(row.id);
    return toHouseholdProfile(row);
  }

  async update(userId: number, id: number, patch: HouseholdProfileUpdate): Promise<HouseholdProfile> {
    const row = this.mustFind(userId, id);
    if (row.isOwner && patch.contentRestrictions !== undefined && patch.contentRestrictions !== null) {
      throw new HouseholdError('owner-immutable');
    }
    const set: Partial<typeof householdProfiles.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      set.name = name;
      // An initial that followed the old name follows the new one.
      if (patch.initial === undefined && row.initial === defaultInitial(row.name)) set.initial = defaultInitial(name);
    }
    if (patch.initial !== undefined) set.initial = patch.initial.trim();
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.contentRestrictions !== undefined && !row.isOwner) set.contentRestrictions = patch.contentRestrictions;
    if (patch.pin !== undefined) {
      set.pinHash = patch.pin === null ? null : await hashPassword(patch.pin);
      // Setting or clearing the PIN is how the owner lifts a lockout.
      set.failedPinAttempts = 0;
      set.pinLockedUntil = null;
      set.pinLockouts = 0;
    }
    if (patch.settings !== undefined) set.settings = { ...stripUndefined(ProfileSettingsPatch.parse(row.settings ?? {})), ...stripUndefined(patch.settings) };
    if (patch.sortOrder !== undefined) set.sortOrder = row.isOwner ? 0 : patch.sortOrder;
    set.updatedAt = this.now().toISOString();
    const updated = this.db.update(householdProfiles).set(set).where(and(eq(householdProfiles.id, id), eq(householdProfiles.userId, userId))).returning().get();
    this.invalidate(id);
    if (!updated) throw new HouseholdError('not-found');
    return toHouseholdProfile(updated);
  }

  /**
   * Deletes a profile and everything that is its own; its sessions and devices go back to the
   * owner profile. The profile_id columns declare ON DELETE (cascade / set null) in migration
   * 0032, but the rows are handled explicitly too so the cleanup does not depend on the
   * foreign_keys pragma being on for the connection.
   */
  remove(userId: number, id: number): void {
    const row = this.mustFind(userId, id);
    if (row.isOwner) throw new HouseholdError('owner-immutable');
    this.db.transaction((tx) => {
      tx.update(sessions).set({ profileId: null }).where(eq(sessions.profileId, id)).run();
      tx.update(appDevices).set({ profileId: null }).where(eq(appDevices.profileId, id)).run();
      tx.delete(playbackProgress).where(eq(playbackProgress.profileId, id)).run();
      tx.delete(playbackPlays).where(eq(playbackPlays.profileId, id)).run();
      tx.delete(playbackBookmarks).where(eq(playbackBookmarks.profileId, id)).run();
      tx.delete(userPlaylists).where(eq(userPlaylists.profileId, id)).run();
      tx.delete(profileMyList).where(eq(profileMyList.profileId, id)).run();
      tx.delete(profilePlaybackQueue).where(eq(profilePlaybackQueue.profileId, id)).run();
      tx.delete(householdProfiles).where(and(eq(householdProfiles.id, id), eq(householdProfiles.userId, userId))).run();
    });
    this.invalidate(id);
    this.pinInflight.delete(id);
  }

  // ------------------------------------------------------------------------- selecting

  private auditPin(cred: ProfileCredential, action: string, profileId: number, details: Record<string, unknown> = {}): void {
    audit(this.db).record({
      action,
      userId: cred.userId,
      username: cred.username ?? null,
      ip: cred.ip ?? null,
      target: profileId,
      details: { profileId, via: cred.via, ...details },
    });
  }

  /**
   * Switches a session or app device to a profile of its account. A profile with a PIN needs
   * it, also when it is already the active one, except for a credential younger than ten
   * minutes re-selecting the profile it is on. Five wrong PINs in a row (from any credential)
   * lock the profile for fifteen minutes, doubling with every further lockout up to a day; the
   * counters live on the profile row, so signing in again or a restart does not reset them. A
   * right PIN, or the owner setting or clearing the PIN, resets them.
   */
  async select(cred: ProfileCredential, targetId: number, pin: string | undefined): Promise<HouseholdProfile> {
    const credentialKey = cred.via === 'session' && cred.sessionId !== undefined ? `s${cred.sessionId}` : cred.via === 'app' && cred.appDeviceId !== undefined ? `a${cred.appDeviceId}` : null;
    if (credentialKey === null) throw new HouseholdError('unsupported-credential');
    const row = this.mustFind(cred.userId, targetId);
    if (row.pinHash !== null) {
      const t = this.now().getTime();
      const created = cred.createdAt ? Date.parse(cred.createdAt) : NaN;
      const fresh = Number.isFinite(created) && t - created >= 0 && t - created < FRESH_CREDENTIAL_MS && cred.activeProfileId === targetId;
      if (!fresh) await this.checkPin(cred, row.id, pin, t);
    }
    if (cred.via === 'session') {
      this.db.update(sessions).set({ profileId: row.isOwner ? null : row.id }).where(and(eq(sessions.id, cred.sessionId!), eq(sessions.userId, cred.userId))).run();
    } else {
      this.db.update(appDevices).set({ profileId: row.isOwner ? null : row.id }).where(and(eq(appDevices.id, cred.appDeviceId!), eq(appDevices.userId, cred.userId))).run();
    }
    return toHouseholdProfile(row);
  }

  /** The PIN state read fresh from the database (the profile cache may be up to 30 s old). */
  private pinState(id: number) {
    return this.db
      .select({ pinHash: householdProfiles.pinHash, failed: householdProfiles.failedPinAttempts, lockedUntil: householdProfiles.pinLockedUntil, lockouts: householdProfiles.pinLockouts })
      .from(householdProfiles)
      .where(eq(householdProfiles.id, id))
      .get();
  }

  private async checkPin(cred: ProfileCredential, profileId: number, pin: string | undefined, t: number): Promise<void> {
    const state = this.pinState(profileId);
    if (!state) throw new HouseholdError('not-found');
    if (state.pinHash === null) return;
    const inflight = this.pinInflight.get(profileId) ?? 0;
    const lockedUntil = state.lockedUntil ?? 0;
    if (lockedUntil > t || state.failed + inflight >= PIN_MAX_FAILURES) {
      const until = lockedUntil > t ? lockedUntil : t + pinLockMs(state.lockouts);
      this.auditPin(cred, 'household.profile.pin-locked', profileId);
      throw new HouseholdError('pin-locked', Math.max(1, Math.ceil((until - t) / 1000)));
    }
    if (pin === undefined) throw new HouseholdError('pin-required');
    this.pinInflight.set(profileId, inflight + 1);
    let ok = false;
    try {
      ok = await verifyPassword(pin, state.pinHash);
    } finally {
      const left = (this.pinInflight.get(profileId) ?? 1) - 1;
      if (left > 0) this.pinInflight.set(profileId, left);
      else this.pinInflight.delete(profileId);
    }
    if (ok) {
      if (state.failed !== 0 || state.lockedUntil !== null || state.lockouts !== 0) {
        this.db.update(householdProfiles).set({ failedPinAttempts: 0, pinLockedUntil: null, pinLockouts: 0 }).where(eq(householdProfiles.id, profileId)).run();
        this.invalidate(profileId);
      }
      return;
    }
    // Read-modify-write in one synchronous step (better-sqlite3), so concurrent failures all count.
    const at = this.now().getTime();
    const now = this.pinState(profileId);
    if (!now) throw new HouseholdError('pin-wrong');
    const failures = now.failed + 1;
    this.auditPin(cred, 'household.profile.pin-wrong', profileId, { failures });
    if (failures >= PIN_MAX_FAILURES) {
      const lockMs = pinLockMs(now.lockouts);
      this.db.update(householdProfiles).set({ failedPinAttempts: 0, pinLockedUntil: at + lockMs, pinLockouts: now.lockouts + 1 }).where(eq(householdProfiles.id, profileId)).run();
      this.auditPin(cred, 'household.profile.pin-locked', profileId, { lockedForSeconds: lockMs / 1000 });
    } else {
      this.db.update(householdProfiles).set({ failedPinAttempts: failures }).where(eq(householdProfiles.id, profileId)).run();
    }
    this.invalidate(profileId);
    throw new HouseholdError('pin-wrong');
  }

  // ------------------------------------------------------------------------- settings

  settings(userId: number, profileId: number): ProfileSettings {
    return settingsOfRow(this.mustFind(userId, profileId).settings);
  }

  async patchSettings(userId: number, profileId: number, patch: ProfileSettingsPatch): Promise<ProfileSettings> {
    return (await this.update(userId, profileId, { settings: patch })).settings;
  }
}

const services = new WeakMap<Db, HouseholdService>();

/** One service per database (the auth hook, the routes and the playback module share its caches). */
export function householdsFor(db: Db, opts: Omit<HouseholdServiceOptions, 'db'> = {}): HouseholdService {
  let s = services.get(db);
  if (!s) {
    s = new HouseholdService({ db, ...opts });
    services.set(db, s);
  }
  return s;
}
