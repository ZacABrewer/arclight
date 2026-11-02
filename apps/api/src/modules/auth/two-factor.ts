import { and, eq, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { PasskeyRecord, SecondFactor, TwoFactorStatus } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { userTwoFactor, users, webauthnCredentials } from '../../db/schema.js';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, totpUri, verifyTotp } from './totp.js';
import { randomToken } from './oidc.js';

// Second factors for Arclight accounts: TOTP with one-time recovery codes, and passkeys
// (WebAuthn, through @simplewebauthn/server). A passkey is a second factor after a password and
// also a sign-in of its own (it already proves possession plus the device's PIN or biometrics).
// Pending password sign-ins and WebAuthn ceremonies are kept in memory: they last minutes, and a
// restart only means signing in again.

/** Thrown for wrong or expired factors; the routes map `code` to a status like AuthError. */
export class TwoFactorError extends Error {
  constructor(
    readonly code: 'INVALID_CREDENTIALS' | 'CHALLENGE_EXPIRED' | 'VALIDATION' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'TwoFactorError';
  }
}

export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Wrong codes allowed per password challenge before it is dropped (the password step starts over). */
export const CHALLENGE_MAX_ATTEMPTS = 5;
const CEREMONY_TTL_MS = 5 * 60_000;
const MAX_PENDING = 10_000;

export interface LoginMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  rememberMe?: boolean | undefined;
}

export interface PendingLogin {
  userId: number;
  /** How the first factor was checked (local password, Jellyfin/Emby password). */
  method: string;
  meta: LoginMeta;
  expires: number;
  attempts: number;
}

/** Relying party of a WebAuthn ceremony: the host the browser is on. */
export interface RelyingParty {
  id: string;
  origin: string;
  name?: string;
}

interface Ceremony {
  kind: 'register' | 'login';
  challenge: string;
  rp: RelyingParty;
  userId?: number;
  /** login: the password challenge this passkey completes (second-factor use). */
  loginChallenge?: string;
  expires: number;
}

type TwoFactorRow = typeof userTwoFactor.$inferSelect;
type CredentialRow = typeof webauthnCredentials.$inferSelect;

function toPasskey(row: CredentialRow): PasskeyRecord {
  return { id: row.id, name: row.name, createdAt: row.createdAt, backedUp: row.backedUp, ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}) };
}

