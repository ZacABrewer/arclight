import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { APP_TOKEN_PREFIX, Permission, type AppArea } from '@arclight/shared';
import { AuthError, type AuthService, type RequestAuth, type RequestCredentials } from './service.js';
import { readCookie, SESSION_COOKIE, setSessionCookie } from './cookies.js';

/**
 * Who besides admins may call a route. A route without it is admin-only for every method,
 * GET, HEAD and the WebSocket upgrade included: a new route stays closed to non-admins until it
 * opts in here, and the route-table test (src/access.test.ts) must list it.
 */
export interface RouteAccess {
  /**
   * Every signed-in user (the request portal), every method. The handler or service still
   * scopes the work to the caller (own requests, own account) or checks permission bits.
   */
  portal?: boolean;
  /** Read-only (GET/HEAD) for users an admin granted one of these app areas. */
  areas?: readonly AppArea[];
  /** Read-only (GET/HEAD) for users holding at least one of these permission bits. */
  permissions?: readonly number[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every API request; null when anonymous. */
    auth: RequestAuth | null;
  }
  interface FastifyContextConfig {
    /** Non-admin access to this route; absent: admins (and the API key) only. */
    access?: RouteAccess;
    /**
     * Evaluated per request: when it returns true the route answers without credentials (like
     * PUBLIC_ROUTES), e.g. discover while the public request portal is enabled. The route
     * still sees `req.auth` when credentials were sent.
     */
    publicWhen?: (req: FastifyRequest) => boolean;
  }
}

export const API_PREFIX = '/api/v1';

/** Routes (relative to /api/v1) that answer without credentials. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/status',
  // Plex PIN sign-in (requests module); the poll only signs in once plex.tv confirms the PIN.
  '/auth/plex/pin',
  '/auth/plex/poll',
  // Second step of a password sign-in, passkey sign-in, identity-provider redirects.
  '/auth/login/2fa',
  '/auth/passkey/options',
  '/auth/passkey/login',
  '/auth/oidc/:id/start',
  '/auth/oidc/:id/callback',
  '/system/ping',
  // Calendar apps cannot send headers; the feed checks its own token.
  '/calendar/feed.ics',
  // Plex cannot send credentials with webhooks; the URL carries a per-server token.
  '/plex/webhook',
  // Theme catalogue and pack files: the sign-in page is themed too, and they hold nothing private.
  '/theme',
  '/theme/:id/theme.css',
  '/theme/:id/fonts/:file',
  // The Arclight player app's sign-in and QR pairing (rate-limited by the auth service).
  '/app/sign-in',
  '/app/pair',
  // TV sign-in: the TV asks for a code and polls; approval needs a signed-in browser (below).
  '/app/device-codes',
  '/app/device-codes/poll',
]);
/** Route prefixes that answer without credentials; the setup routes guard themselves. */
export const PUBLIC_PREFIXES: readonly string[] = ['/setup/'];

/** Routes a Jellyfin plugin key may call (decided on the matched route pattern). */
export const PLUGIN_ROUTE_PREFIX = `${API_PREFIX}/jellyfin/`;

export function isPluginRoute(routeUrl: string | undefined): boolean {
  return routeUrl?.startsWith(PLUGIN_ROUTE_PREFIX) ?? false;
}

