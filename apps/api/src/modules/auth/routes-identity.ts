import { z } from 'zod';
import {
  IdentitySettings,
  IdentitySettingsResponse,
  LinkedIdentity,
  OidcLinkStart,
  OidcProviderId,
  OidcTestRequest,
  OidcTestResult,
  PasskeyLogin,
  PasskeyLoginOptionsRequest,
  PasskeyOptions,
  PasskeyRecord,
  PasskeyRegister,
  PasskeyRename,
  ReauthRequest,
  RecoveryCodes,
  Session,
  TotpCode,
  TotpSetup,
  TwoFactorLogin,
  TwoFactorProof,
  TwoFactorStatus,
  UserApiKey,
  UserApiKeyAdminRecord,
  UserApiKeyCreate,
  UserApiKeyCreated,
} from '@arclight/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getSection } from '../settings/service.js';
import { audit } from '../audit/recorder.js';
import { isHttps, readCookie, sessionCookie } from './cookies.js';
import { requireAdmin } from './hook.js';
import { safeReturnTo, type IdentityService } from './identity.js';
import { OidcError } from './oidc.js';
import { AuthError, toAuthError, type AuthService, type LoginResult } from './service.js';
import type { RelyingParty } from './two-factor.js';

// Routes for identity providers, two-factor, passkeys and per-user API keys. Registered inside
// authRoutes (same error handler). The /auth/oidc/* start and callback routes are full page
// loads: they answer with redirects, never JSON.

/** Browser-binding cookie of an OIDC sign-in in flight (the callback must come back to the same browser). */
export const OIDC_BINDING_COOKIE = 'al_oidc';

const portal = { access: { portal: true } } as const;
const Empty = z.null();
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ProviderParams = z.object({ id: OidcProviderId });
const UserIdentityParams = z.object({ id: z.coerce.number().int().positive(), identityId: z.coerce.number().int().positive() });
const OidcStartQuery = z.object({ returnTo: z.string().max(512).optional(), rememberMe: z.enum(['true', 'false']).optional() });
const OidcLinkBody = z.object({ returnTo: z.string().max(512).optional() }).nullish();
const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody, 429: ErrorBody };

export interface IdentityRouteOptions {
  /** '' or '/arclight': the sub-path the app is served under (redirects carry it). */
  basePath?: string;
  /** Configured public address of the app (Settings > Requests > Application URL). */
  applicationUrl?: () => string | null | undefined;
}

function bindingCookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [`${OIDC_BINDING_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Fastify appends repeated set-cookie headers instead of replacing them. */
function appendCookie(reply: FastifyReply, cookie: string): void {
  reply.header('set-cookie', cookie);
}

function selfId(req: FastifyRequest): number {
  const user = req.auth?.user;
  if (!user) throw new AuthError('VALIDATION', 'this request is not signed in as a user');
  return user.id;
}

function relyingParty(req: FastifyRequest): RelyingParty {
  return { id: req.hostname, origin: `${req.protocol}://${req.host}`, name: 'Arclight' };
}

function sessionBody(result: LoginResult): Session {
  return { user: result.user, via: 'session', isAdmin: result.user.role === 'admin', expiresAt: result.expiresAt };
}

/** `/login?ssoError=…` (or the linking page) under the base path. */
function withQuery(path: string, params: Record<string, string>): string {
  const [p, q] = path.split('?', 2) as [string, string | undefined];
  const search = new URLSearchParams(q ?? '');
  for (const [k, v] of Object.entries(params)) search.set(k, v);
  return `${p}?${search.toString()}`;
}

