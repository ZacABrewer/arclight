import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type AuthService, type RequestAuth, type RequestCredentials } from './service.js';
import { readCookie, SESSION_COOKIE, setSessionCookie } from './cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every /api/v1 request; null when anonymous. */
    auth: RequestAuth | null;
  }
  interface FastifyContextConfig {
    /**
     * Users with role `user` may call this route even though it changes state. Without it,
     * non-admin users are limited to GET/HEAD.
     */
    allowUser?: boolean;
  }
}

export const API_PREFIX = '/api/v1';

/** Routes (relative to /api/v1) that answer without credentials. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/status',
  '/system/ping',
  // Calendar apps cannot send headers; the feed checks its own token.
  '/calendar/feed.ics',
]);
/** Route prefixes that answer without credentials; the setup routes guard themselves. */
export const PUBLIC_PREFIXES: readonly string[] = ['/setup/'];

/** Decided on the matched route pattern, so encoded or dotted paths cannot sneak through. */
export function isPublicRoute(routeUrl: string | undefined): boolean {
  if (!routeUrl?.startsWith(API_PREFIX)) return false;
  const rel = routeUrl.slice(API_PREFIX.length);
  return PUBLIC_ROUTES.has(rel) || PUBLIC_PREFIXES.some((p) => rel.startsWith(p));
}

function parseBasic(header: string | undefined): RequestCredentials['basic'] {
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return undefined;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
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
    // The socket peer plus every forwarded address; all must be local for the bypass.
    addresses: [req.socket.remoteAddress, ...(req.ips ?? [req.ip])],
  };
}

function unauthorized(reply: FastifyReply, basic: boolean) {
  if (basic) reply.header('www-authenticate', 'Basic realm="Arclight", charset="UTF-8"');
  return reply.code(401).send({ error: 'authentication required', code: 'UNAUTHORIZED' });
}

/**
 * The onRequest hook for every /api/v1 route: resolves `req.auth`, then refuses anonymous
 * callers on non-public routes (401) and non-admin users on state-changing routes that did
 * not opt in with `config.allowUser` (403).
 */
/** Decides whether a matched route pattern answers without credentials. */
export type PublicRoutePredicate = (routeUrl: string | undefined) => boolean;

export function requireAuth(service: AuthService, isPublic: PublicRoutePredicate = isPublicRoute) {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
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
    if (isPublic(req.routeOptions.url)) return;
    if (!req.auth) return unauthorized(reply, service.security().method === 'basic');
    if (!req.auth.isAdmin && req.method !== 'GET' && req.method !== 'HEAD' && !req.routeOptions.config?.allowUser) {
      return reply.code(403).send({ error: 'admin only', code: 'FORBIDDEN' });
    }
  };
}

/**
 * preHandler for admin-only routes. Use per route (`{ preHandler: requireAdmin }`) or for a
 * whole plugin (`app.addHook('preHandler', requireAdmin)`). Fails closed when the auth hook
 * did not run.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: 'authentication required', code: 'UNAUTHORIZED' });
    return;
  }
  if (!req.auth.isAdmin) await reply.code(403).send({ error: 'admin only', code: 'FORBIDDEN' });
}

/**
 * Decorates requests with `auth` and adds the hook to `scope`. app.ts installs it (through
 * `installAuth`) on the /api/v1 plugin with the default public-route rules. Encapsulated scopes
 * outside /api/v1 (the compat module's /api/v3) install the same hook with their own predicate,
 * so every API surface resolves credentials (cookie, Basic, X-Api-Key / ?apikey=, local bypass)
 * identically.
 */
export function installAuthHook(
  scope: FastifyInstance,
  service: AuthService,
  isPublic: PublicRoutePredicate = isPublicRoute,
): void {
  scope.decorateRequest('auth', null);
  scope.addHook('onRequest', requireAuth(service, isPublic));
}
