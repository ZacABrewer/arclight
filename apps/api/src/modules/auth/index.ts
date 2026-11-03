import type { FastifyInstance } from 'fastify';
import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor, identityServiceFor } from './context.js';
import { applicationUrlOf } from './routes-identity.js';
import { installAuthHook } from './hook.js';
import { authRoutes } from './routes.js';
import { SetupService } from './setup.js';
import { appAuthServiceFor } from '../app-auth/index.js';
import { ApplicationUrlCache } from '../../security-headers.js';
import { bindHttpsHint } from './cookies.js';
import { PortalOnlyHosts, portalHostGuard } from './portal-host-guard.js';

export { authServiceFor, identityServiceFor } from './context.js';
export { IdentityService } from './identity.js';
export {
  requireAdmin,
  requireAuth,
  requireSelfOrAdmin,
  installAuthHook,
  isPublicRoute,
  isPluginRoute,
  PLUGIN_ROUTE_PREFIX,
  isSetupBootstrapRoute,
  nonAdminMay,
  ADVANCED_REQUESTERS,
  PUBLIC_ROUTES,
  PUBLIC_PREFIXES,
  SETUP_BOOTSTRAP_ROUTES,
  type AuthHookOptions,
  type PublicRoutePredicate,
  type RouteAccess,
} from './hook.js';
export { AuthService, AuthError, toUser, effectiveAppAccess, type RequestAuth, type ExternalLoginProvider, type LoginResult, type PluginKeyRow } from './service.js';
export { SetupService } from './setup.js';
export { hashPassword, verifyPassword } from './password.js';
export { isLocalAddress } from './network.js';
export { SESSION_COOKIE, setSessionCookie } from './cookies.js';
export * from './schema.js';

/**
 * Called by app.ts on the /api/v1 scope before any module registers: decorates requests with
 * `auth`, adds the onRequest hook and makes sure the install has an API key.
 */
export function installAuth(scope: FastifyInstance, ctx: AppContext): void {
  const service = authServiceFor(ctx);
  service.ensureApiKey();
  // Registers the forward-auth resolver before the first request.
  identityServiceFor(ctx);
  // Registers the app device token (Bearer) resolver.
  appAuthServiceFor(ctx);
  // Cookies get Secure on the https Application URL's host even when the proxy in front does not
  // say the request was https (no X-Forwarded-Proto). Before the auth hook, which renews cookies.
  const appUrl = new ApplicationUrlCache(ctx.db);
  scope.addHook('onRequest', async (req) => {
    bindHttpsHint(req, () => appUrl.matches(req));
  });
  installAuthHook(scope, service);
  // Portal-only hostnames refuse the admin API to browser sign-ins (AUTH-25).
  scope.addHook('onRequest', portalHostGuard(new PortalOnlyHosts(ctx.db)));
}

// Users, sessions, API key, security settings and first-run setup.
export const authModule: AppModule = (ctx) => async (app) => {
  const service = authServiceFor(ctx);
  await app.register(
    authRoutes(service, new SetupService(ctx.db, service), identityServiceFor(ctx), { basePath: ctx.config.basePath ?? '', applicationUrl: applicationUrlOf(ctx.db) }),
  );
};