function prune<T extends { expires: number }>(map: Map<string, T>, now: number): void {
  for (const [k, v] of map) if (v.expires <= now) map.delete(k);
  // Hard cap so a flood of unfinished sign-ins cannot grow memory without bound.
  while (map.size > MAX_PENDING) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

export class TwoFactorService {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly ceremonies = new Map<string, Ceremony>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly log?: Logger,
  ) {}

  // ------------------------------------------------------------------------------- status

  private row(userId: number): TwoFactorRow | undefined {
    return this.db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId)).get();
  }

  totpEnabled(userId: number): boolean {
    return Boolean(this.row(userId)?.enabledAt);
  }

  passkeyCount(userId: number): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId)).get()?.n ?? 0;
  }

  /** Any passkey on the install (the sign-in page then offers passkey sign-in). */
  anyPasskeys(): boolean {
    return this.db.select({ id: webauthnCredentials.id }).from(webauthnCredentials).limit(1).get() !== undefined;
  }

  /** The account has a second factor (TOTP or a passkey). */
  hasSecondFactor(userId: number): boolean {
    return this.totpEnabled(userId) || this.passkeyCount(userId) > 0;
  }

  /** Factors offered after a password; empty: no second step. */
  methodsFor(userId: number): SecondFactor[] {
    const methods: SecondFactor[] = [];
    const row = this.row(userId);
    if (row?.enabledAt) {
      methods.push('totp');
      if (row.recoveryCodes.length > 0) methods.push('recovery');
    }
    if (this.passkeyCount(userId) > 0) methods.push('passkey');
    return methods;
  }

  status(userId: number, setupRequired: boolean): TwoFactorStatus {
    const row = this.row(userId);
    const status: TwoFactorStatus = {
      totp: Boolean(row?.enabledAt),
      recoveryCodesLeft: row?.enabledAt ? row.recoveryCodes.length : 0,
      passkeys: this.passkeyCount(userId),
      setupRequired,
    };
    if (row?.enabledAt) status.totpEnabledAt = row.enabledAt;
    return status;
  }

  // ------------------------------------------------------------------------------- TOTP

  /** Starts (or restarts) TOTP setup with a fresh secret; refused while TOTP is on. */
  beginTotp(userId: number, account: string): { secret: string; uri: string } {
    const current = this.row(userId);
    if (current?.enabledAt) throw new TwoFactorError('VALIDATION', 'two-factor is already on; turn it off first to set up a new authenticator');
    const secret = generateTotpSecret();
    const at = this.now().toISOString();
    this.db
      .insert(userTwoFactor)
      .values({ userId, totpSecret: secret, enabledAt: null, lastStep: 0, recoveryCodes: [], updatedAt: at })
      .onConflictDoUpdate({ target: userTwoFactor.userId, set: { totpSecret: secret, enabledAt: null, lastStep: 0, recoveryCodes: [], updatedAt: at } })
      .run();
    return { secret, uri: totpUri(secret, account) };
  }

  /** Confirms setup with a code from the app; returns the recovery codes (shown once). */
  enableTotp(userId: number, code: string): string[] {
    const row = this.row(userId);
    if (!row) throw new TwoFactorError('VALIDATION', 'start the setup first');
    if (row.enabledAt) throw new TwoFactorError('VALIDATION', 'two-factor is already on');
    const step = verifyTotp(row.totpSecret, code, this.now(), row.lastStep);
    if (step === null) throw new TwoFactorError('INVALID_CREDENTIALS', 'that code is not right; check the time on your phone and try again');
    const codes = generateRecoveryCodes();
    this.db
      .update(userTwoFactor)
      .set({ enabledAt: this.now().toISOString(), lastStep: step, recoveryCodes: codes.map(hashRecoveryCode), updatedAt: this.now().toISOString() })
      .where(eq(userTwoFactor.userId, userId))
      .run();
    return codes;
  }

  /** Checks a TOTP code for an account with TOTP on (and burns its step). */
  checkTotp(userId: number, code: string): boolean {
    const row = this.row(userId);
    if (!row?.enabledAt) return false;
    const step = verifyTotp(row.totpSecret, code, this.now(), row.lastStep);
    if (step === null) return false;
    // Conditional update: two concurrent requests with the same code cannot both pass.
    const updated = this.db
      .update(userTwoFactor)
      .set({ lastStep: step, updatedAt: this.now().toISOString() })
      .where(and(eq(userTwoFactor.userId, userId), sql`${userTwoFactor.lastStep} < ${step}`))
      .run();
    return updated.changes === 1;
  }

  /** Uses up a recovery code; true when it was one of the account's unused codes. */
  useRecoveryCode(userId: number, code: string): boolean {
    const row = this.row(userId);
    if (!row?.enabledAt) return false;
    const hash = hashRecoveryCode(code);
    if (!row.recoveryCodes.includes(hash)) return false;
    const left = row.recoveryCodes.filter((h) => h !== hash);
    this.db.update(userTwoFactor).set({ recoveryCodes: left, updatedAt: this.now().toISOString() }).where(eq(userTwoFactor.userId, userId)).run();
    this.log?.info({ userId, left: left.length }, 'recovery code used');
    return true;
  }

  /** A code or a recovery code (re-authentication for turning TOTP off, new recovery codes). */
  proveFactor(userId: number, proof: { code?: string | undefined; recoveryCode?: string | undefined }): void {
    const ok = proof.code !== undefined ? this.checkTotp(userId, proof.code) : proof.recoveryCode !== undefined && this.useRecoveryCode(userId, proof.recoveryCode);
    if (!ok) throw new TwoFactorError('INVALID_CREDENTIALS', 'that code is not right');
  }

  disableTotp(userId: number, proof: { code?: string | undefined; recoveryCode?: string | undefined }): void {
    if (!this.totpEnabled(userId)) throw new TwoFactorError('VALIDATION', 'two-factor is not on');
    this.proveFactor(userId, proof);
    this.db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId)).run();
  }

  regenerateRecoveryCodes(userId: number, proof: { code?: string | undefined; recoveryCode?: string | undefined }): string[] {
    if (!this.totpEnabled(userId)) throw new TwoFactorError('VALIDATION', 'two-factor is not on');
    this.proveFactor(userId, proof);
    const codes = generateRecoveryCodes();
    this.db.update(userTwoFactor).set({ recoveryCodes: codes.map(hashRecoveryCode), updatedAt: this.now().toISOString() }).where(eq(userTwoFactor.userId, userId)).run();
    return codes;
  }

  /** Admin reset: TOTP, recovery codes and passkeys are removed. */
  reset(userId: number): void {
    this.db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId)).run();
    this.db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, userId)).run();
  }

  // ------------------------------------------------------------------------------- password challenges

  /** Parks a password sign-in until the second factor arrives; returns the challenge. */
  createChallenge(userId: number, method: string, meta: LoginMeta): string {
    const now = this.now().getTime();
    prune(this.pending, now);
    const challenge = randomToken(32);
    this.pending.set(challenge, { userId, method, meta, expires: now + CHALLENGE_TTL_MS, attempts: 0 });
    return challenge;
  }

  private liveChallenge(challenge: string): PendingLogin {
    const entry = this.pending.get(challenge);
    if (!entry || entry.expires <= this.now().getTime()) {
      this.pending.delete(challenge);
      throw new TwoFactorError('CHALLENGE_EXPIRED', 'this sign-in expired; enter your password again');
    }
    return entry;
  }

  /**
   * Completes a challenge with a TOTP or recovery code. The challenge is single-use: it is gone
   * after success and after CHALLENGE_MAX_ATTEMPTS wrong codes.
   */
  completeChallenge(challenge: string, proof: { code?: string | undefined; recoveryCode?: string | undefined }): PendingLogin {
    const entry = this.liveChallenge(challenge);
    const ok = proof.code !== undefined ? this.checkTotp(entry.userId, proof.code) : proof.recoveryCode !== undefined && this.useRecoveryCode(entry.userId, proof.recoveryCode);
    if (!ok) {
      entry.attempts++;
      if (entry.attempts >= CHALLENGE_MAX_ATTEMPTS) this.pending.delete(challenge);
      throw new TwoFactorError('INVALID_CREDENTIALS', 'that code is not right');
    }
    this.pending.delete(challenge);
    return entry;
  }

  // ------------------------------------------------------------------------------- passkeys

  listPasskeys(userId: number): PasskeyRecord[] {
    return this.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId)).orderBy(webauthnCredentials.id).all().map(toPasskey);
  }

  private newCeremony(c: Omit<Ceremony, 'expires'>): string {
    const now = this.now().getTime();
    prune(this.ceremonies, now);
    const id = randomToken(24);
    this.ceremonies.set(id, { ...c, expires: now + CEREMONY_TTL_MS });
    return id;
  }

  /** Single use: taken out of the map whether or not verification succeeds. */
  private takeCeremony(id: string, kind: Ceremony['kind']): Ceremony {
    const c = this.ceremonies.get(id);
    this.ceremonies.delete(id);
    if (!c || c.kind !== kind || c.expires <= this.now().getTime()) throw new TwoFactorError('CHALLENGE_EXPIRED', 'the passkey prompt expired; try again');
    return c;
  }

  async registrationOptions(user: { id: number; username: string; displayName?: string | undefined }, rp: RelyingParty) {
    const existing = this.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id)).all();
    const options = await generateRegistrationOptions({
      rpName: rp.name ?? 'Arclight',
      rpID: rp.id,
      userName: user.username,
      userDisplayName: user.displayName ?? user.username,
      // A stable, non-identifying handle; discoverable sign-in finds the account by credential id anyway.
      userID: new TextEncoder().encode(`arclight-user-${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    const ceremony = this.newCeremony({ kind: 'register', challenge: options.challenge, rp, userId: user.id });
    return { ceremony, options: options as unknown as Record<string, unknown> };
  }

  async register(userId: number, ceremonyId: string, name: string, response: Record<string, unknown>): Promise<PasskeyRecord> {
    const c = this.takeCeremony(ceremonyId, 'register');
    if (c.userId !== userId) throw new TwoFactorError('CHALLENGE_EXPIRED', 'the passkey prompt expired; try again');
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: c.challenge,
        expectedOrigin: c.rp.origin,
        expectedRPID: c.rp.id,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new TwoFactorError('VALIDATION', `passkey not accepted: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!verified.verified) throw new TwoFactorError('VALIDATION', 'passkey not accepted');
    const { credential, credentialBackedUp } = verified.registrationInfo;
    const clash = this.db.select({ id: webauthnCredentials.id }).from(webauthnCredentials).where(eq(webauthnCredentials.credentialId, credential.id)).get();
    if (clash) throw new TwoFactorError('VALIDATION', 'this passkey is already registered');
    const row = this.db
      .insert(webauthnCredentials)
      .values({
        userId,
        name,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        backedUp: credentialBackedUp,
        createdAt: this.now().toISOString(),
      })
      .returning()
      .get();
    return toPasskey(row);
  }

  renamePasskey(userId: number, id: number, name: string): PasskeyRecord {
    const row = this.db
      .update(webauthnCredentials)
      .set({ name })
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning()
      .get();
    if (!row) throw new TwoFactorError('NOT_FOUND', `passkey ${id} not found`);
    return toPasskey(row);
  }

  removePasskey(userId: number, id: number): void {
    const row = this.db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning()
      .get();
    if (!row) throw new TwoFactorError('NOT_FOUND', `passkey ${id} not found`);
  }

  /**
   * Options for a passkey prompt. With `loginChallenge` (a parked password sign-in) only that
   * account's passkeys are allowed; without, any discoverable passkey (passwordless sign-in).
   */
  async authenticationOptions(rp: RelyingParty, loginChallenge?: string) {
    let allow: { id: string; transports?: string[] }[] | undefined;
    if (loginChallenge !== undefined) {
      const entry = this.liveChallenge(loginChallenge);
      allow = this.db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, entry.userId))
        .all()
        .map((c) => ({ id: c.credentialId, transports: c.transports }));
      if (allow.length === 0) throw new TwoFactorError('VALIDATION', 'this account has no passkeys');
    }
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      ...(allow ? { allowCredentials: allow } : {}),
      // Passwordless: the device must verify the person (PIN, biometrics).
      userVerification: allow ? 'preferred' : 'required',
    });
    const ceremony = this.newCeremony({ kind: 'login', challenge: options.challenge, rp, ...(loginChallenge !== undefined ? { loginChallenge } : {}) });
    return { ceremony, options: options as unknown as Record<string, unknown> };
  }

  /**
   * Verifies a passkey assertion. Returns the account and, for the second-factor use, the parked
   * password sign-in it completes. The signature counter must move forward when the
   * authenticator keeps one (a clone would repeat it).
   */
  async authenticate(ceremonyId: string, response: Record<string, unknown>, loginChallenge?: string): Promise<{ userId: number; pending?: PendingLogin }> {
    const c = this.takeCeremony(ceremonyId, 'login');
    if ((c.loginChallenge ?? undefined) !== (loginChallenge ?? undefined)) throw new TwoFactorError('CHALLENGE_EXPIRED', 'the passkey prompt expired; try again');
    const credId = typeof response['id'] === 'string' ? response['id'] : '';
    const row = credId ? this.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialId, credId)).get() : undefined;
    if (!row) throw new TwoFactorError('INVALID_CREDENTIALS', 'this passkey is not registered here');
    let pending: PendingLogin | undefined;
    if (loginChallenge !== undefined) {
      pending = this.liveChallenge(loginChallenge);
      if (pending.userId !== row.userId) throw new TwoFactorError('INVALID_CREDENTIALS', 'this passkey belongs to another account');
    }
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: c.challenge,
        expectedOrigin: c.rp.origin,
        expectedRPID: c.rp.id,
        credential: { id: row.credentialId, publicKey: Buffer.from(row.publicKey, 'base64url'), counter: row.counter, transports: row.transports },
        requireUserVerification: loginChallenge === undefined,
      });
    } catch (err) {
      throw new TwoFactorError('INVALID_CREDENTIALS', `passkey not accepted: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!verified.verified) throw new TwoFactorError('INVALID_CREDENTIALS', 'passkey not accepted');
    this.db
      .update(webauthnCredentials)
      .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: this.now().toISOString(), backedUp: verified.authenticationInfo.credentialBackedUp })
      .where(eq(webauthnCredentials.id, row.id))
      .run();
    if (loginChallenge !== undefined) this.pending.delete(loginChallenge);
    // The account must still exist (cascade removes credentials with it, but be explicit).
    const user = this.db.select({ id: users.id }).from(users).where(eq(users.id, row.userId)).get();
    if (!user) throw new TwoFactorError('INVALID_CREDENTIALS', 'this passkey is not registered here');
    return { userId: row.userId, ...(pending ? { pending } : {}) };
  }
}