/** Decided on the matched route pattern, so encoded or dotted paths cannot sneak through. */
export function isPublicRoute(routeUrl: string | undefined): boolean {
  if (!routeUrl?.startsWith(API_PREFIX)) return false;
  const rel = routeUrl.slice(API_PREFIX.length);
  return PUBLIC_ROUTES.has(rel) || PUBLIC_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * Routes (relative to /api/v1) that answer before an admin account exists. Everything else,
 * the API key included, answers 403 SETUP_REQUIRED until the setup wizard (or a headless
 * POST /setup/complete) has created the admin.
 */
export const SETUP_BOOTSTRAP_ROUTES: ReadonlySet<string> = new Set(['/auth/status', '/setup/status', '/setup/admin', '/setup/complete', '/system/ping']);

export function isSetupBootstrapRoute(routeUrl: string | undefined): boolean {
  if (!routeUrl?.startsWith(API_PREFIX)) return false;
  return SETUP_BOOTSTRAP_ROUTES.has(routeUrl.slice(API_PREFIX.length));
}

/**
 * Users who pick a root folder, quality profile and tags when they request (Seerr's "advanced
 * requests"): they may read those lists.
 */
export const ADVANCED_REQUESTERS: readonly number[] = [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS];

/** True when a signed-in non-admin may call a route with this access on this method. */
export function nonAdminMay(auth: RequestAuth, method: string, access: RouteAccess | undefined): boolean {
  if (!access) return false;
  if (access.portal === true) return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (access.areas?.some((a) => auth.appAccess.includes(a))) return true;
  const held = (auth.user?.permissions ?? 0) & ~Permission.ADMIN;
  return (access.permissions ?? []).some((p) => p !== 0 && (held & p) === p);
}

/**
 * Routes that reveal or change install-wide secrets (the global API key, provider secrets,
 * backups with every credential): only sessions and admin-scoped keys, never narrower keys.
 * Full route patterns, since the hook also guards /api/v3.
 */
export const SECRET_ROUTES: ReadonlySet<string> = new Set([
  `${API_PREFIX}/settings/security`,
  `${API_PREFIX}/settings/security/apikey`,
  `${API_PREFIX}/settings/identity`,
  `${API_PREFIX}/apikeys`,
  `${API_PREFIX}/apikeys/:id`,
  `${API_PREFIX}/config/export`,
  `${API_PREFIX}/system/backup/:id/download`,
  '/api/v3/config/host',
]);

/**
 * Routes a per-user API key may never call, whatever its scope: managing the account's own
 * credentials needs a signed-in browser session, so a leaked key cannot mint more keys, turn
 * off two-factor or link another sign-in.
 */
export const SESSION_ONLY_PREFIXES: readonly string[] = [
  `${API_PREFIX}/user/me/2fa`,
  `${API_PREFIX}/user/me/passkeys`,
  `${API_PREFIX}/user/me/identities`,
  `${API_PREFIX}/user/me/apikeys`,
  `${API_PREFIX}/user/me/password`,
  `${API_PREFIX}/auth/oidc/`,
  `${API_PREFIX}/auth/sessions`,
  // A pairing code signs in another device: only from a browser session.
  `${API_PREFIX}/app/pair-codes`,
  // Approving a TV's device code signs that TV in: only from a browser session.
  `${API_PREFIX}/app/device-codes/approve`,
];

/**
 * Whether a per-user key (`via: 'userkey'`) or an app device token (`via: 'app'`) may call this
 * route on this method. App tokens act as their user everywhere except the session-only routes
 * (own credentials, pairing codes) and the install-wide secrets, so a lost phone cannot mint
 * keys, turn off two-factor or read the API key.
 */
export function apiKeyScopeAllows(auth: RequestAuth, method: string, routeUrl: string | undefined): boolean {
  if (auth.via === 'app') {
    if (!routeUrl) return false;
    return !SESSION_ONLY_PREFIXES.some((p) => routeUrl.startsWith(p)) && !SECRET_ROUTES.has(routeUrl);
  }
  if (auth.via !== 'userkey') return true;
  if (!routeUrl) return false;
  if (SESSION_ONLY_PREFIXES.some((p) => routeUrl.startsWith(p))) return false;
  if (auth.apiKeyScope === 'read' && method !== 'GET' && method !== 'HEAD') return false;
  if (auth.apiKeyScope !== 'admin' && SECRET_ROUTES.has(routeUrl)) return false;
  return true;
}

/**
 * While "require two-factor for admins" applies to a request (twoFactorSetupRequired), only
 * these answer: who am I, sign out, and setting up the second factor.
 */
export const TWO_FACTOR_SETUP_ROUTES: readonly string[] = [
  `${API_PREFIX}/auth/me`,
  `${API_PREFIX}/auth/status`,
  `${API_PREFIX}/auth/logout`,
  `${API_PREFIX}/auth/sessions`,
  `${API_PREFIX}/user/me`,
  `${API_PREFIX}/user/me/2fa`,
  `${API_PREFIX}/user/me/passkeys`,
  `${API_PREFIX}/system/ping`,
  `${API_PREFIX}/theme`,
];

function allowedDuringTwoFactorSetup(method: string, routeUrl: string | undefined): boolean {
  if (!routeUrl) return false;
  if (routeUrl === `${API_PREFIX}/user/me`) return method === 'GET' || method === 'HEAD';
  return TWO_FACTOR_SETUP_ROUTES.some((p) => routeUrl === p || routeUrl.startsWith(`${p}/`));
}

function parseBasic(header: string | undefined): RequestCredentials['basic'] {
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return undefined;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** `Authorization: Bearer alt_…` (other bearer tokens are not Arclight's and are ignored). */
function parseBearer(header: string | undefined): string | undefined {
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token.startsWith(APP_TOKEN_PREFIX) ? token : undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Pulls every credential a request may carry. */
export function credentialsOf(req: FastifyRequest): RequestCredentials {
  const query = (req.query ?? {}) as Record<string, unknown>;
  return {
    sessionToken: readCookie(req.headers.cookie, SESSION_COOKIE),
    apiKey: firstString(req.headers['x-api-key']) ?? firstString(query['apikey']),
    basic: parseBasic(req.headers.authorization),
    bearer: parseBearer(req.headers.authorization),
    // The socket peer plus every forwarded address; all must be local for the bypass.
    addresses: addressesOf(req),
    // Forward-auth trusts the TCP peer only: X-Forwarded-For is whatever the client sent.
    peer: (req.socket as FastifyRequest['socket'] | undefined)?.remoteAddress,
    header: (name) => firstString(req.headers[name.toLowerCase()]),
  };
}

/** Peer and forwarded addresses; none (so no local bypass) when the request has no socket. */
function addressesOf(req: FastifyRequest): (string | undefined)[] {
  const peer = (req.socket as FastifyRequest['socket'] | undefined)?.remoteAddress;
  if (peer === undefined) return [];
  try {
    return [peer, ...(req.ips ?? [req.ip])];
  } catch {
    return [];
  }
}

function unauthorized(reply: FastifyReply, basic: boolean) {
  if (basic) reply.header('www-authenticate', 'Basic realm="Arclight", charset="UTF-8"');
  return reply.code(401).send({ error: 'authentication required', code: 'UNAUTHORIZED' });
}

/** Decides something about a matched route pattern (public, setup bootstrap). */
export type PublicRoutePredicate = (routeUrl: string | undefined) => boolean;

export interface AuthHookOptions {
  /** Routes answering without credentials (default: the /api/v1 rules). */
  isPublic?: PublicRoutePredicate;
  /** Routes answering before an admin exists (default: the /api/v1 SETUP_BOOTSTRAP_ROUTES). */
  setupBootstrap?: PublicRoutePredicate;
}

/**
 * The onRequest hook for every API route, in this order:
 * 1. no admin account yet: 403 SETUP_REQUIRED, except the setup bootstrap routes;
 * 2. resolve `req.auth` (app token, session cookie, Basic, API keys, plugin key, forward-auth,
 *    local bypass);
 * 3. a per-user key or app token outside its scope gets 403; an admin who must set up two-factor gets 403
 *    TWO_FACTOR_SETUP_REQUIRED outside the setup routes;
 * 4. public routes answer; anonymous callers elsewhere get 401;
 * 5. a Jellyfin plugin key passes on /api/v1/jellyfin/* and gets 403 anywhere else;
 * 6. admins (and API-key / bypass callers) pass; anyone else needs the route's
 *    `config.access` to admit them for this method (nonAdminMay), else 403.
 */
export function requireAuth(service: AuthService, options: AuthHookOptions | PublicRoutePredicate = {}) {
  const opts: AuthHookOptions = typeof options === 'function' ? { isPublic: options } : options;
  const isPublic = opts.isPublic ?? isPublicRoute;
  const setupBootstrap = opts.setupBootstrap ?? isSetupBootstrapRoute;
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const routeUrl = req.routeOptions.url;
    if (!setupBootstrap(routeUrl) && !service.hasAdmin()) {
      return reply.code(403).send({ error: 'create the admin account first (setup wizard)', code: 'SETUP_REQUIRED' });
    }
    let resolved;
    try {
      resolved = await service.resolve(credentialsOf(req));
    } catch (err) {
      // Rate limiting of Basic credentials surfaces here.
      if (err instanceof AuthError && err.code === 'RATE_LIMITED') {
        return reply.code(429).send({ error: err.message, code: err.code });
      }
      throw err;
    }
    req.auth = resolved.auth;
    if (resolved.renewed && resolved.auth?.via === 'session') {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (token) setSessionCookie(req, reply, token, resolved.renewed.maxAgeSeconds);
    }
    if (req.auth && !apiKeyScopeAllows(req.auth, req.method, routeUrl)) {
      const error = req.auth.via === 'app' ? 'the Arclight app may not call this; use the web app' : `this API key (${req.auth.apiKeyScope ?? 'read'} scope) may not call this`;
      return reply.code(403).send({ error, code: 'FORBIDDEN' });
    }
    if (req.auth && !isPublic(routeUrl) && !allowedDuringTwoFactorSetup(req.method, routeUrl) && service.twoFactorSetupRequired(req.auth)) {
      return reply.code(403).send({ error: 'set up two-factor sign-in on your account first', code: 'TWO_FACTOR_SETUP_REQUIRED' });
    }
    if (isPublic(routeUrl)) return;
    if (!req.auth && (req.method === 'GET' || req.method === 'HEAD')) {
      const when = req.routeOptions.config?.publicWhen;
      if (when && when(req)) return;
    }
    if (!req.auth) return unauthorized(reply, service.security().method === 'basic');
    if (req.auth.via === 'plugin') {
      if (isPluginRoute(routeUrl)) return;
      return reply.code(403).send({ error: 'this key may only call /api/v1/jellyfin/*', code: 'FORBIDDEN' });
    }
    if (req.auth.isAdmin) return;
    if (!nonAdminMay(req.auth, req.method, req.routeOptions.config?.access)) {
      return reply.code(403).send({ error: 'admin only', code: 'FORBIDDEN' });
    }
  };
}

/**
 * preHandler for admin-only routes. Use per route (`{ preHandler: requireAdmin }`) or for a
 * whole plugin (`app.addHook('preHandler', requireAdmin)`). Fails closed when the auth hook
 * did not run. (The auth hook already refuses non-admins on routes without `config.access`;
 * this is a second lock for routes that must never open.)
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: 'authentication required', code: 'UNAUTHORIZED' });
    return;
  }
  if (!req.auth.isAdmin) await reply.code(403).send({ error: 'admin only', code: 'FORBIDDEN' });
}

/**
 * preHandler for `/user/:id/...` routes open to the portal: a non-admin may only act on their
 * own account (`:id` is theirs), whatever permission bits they hold. Admins pass.
 */
export async function requireSelfOrAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: 'authentication required', code: 'UNAUTHORIZED' });
    return;
  }
  if (req.auth.isAdmin) return;
  const id = Number((req.params as { id?: unknown } | undefined)?.id);
  if (!req.auth.user || !Number.isInteger(id) || req.auth.user.id !== id) {
    await reply.code(403).send({ error: 'you can only change your own account', code: 'FORBIDDEN' });
  }
}

/**
 * Decorates requests with `auth` and adds the hook to `scope`. app.ts installs it (through
 * `installAuth`) on the /api/v1 plugin with the default public-route rules. Encapsulated scopes
 * outside /api/v1 (the compat module's /api/v3, /metrics) install the same hook with their own
 * predicates, so every API surface resolves credentials (cookie, Basic, X-Api-Key / ?apikey=,
 * local bypass) and refuses non-admins identically.
 */
export function installAuthHook(scope: FastifyInstance, service: AuthService, options: AuthHookOptions | PublicRoutePredicate = {}): void {
  scope.decorateRequest('auth', null);
  scope.addHook('onRequest', requireAuth(service, options));
}
