import { and, eq } from 'drizzle-orm';
import type { JWTVerifyGetKey } from 'jose';
import {
  IdentitySettings,
  SECRET_MASK,
  type IdentitySettingsInput,
  type IdentitySettingsResponse,
  type LinkedIdentity,
  type OidcProvider,
  type OidcTestResult,
  type SignInOptions,
  type User,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { userIdentities, users } from '../../db/schema.js';
import { setSection } from '../settings/service.js';
import { audit } from '../audit/recorder.js';
import { TokenBuckets, type RateLimitOptions } from '../requests/portal.js';
import { hashToken } from './hash.js';
import {
  authorizationUrl,
  discover,
  emailVerified,
  exchangeCode,
  fetchUserinfo,
  OidcError,
  randomToken,
  remoteKeys,
  stringList,
  verifyIdToken,
  type FetchLike,
  type OidcDiscovery,
} from './oidc.js';
import { AuthError, effectiveAppAccess, toUser, type AuthService, type LoginResult, type RequestAuth, type RequestCredentials } from './service.js';
import { invalidProxyEntries, TrustedProxies } from './trusted-proxies.js';

// External identities for Arclight accounts: OpenID Connect sign-in (any standard provider:
// Authentik, Authelia, Keycloak, Pocket ID, Zitadel, Google, Microsoft Entra, ...) and
// forward-auth from a trusted reverse proxy. Arclight is not an identity provider: the provider
// proves who someone is, and the Arclight account (role, permissions, requests) stays here.
// Forward-auth identities are stored as links of the pseudo-provider FORWARD_AUTH_PROVIDER.

export const FORWARD_AUTH_PROVIDER = 'forward-auth';
/** An unfinished sign-in at the provider expires after this long. */
export const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 10_000;
/** Unfinished sign-ins one address may hold; more are refused, never evicting anyone else's. */
const MAX_ATTEMPTS_PER_PEER = 20;
/** Sign-in starts per address: a burst for retries, then one every 10 seconds. */
export const OIDC_START_LIMIT: RateLimitOptions = { capacity: 20, refillPerSecond: 0.1 };
const DISCOVERY_TTL_MS = 10 * 60_000;

/** One authorization request in flight (keyed by its `state`). */
interface Attempt {
  providerId: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  /** sha256 of the browser-binding cookie set with the redirect. */
  bindingHash: string;
  returnTo: string;
  rememberMe: boolean;
  /** Set when a signed-in user is linking this provider to their account. */
  linkUserId?: number;
  /** Client address that started it (per-address cap). */
  peer: string;
  expires: number;
}

export interface IdentityServiceOptions {
  db: Db;
  auth: AuthService;
  log?: Logger | undefined;
  now?: () => Date;
  fetch?: FetchLike;
  /** Test seam: the provider's signing keys (default: its JWKS over HTTP). */
  keysFor?: (jwksUri: string) => JWTVerifyGetKey;
  /** Sign-in starts per client address (default OIDC_START_LIMIT). */
  startLimit?: RateLimitOptions;
}

export type CallbackOutcome = { kind: 'login'; result: LoginResult; returnTo: string; providerId: string } | { kind: 'linked'; returnTo: string; providerId: string };

/** A relative in-app path; anything else (absolute URLs, //host, backslashes) becomes `/`. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/';
  return value;
}

function lower(list: readonly string[]): Set<string> {
  return new Set(list.map((g) => g.toLowerCase()));
}

/** Group rules shared by OIDC and forward-auth: allowed groups and the admin-group role. */
export function groupDecision(groups: readonly string[], rules: { adminGroups: readonly string[]; allowedGroups: readonly string[] }): { allowed: boolean; role: User['role'] | null } {
  const held = lower(groups);
  const admin = lower(rules.adminGroups);
  const allowed = lower(rules.allowedGroups);
  const inAdmin = [...held].some((g) => admin.has(g));
  const isAllowed = allowed.size === 0 || inAdmin || [...held].some((g) => allowed.has(g));
  return { allowed: isAllowed, role: admin.size === 0 ? null : inAdmin ? 'admin' : 'user' };
}

function linkedOf(row: typeof userIdentities.$inferSelect, providers: readonly OidcProvider[]): LinkedIdentity {
  const provider = providers.find((p) => p.id === row.providerId);
  const out: LinkedIdentity = {
    id: row.id,
    providerId: row.providerId,
    providerName: row.providerId === FORWARD_AUTH_PROVIDER ? 'Forward-auth' : (provider?.name ?? row.providerId),
    subject: row.subject,
    linkedAt: row.linkedAt,
  };
  if (row.email) out.email = row.email;
  if (row.lastLoginAt) out.lastLoginAt = row.lastLoginAt;
  return out;
}

export class IdentityService {
  private readonly db: Db;
  private readonly auth: AuthService;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;
  private readonly keysFor: (jwksUri: string) => JWTVerifyGetKey;
  private readonly attempts = new Map<string, Attempt>();
  private readonly pendingByPeer = new Map<string, number>();
  private readonly starts: TokenBuckets;
  private readonly discovery = new Map<string, { doc: OidcDiscovery; keys: JWTVerifyGetKey; at: number }>();
  private proxies: { key: string; list: TrustedProxies } | null = null;

  constructor(opts: IdentityServiceOptions) {
    this.db = opts.db;
    this.auth = opts.auth;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.keysFor = opts.keysFor ?? remoteKeys;
    this.starts = new TokenBuckets(opts.startLimit ?? OIDC_START_LIMIT, () => this.now().getTime());
    this.auth.forwardAuth = (creds) => this.resolveForwardAuth(creds);
  }

  // ------------------------------------------------------------------------------- settings

  settings(): IdentitySettings {
    return this.auth.identitySettings();
  }

  /** The callback URL registered at the provider: <app base>/api/v1/auth/oidc/<id>/callback. */
  redirectUri(appBase: string, providerId: string): string {
    return `${appBase.replace(/\/+$/, '')}/api/v1/auth/oidc/${providerId}/callback`;
  }

  response(appBase: string): IdentitySettingsResponse {
    const s = this.settings();
    return {
      ...s,
      providers: s.providers.map((p) => ({ ...p, clientSecret: p.clientSecret ? SECRET_MASK : '' })),
      redirectUris: Object.fromEntries(s.providers.map((p) => [p.id, this.redirectUri(appBase, p.id)])),
    };
  }

  /**
   * Saves the section. A masked client secret keeps the stored one (matched by provider id).
   * Turning on the admin two-factor requirement needs a second factor on the caller's own
   * account, so an admin cannot lock themselves out with one click.
   */
  update(input: IdentitySettingsInput, caller: { userId: number | null }): IdentitySettings {
    const parsed = IdentitySettings.parse(input);
    const current = this.settings();
    const ids = new Set<string>();
    for (const p of parsed.providers) {
      if (ids.has(p.id)) throw new AuthError('VALIDATION', `two providers use the id "${p.id}"`);
      if (p.id === FORWARD_AUTH_PROVIDER) throw new AuthError('VALIDATION', `"${FORWARD_AUTH_PROVIDER}" is reserved`);
      ids.add(p.id);
      if (p.clientSecret === SECRET_MASK) p.clientSecret = current.providers.find((c) => c.id === p.id)?.clientSecret ?? '';
    }
    const bad = invalidProxyEntries(parsed.forwardAuth.trustedProxies);
    if (bad.length > 0) throw new AuthError('VALIDATION', `not an IP address or CIDR range: ${bad.join(', ')}`);
    if (parsed.forwardAuth.enabled && parsed.forwardAuth.trustedProxies.length === 0) {
      throw new AuthError('VALIDATION', 'forward-auth needs at least one trusted proxy address');
    }
    if (parsed.requireTwoFactorForAdmins && !current.requireTwoFactorForAdmins) {
      if (caller.userId === null || !this.auth.twoFactor.hasSecondFactor(caller.userId)) {
        throw new AuthError('VALIDATION', 'set up two-factor (or a passkey) on your own account before requiring it for admins');
      }
    }
    const saved = setSection(this.db, 'identity', parsed, this.now().toISOString());
    // Provider endpoints may have changed.
    this.discovery.clear();
    return saved;
  }

  /** What the sign-in pages offer (GET /auth/status). */
  signInOptions(): SignInOptions {
    const s = this.settings();
    const providers = s.providers.filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, showOnLogin: p.showOnLogin, showOnPortal: p.showOnPortal }));
    return { providers, hidePasswordLogin: s.hidePasswordLogin && providers.length > 0, passkeys: this.auth.twoFactor.anyPasskeys() };
  }

  async test(issuer: string): Promise<OidcTestResult> {
    try {
      const doc = await discover(this.fetchImpl, issuer);
      return { ok: true, issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private provider(id: string): OidcProvider {
    const provider = this.settings().providers.find((p) => p.id === id);
    if (!provider) throw new OidcError('disabled', `no identity provider "${id}"`);
    if (!provider.enabled) throw new OidcError('disabled', `identity provider "${id}" is turned off`);
    return provider;
  }

  private async discovered(provider: OidcProvider): Promise<{ doc: OidcDiscovery; keys: JWTVerifyGetKey }> {
    const cached = this.discovery.get(provider.id);
    const t = this.now().getTime();
    if (cached && t - cached.at < DISCOVERY_TTL_MS) return cached;
    let doc: OidcDiscovery;
    try {
      doc = await discover(this.fetchImpl, provider.issuer);
    } catch (err) {
      this.log?.warn({ provider: provider.id, err: err instanceof Error ? err.message : String(err) }, 'identity provider discovery failed');
      throw new OidcError('provider', 'the identity provider could not be reached');
    }
    const entry = { doc, keys: this.keysFor(doc.jwks_uri), at: t };
    this.discovery.set(provider.id, entry);
    return entry;
  }

  // ------------------------------------------------------------------------------- sign-in flow

  private dropAttempt(state: string): Attempt | undefined {
    const attempt = this.attempts.get(state);
    if (!attempt) return undefined;
    this.attempts.delete(state);
    const left = (this.pendingByPeer.get(attempt.peer) ?? 1) - 1;
    if (left > 0) this.pendingByPeer.set(attempt.peer, left);
    else this.pendingByPeer.delete(attempt.peer);
    return attempt;
  }

  private prune(): void {
    const t = this.now().getTime();
    for (const [k, v] of this.attempts) if (v.expires <= t) this.dropAttempt(k);
  }

  /**
   * Starts an authorization request. Returns the provider URL and the browser-binding value the
   * caller sets as a short-lived cookie: the callback only completes in the browser that started.
   * Rate-limited per client address (`peer`); when an address (or the whole table) holds too many
   * unfinished sign-ins, new ones are refused instead of pushing out other people's.
   */
  async start(providerId: string, opts: { appBase: string; returnTo?: unknown; rememberMe?: boolean; linkUserId?: number; peer?: string | undefined }): Promise<{ url: string; binding: string }> {
    const peer = opts.peer ?? '';
    if (!this.starts.take(peer)) throw new OidcError('rate_limited', 'too many sign-in attempts from this address; wait a moment');
    const provider = this.provider(providerId);
    this.prune();
    if ((this.pendingByPeer.get(peer) ?? 0) >= MAX_ATTEMPTS_PER_PEER || this.attempts.size >= MAX_ATTEMPTS) {
      throw new OidcError('rate_limited', 'too many unfinished sign-ins; finish one or wait a few minutes');
    }
    const { doc } = await this.discovered(provider);
    const state = randomToken(32);
    const binding = randomToken(32);
    const attempt: Attempt = {
      providerId,
      nonce: randomToken(32),
      codeVerifier: randomToken(48),
      redirectUri: this.redirectUri(opts.appBase, providerId),
      bindingHash: hashToken(binding),
      returnTo: safeReturnTo(opts.returnTo),
      rememberMe: opts.rememberMe ?? true,
      peer,
      expires: this.now().getTime() + ATTEMPT_TTL_MS,
      ...(opts.linkUserId !== undefined ? { linkUserId: opts.linkUserId } : {}),
    };
    this.attempts.set(state, attempt);
    this.pendingByPeer.set(peer, (this.pendingByPeer.get(peer) ?? 0) + 1);
    const url = authorizationUrl(doc, { clientId: provider.clientId, redirectUri: attempt.redirectUri, scopes: provider.scopes, state, nonce: attempt.nonce, codeVerifier: attempt.codeVerifier });
    return { url, binding };
  }

  /** The returnTo of a state, for error redirects (does not consume it). */
  returnToOf(state: unknown): string {
    return typeof state === 'string' ? (this.attempts.get(state)?.returnTo ?? '/') : '/';
  }

  /**
   * The provider sent the browser back. The state is single-use and must belong to this provider
   * and this browser (binding cookie) and still be fresh; then the code is exchanged and the ID
   * token verified before any account is looked at.
   */
  async callback(
    providerId: string,
    query: Record<string, unknown>,
    ctx: { binding: string | undefined; sessionUserId: number | null; ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<CallbackOutcome> {
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    // Consume first: a replayed callback (same state) finds nothing.
    const attempt = state ? this.dropAttempt(state) : undefined;
    if (!attempt || attempt.expires <= this.now().getTime()) throw new OidcError('state', 'this sign-in attempt is unknown or expired');
    if (attempt.providerId !== providerId) throw new OidcError('state', 'the sign-in attempt belongs to another provider');
    if (!ctx.binding || hashToken(ctx.binding) !== attempt.bindingHash) throw new OidcError('state', 'the sign-in was started in another browser');
    if (typeof query['error'] === 'string') {
      throw new OidcError('provider', `the identity provider refused: ${query['error']}${typeof query['error_description'] === 'string' ? ` (${query['error_description']})` : ''}`);
    }
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    if (!code) throw new OidcError('provider', 'the identity provider sent no code');
    // RFC 9207: when the provider names itself in the response, it must be the expected issuer.
    const provider = this.provider(providerId);
    const { doc, keys } = await this.discovered(provider);
    if (typeof query['iss'] === 'string' && query['iss'] !== doc.issuer) throw new OidcError('token', 'the response came from another issuer');

    let tokens;
    try {
      tokens = await exchangeCode(this.fetchImpl, doc, { clientId: provider.clientId, clientSecret: provider.clientSecret, redirectUri: attempt.redirectUri, code, codeVerifier: attempt.codeVerifier });
    } catch (err) {
      this.log?.warn({ provider: providerId, err: err instanceof Error ? err.message : String(err) }, 'identity provider token exchange failed');
      throw new OidcError('token', 'the identity provider did not accept the sign-in code');
    }
    const idClaims = await verifyIdToken(tokens.idToken, keys, {
      issuer: doc.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      nonce: attempt.nonce,
      advertisedAlgs: doc.id_token_signing_alg_values_supported,
      now: this.now(),
    });
    let claims: Record<string, unknown> = { ...idClaims };
    if (tokens.accessToken && doc.userinfo_endpoint) {
      try {
        const info = await fetchUserinfo(this.fetchImpl, doc, tokens.accessToken, idClaims.sub);
        // The ID token is authoritative; userinfo fills in what it left out (often groups, email).
        claims = { ...info, ...idClaims };
      } catch (err) {
        if (err instanceof OidcError) throw err;
        this.log?.warn({ provider: providerId, err: err instanceof Error ? err.message : String(err) }, 'userinfo request failed; using the ID token claims only');
      }
    }

    if (attempt.linkUserId !== undefined) {
      if (ctx.sessionUserId !== attempt.linkUserId) throw new OidcError('state', 'sign in again to link this account');
      this.link(attempt.linkUserId, provider, idClaims.sub, claims);
      return { kind: 'linked', returnTo: attempt.returnTo, providerId };
    }
    const user = await this.accountFor(provider, idClaims.sub, claims, ctx.ip);
    const result = this.auth.loginAs(user.id, { ip: ctx.ip, userAgent: ctx.userAgent, rememberMe: attempt.rememberMe, method: `oidc:${providerId}` });
    audit(this.db).record({ action: 'login.success', userId: user.id, username: user.username, ip: ctx.ip ?? null, details: { method: `oidc:${providerId}` } });
    return { kind: 'login', result, returnTo: attempt.returnTo, providerId };
  }

  /** Claims → Arclight account: linked identity, else verified email (not admins), else a new account. */
  private async accountFor(provider: OidcProvider, subject: string, claims: Record<string, unknown>, ip?: string): Promise<User> {
    const groups = stringList(claims[provider.groupsClaim]);
    const decision = groupDecision(groups, provider);
    const fail = (failure: 'no_account' | 'forbidden' | 'link_conflict', message: string, username?: string): never => {
      audit(this.db).record({ action: 'login.failed', username: username ?? null, ip: ip ?? null, details: { method: `oidc:${provider.id}`, reason: message } });
      this.log?.warn({ provider: provider.id, subject, reason: message }, 'identity provider sign-in refused');
      throw new OidcError(failure, message);
    };
    if (!decision.allowed) fail('forbidden', 'not in an allowed group');

    const email = typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : '';
    const usable = email !== '' && (emailVerified(claims) || provider.trustUnverifiedEmail);
    const link = this.db.select().from(userIdentities).where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, subject))).get();
    let user: User | null = link ? this.auth.getUser(link.userId) : null;

    if (!user && provider.matchBy === 'email' && usable) {
      // Only emails an admin set or a provider vouched for: anyone can type any address into their profile.
      const matches = this.auth.findUsersByEmail(email).filter((u) => u.emailVerified);
      if (matches.length > 1) fail('no_account', 'several accounts use this email');
      const match = matches[0];
      if (match) {
        // An email claim is only as trustworthy as the provider's email checks: never hand an
        // admin account to it. Admins link their provider account from their profile instead.
        if (match.role === 'admin') fail('forbidden', 'admin accounts must link this sign-in from their profile first', match.username);
        if (this.hasLink(match.id, provider.id)) fail('link_conflict', 'that account is linked to another identity at this provider', match.username);
        user = toUser(match);
        this.insertLink(match.id, provider.id, subject, email);
      }
    }
    if (!user && provider.autoCreate) {
      const wanted = this.usernameFrom(provider, claims, subject);
      const created = await this.auth.createExternalUser({
        username: this.auth.freeUsername(wanted),
        email: usable ? email : undefined,
        displayName: typeof claims['name'] === 'string' ? claims['name'].slice(0, 100) : undefined,
        role: decision.role ?? provider.defaultRole,
      });
      this.insertLink(created.id, provider.id, subject, email || null);
      audit(this.db).record({ action: 'user.create', userId: created.id, username: created.username, details: { via: `oidc:${provider.id}` } });
      user = created;
    }
    if (!user) return fail('no_account', 'no Arclight account for this sign-in');
    if (emailVerified(claims)) this.vouchEmail(user.id, email);
    if (decision.role !== null) user = this.auth.syncRole(user.id, decision.role);
    this.db
      .update(userIdentities)
      .set({ lastLoginAt: this.now().toISOString(), ...(email ? { email } : {}) })
      .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, subject)))
      .run();
    return user;
  }

  private usernameFrom(provider: OidcProvider, claims: Record<string, unknown>, subject: string): string {
    const named = claims[provider.usernameClaim];
    if (typeof named === 'string' && named.trim()) return named.trim();
    const email = claims['email'];
    if (typeof email === 'string' && email.includes('@')) return email.split('@')[0]!;
    return `user-${subject.slice(0, 12)}`;
  }

  /** A provider verified this address for the account's own identity: the account's email counts as verified. */
  private vouchEmail(userId: number, email: string): void {
    if (!email) return;
    this.db
      .update(users)
      .set({ emailVerified: true })
      .where(and(eq(users.id, userId), eq(users.email, email), eq(users.emailVerified, false)))
      .run();
  }

  private hasLink(userId: number, providerId: string): boolean {
    return this.db.select({ id: userIdentities.id }).from(userIdentities).where(and(eq(userIdentities.userId, userId), eq(userIdentities.providerId, providerId))).get() !== undefined;
  }

  private insertLink(userId: number, providerId: string, subject: string, email: string | null): void {
    this.db.insert(userIdentities).values({ userId, providerId, subject, email, linkedAt: this.now().toISOString() }).run();
  }

  /** Links (or re-links) a provider account to a signed-in Arclight account. */
  private link(userId: number, provider: OidcProvider, subject: string, claims: Record<string, unknown>): void {
    const existing = this.db.select().from(userIdentities).where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, subject))).get();
    if (existing && existing.userId !== userId) throw new OidcError('link_conflict', 'that identity is linked to another Arclight account');
    const email = typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : null;
    if (email && emailVerified(claims)) this.vouchEmail(userId, email);
    if (existing) return;
    // One identity per provider per account: linking again replaces the old one.
    this.db.delete(userIdentities).where(and(eq(userIdentities.userId, userId), eq(userIdentities.providerId, provider.id))).run();
    this.insertLink(userId, provider.id, subject, email);
    audit(this.db).record({ action: 'user.identity.link', userId, details: { provider: provider.id } });
  }

  // ------------------------------------------------------------------------------- linked identities

  identities(userId: number): LinkedIdentity[] {
    const providers = this.settings().providers;
    return this.db.select().from(userIdentities).where(eq(userIdentities.userId, userId)).orderBy(userIdentities.id).all().map((r) => linkedOf(r, providers));
  }

  /**
   * Removes a link. `self`: the account owner, who may not remove their last way in (no
   * password, no passkey, no other link); admins removing someone's link are not stopped.
   */
  unlink(userId: number, identityId: number, self: boolean): void {
    const row = this.db.select().from(userIdentities).where(and(eq(userIdentities.id, identityId), eq(userIdentities.userId, userId))).get();
    if (!row) throw new AuthError('NOT_FOUND', `linked sign-in ${identityId} not found`);
    if (self) {
      const user = this.auth.userRow(userId);
      const others = this.identities(userId).filter((i) => i.id !== identityId).length;
      if (!user.localPassword && others === 0 && this.auth.twoFactor.passkeyCount(userId) === 0) {
        throw new AuthError('LAST_SIGN_IN_METHOD', 'this is your only way to sign in; set a password or add a passkey first');
      }
    }
    this.db.delete(userIdentities).where(eq(userIdentities.id, identityId)).run();
  }

  // ------------------------------------------------------------------------------- forward-auth

  private trustedProxies(list: readonly string[]): TrustedProxies {
    const key = list.join(',');
    if (this.proxies?.key !== key) this.proxies = { key, list: new TrustedProxies(list) };
    return this.proxies.list;
  }

  /**
   * Forward-auth: only when it is on, the TCP peer is a configured proxy and the user header is
   * present. Headers from any other peer are ignored, whatever X-Forwarded-For says. With
   * `allowAdmins` off, a header naming (or promoting to) an admin is ignored too.
   */
  async resolveForwardAuth(creds: RequestCredentials): Promise<RequestAuth | null> {
    const s = this.settings().forwardAuth;
    if (!s.enabled || !creds.header) return null;
    if (!this.trustedProxies(s.trustedProxies).trusts(creds.peer)) return null;
    const username = creds.header(s.userHeader)?.trim();
    if (!username) return null;
    const groups = s.groupsHeader ? stringList(creds.header(s.groupsHeader) ?? '') : [];
    const decision = groupDecision(groups, s);
    if (!decision.allowed) {
      this.log?.warn({ username }, 'forward-auth user not in an allowed group');
      return null;
    }
    const email = s.emailHeader ? (creds.header(s.emailHeader)?.trim().toLowerCase() ?? '') : '';
    let user = this.forwardUser(username, email);
    const refusedAdmin = (role: User['role']): boolean => {
      if (role !== 'admin' || s.allowAdmins) return false;
      this.log?.warn({ username }, 'forward-auth may not sign in admins; ignoring the header');
      return true;
    };
    if (user && refusedAdmin(decision.role ?? user.role)) return null;
    if (!user && s.autoCreate) {
      if (refusedAdmin(decision.role ?? s.defaultRole)) return null;
      const name = s.nameHeader ? creds.header(s.nameHeader)?.trim().slice(0, 100) : undefined;
      user = await this.auth.createExternalUser({
        username: this.auth.freeUsername(username),
        email: email || undefined,
        displayName: name || undefined,
        role: decision.role ?? s.defaultRole,
      });
      this.insertLink(user.id, FORWARD_AUTH_PROVIDER, username, email || null);
      audit(this.db).record({ action: 'user.create', userId: user.id, username: user.username, details: { via: FORWARD_AUTH_PROVIDER } });
    }
    if (!user) return null;
    if (decision.role !== null && decision.role !== user.role) user = this.auth.syncRole(user.id, decision.role);
    // syncRole keeps the only admin an admin, whatever the groups say.
    if (refusedAdmin(user.role)) return null;
    const isAdmin = user.role === 'admin';
    return { user, via: 'forward', isAdmin, appAccess: effectiveAppAccess(user, isAdmin) };
  }

  /** Header username → account: its forward-auth link, else the same username, else a unique non-admin email match. */
  private forwardUser(username: string, email: string): User | null {
    const link = this.db.select().from(userIdentities).where(and(eq(userIdentities.providerId, FORWARD_AUTH_PROVIDER), eq(userIdentities.subject, username))).get();
    if (link) return this.auth.getUser(link.userId);
    const byName = this.auth.findUserByUsername(username);
    if (byName) return toUser(byName);
    if (email) {
      const matches = this.auth.findUsersByEmail(email).filter((u) => u.role !== 'admin' && u.emailVerified);
      if (matches.length === 1) return toUser(matches[0]!);
    }
    return null;
  }
}