export function registerIdentityRoutes(
  app: FastifyInstance<RawServerDefault, import('http').IncomingMessage, import('http').ServerResponse, import('fastify').FastifyBaseLogger, ZodTypeProvider>,
  auth: AuthService,
  identity: IdentityService,
  opts: IdentityRouteOptions = {},
): void {
  const base = opts.basePath ?? '';
  const appBase = (req: FastifyRequest): string => {
    const configured = opts.applicationUrl?.()?.trim();
    if (configured && /^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, '');
    return `${req.protocol}://${req.host}${base}`;
  };
  const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toAuthError(err);
    }
  };

  // ----------------------------------------------------------------------------- second step of sign-in
  app.post('/auth/login/2fa', { config: { audit: false }, schema: { body: TwoFactorLogin, response: { 200: Session, ...errors } } }, async (req, reply) => {
    const result = auth.completeTwoFactor(req.body.challenge, { code: req.body.code, recoveryCode: req.body.recoveryCode }, req.ip);
    reply.header('set-cookie', sessionCookie(result.token, { maxAgeSeconds: result.maxAgeSeconds, secure: isHttps(req) }));
    return sessionBody(result);
  });

  app.post('/auth/passkey/options', { schema: { body: PasskeyLoginOptionsRequest.nullish(), response: { 200: PasskeyOptions, ...errors } } }, async (req) => {
    const out = await auth.passkeyOptions(relyingParty(req), req.body?.challenge);
    return { ceremony: out.ceremony, options: out.options };
  });

  app.post('/auth/passkey/login', { schema: { body: PasskeyLogin, response: { 200: Session, ...errors } } }, async (req, reply) => {
    const result = await auth.loginWithPasskey(req.body.ceremony, req.body.response, req.body.challenge, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      rememberMe: req.body.rememberMe,
    });
    reply.header('set-cookie', sessionCookie(result.token, { maxAgeSeconds: result.maxAgeSeconds, secure: isHttps(req) }));
    return sessionBody(result);
  });

  // ----------------------------------------------------------------------------- OpenID Connect
  app.get('/auth/oidc/:id/start', { schema: { params: ProviderParams, querystring: OidcStartQuery } }, async (req, reply) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    try {
      const out = await identity.start(req.params.id, { appBase: appBase(req), returnTo, rememberMe: req.query.rememberMe !== 'false', peer: req.ip });
      appendCookie(reply, bindingCookie(out.binding, 600, isHttps(req)));
      return reply.redirect(out.url, 302);
    } catch (err) {
      if (!(err instanceof OidcError)) throw err;
      return reply.redirect(`${base}${withQuery('/login', { ssoError: err.failure, returnTo })}`, 302);
    }
  });

  app.get('/auth/oidc/:id/callback', { schema: { params: ProviderParams } }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const returnTo = identity.returnToOf(query['state']);
    const binding = readCookie(req.headers.cookie, OIDC_BINDING_COOKIE);
    appendCookie(reply, bindingCookie('', 0, isHttps(req)));
    const sessionUserId = req.auth?.via === 'session' && req.auth.user ? req.auth.user.id : null;
    try {
      const out = await identity.callback(req.params.id, query, { binding, sessionUserId, ip: req.ip, userAgent: req.headers['user-agent'] });
      if (out.kind === 'linked') return reply.redirect(`${base}${withQuery(out.returnTo, { linked: out.providerId })}`, 302);
      appendCookie(reply, sessionCookie(out.result.token, { maxAgeSeconds: out.result.maxAgeSeconds, secure: isHttps(req) }));
      return reply.redirect(`${base}${out.returnTo}`, 302);
    } catch (err) {
      const failure = err instanceof OidcError ? err.failure : err instanceof AuthError && err.code === 'FORBIDDEN' ? 'forbidden' : null;
      if (failure === null) {
        req.log.error({ err }, 'identity provider callback failed');
      } else {
        req.log.warn({ provider: req.params.id, failure, reason: err instanceof Error ? err.message : String(err) }, 'identity provider sign-in failed');
      }
      // A link flow returns to the page it came from (the profile); a sign-in to the login page.
      const target = sessionUserId !== null && returnTo !== '/' ? returnTo : withQuery('/login', { returnTo });
      return reply.redirect(`${base}${withQuery(target, { ssoError: failure ?? 'provider' })}`, 302);
    }
  });

  app.post('/auth/oidc/:id/link', { config: portal, schema: { params: ProviderParams, body: OidcLinkBody, response: { 200: OidcLinkStart, ...errors } } }, async (req, reply) => {
    const userId = selfId(req);
    if (req.auth?.via !== 'session') throw new AuthError('FORBIDDEN', 'link sign-ins from a signed-in browser session');
    try {
      const out = await identity.start(req.params.id, { appBase: appBase(req), returnTo: req.body?.returnTo ?? '/profile', linkUserId: userId, peer: req.ip });
      appendCookie(reply, bindingCookie(out.binding, 600, isHttps(req)));
      return { url: out.url };
    } catch (err) {
      if (err instanceof OidcError) throw new AuthError(err.failure === 'disabled' ? 'NOT_FOUND' : err.failure === 'rate_limited' ? 'RATE_LIMITED' : 'VALIDATION', err.message);
      throw err;
    }
  });

  // ----------------------------------------------------------------------------- own account
  app.get('/user/me/2fa', { config: portal, schema: { response: { 200: TwoFactorStatus, ...errors } } }, async (req) =>
    auth.twoFactor.status(selfId(req), auth.twoFactorSetupRequired(req.auth)),
  );

  // Adding a way in (authenticator app, passkey, API key) needs a recent sign-in or the password
  // (requireRecentAuth). Finishing a TOTP setup or a passkey registration is bound to the secret
  // or ceremony these gated calls hand out, so the follow-up calls need no second check.
  app.post('/user/me/2fa/totp/setup', { config: portal, schema: { body: ReauthRequest.nullish(), response: { 200: TotpSetup, ...errors } } }, async (req) => {
    const user = auth.getUser(selfId(req));
    await auth.requireRecentAuth(req.auth, req.body?.currentPassword, req.ip);
    return wrap(() => auth.twoFactor.beginTotp(user.id, user.username));
  });

  // Bodies carry TOTP and recovery codes: these keep out of the request audit and record their own entries.
  app.post('/user/me/2fa/totp/enable', { config: { ...portal, audit: false }, schema: { body: TotpCode, response: { 200: RecoveryCodes, ...errors } } }, async (req) => {
    const userId = selfId(req);
    const codes = await wrap(() => auth.twoFactor.enableTotp(userId, req.body.code));
    audit(auth.db).record({ action: 'user.2fa.enable', userId, ip: req.ip });
    return { codes };
  });

  app.delete('/user/me/2fa/totp', { config: { ...portal, audit: false }, schema: { body: TwoFactorProof, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    const userId = selfId(req);
    await wrap(() => auth.twoFactor.disableTotp(userId, req.body));
    audit(auth.db).record({ action: 'user.2fa.disable', userId, ip: req.ip });
    return reply.code(204).send(null);
  });

  app.post('/user/me/2fa/recovery', { config: { ...portal, audit: false }, schema: { body: TwoFactorProof, response: { 200: RecoveryCodes, ...errors } } }, async (req) => {
    const userId = selfId(req);
    const codes = await wrap(() => auth.twoFactor.regenerateRecoveryCodes(userId, req.body));
    audit(auth.db).record({ action: 'user.2fa.recovery', userId, ip: req.ip });
    return { codes };
  });

  app.get('/user/me/passkeys', { config: portal, schema: { response: { 200: z.array(PasskeyRecord), ...errors } } }, async (req) =>
    auth.twoFactor.listPasskeys(selfId(req)),
  );

  app.post('/user/me/passkeys/options', { config: portal, schema: { body: ReauthRequest.nullish(), response: { 200: PasskeyOptions, ...errors } } }, async (req) => {
    const user = auth.getUser(selfId(req));
    await auth.requireRecentAuth(req.auth, req.body?.currentPassword, req.ip);
    return wrap(() => auth.twoFactor.registrationOptions({ id: user.id, username: user.username, displayName: user.displayName ?? undefined }, relyingParty(req)));
  });

  app.post('/user/me/passkeys', { config: portal, schema: { body: PasskeyRegister, response: { 201: PasskeyRecord, ...errors } } }, async (req, reply) => {
    const userId = selfId(req);
    const record = await wrap(() => auth.twoFactor.register(userId, req.body.ceremony, req.body.name, req.body.response));
    audit(auth.db).record({ action: 'user.passkey.add', userId, ip: req.ip });
    return reply.code(201).send(record);
  });

  app.put('/user/me/passkeys/:id', { config: portal, schema: { params: IdParams, body: PasskeyRename, response: { 200: PasskeyRecord, ...errors } } }, async (req) =>
    wrap(() => auth.twoFactor.renamePasskey(selfId(req), req.params.id, req.body.name)),
  );

  app.delete('/user/me/passkeys/:id', { config: portal, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    const userId = selfId(req);
    const user = auth.userRow(userId);
    // Same rule as unlinking: an account without a password keeps at least one way in.
    if (!user.localPassword && identity.identities(userId).length === 0 && auth.twoFactor.passkeyCount(userId) <= 1) {
      throw new AuthError('LAST_SIGN_IN_METHOD', 'this is your only way to sign in; set a password or link a sign-in first');
    }
    await wrap(() => auth.twoFactor.removePasskey(userId, req.params.id));
    audit(auth.db).record({ action: 'user.passkey.remove', userId, ip: req.ip });
    return reply.code(204).send(null);
  });

  app.get('/user/me/identities', { config: portal, schema: { response: { 200: z.array(LinkedIdentity), ...errors } } }, async (req) =>
    identity.identities(selfId(req)),
  );

  app.delete('/user/me/identities/:id', { config: portal, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    identity.unlink(selfId(req), req.params.id, true);
    return reply.code(204).send(null);
  });

  app.get('/user/me/apikeys', { config: portal, schema: { response: { 200: z.array(UserApiKey), ...errors } } }, async (req) =>
    auth.apiKeys.list(selfId(req)),
  );

  app.post('/user/me/apikeys', { config: portal, schema: { body: UserApiKeyCreate, response: { 201: UserApiKeyCreated, ...errors } } }, async (req, reply) => {
    const userId = selfId(req);
    const { currentPassword, ...input } = req.body;
    if (input.scope === 'admin' && auth.getUser(userId).role !== 'admin') throw new AuthError('FORBIDDEN', 'only admins can create admin keys');
    await auth.requireRecentAuth(req.auth, currentPassword, req.ip);
    const created = auth.apiKeys.create(userId, input);
    audit(auth.db).record({ action: 'user.apikey.create', userId, ip: req.ip, details: { name: created.name, scope: created.scope } });
    return reply.code(201).send(created);
  });

  app.delete('/user/me/apikeys/:id', { config: portal, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    const userId = selfId(req);
    await wrap(() => auth.apiKeys.revoke(req.params.id, userId));
    audit(auth.db).record({ action: 'user.apikey.revoke', userId, ip: req.ip, target: req.params.id });
    return reply.code(204).send(null);
  });

  // ----------------------------------------------------------------------------- admin
  app.get('/settings/identity', { preHandler: requireAdmin, schema: { response: { 200: IdentitySettingsResponse, ...errors } } }, async (req) =>
    identity.response(appBase(req)),
  );

  app.put('/settings/identity', { preHandler: requireAdmin, schema: { body: IdentitySettings, response: { 200: IdentitySettingsResponse, ...errors } } }, async (req) => {
    identity.update(req.body, { userId: req.auth?.user?.id ?? null });
    return identity.response(appBase(req));
  });

  app.post('/settings/identity/test', { preHandler: requireAdmin, schema: { body: OidcTestRequest, response: { 200: OidcTestResult, ...errors } } }, async (req) =>
    identity.test(req.body.issuer),
  );

  app.get('/user/:id/2fa', { preHandler: requireAdmin, schema: { params: IdParams, response: { 200: TwoFactorStatus, ...errors } } }, async (req) => {
    const user = auth.getUser(req.params.id);
    const required = user.role === 'admin' && identity.settings().requireTwoFactorForAdmins && !auth.twoFactor.hasSecondFactor(user.id);
    return auth.twoFactor.status(user.id, required);
  });

  app.delete('/user/:id/2fa', { preHandler: requireAdmin, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    const user = auth.getUser(req.params.id);
    auth.twoFactor.reset(user.id);
    // The reset is for someone who lost their device: end their sessions too.
    if (req.auth?.user?.id !== user.id) auth.revokeAllSessions(user.id);
    audit(auth.db).record({ action: 'user.2fa.reset', userId: req.auth?.user?.id ?? null, target: user.id, ip: req.ip });
    return reply.code(204).send(null);
  });

  app.get('/user/:id/identities', { preHandler: requireAdmin, schema: { params: IdParams, response: { 200: z.array(LinkedIdentity), ...errors } } }, async (req) => {
    auth.getUser(req.params.id);
    return identity.identities(req.params.id);
  });

  app.delete('/user/:id/identities/:identityId', { preHandler: requireAdmin, schema: { params: UserIdentityParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    identity.unlink(req.params.id, req.params.identityId, req.auth?.user?.id === req.params.id);
    return reply.code(204).send(null);
  });

  app.get('/apikeys', { preHandler: requireAdmin, schema: { response: { 200: z.array(UserApiKeyAdminRecord), ...errors } } }, async () => auth.apiKeys.listAll());

  app.delete('/apikeys/:id', { preHandler: requireAdmin, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
    await wrap(() => auth.apiKeys.revoke(req.params.id, null));
    audit(auth.db).record({ action: 'user.apikey.revoke', userId: req.auth?.user?.id ?? null, target: req.params.id, ip: req.ip });
    return reply.code(204).send(null);
  });
}

/** The configured Application URL (requests settings), for OIDC redirect URIs. */
export function applicationUrlOf(db: AuthService['db']): () => string | null {
  return () => getSection(db, 'requests').applicationUrl || null;
}
