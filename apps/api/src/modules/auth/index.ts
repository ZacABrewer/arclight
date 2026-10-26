import type { FastifyInstance } from 'fastify';
import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from './context.js';
import { installAuthHook } from './hook.js';
import { authRoutes } from './routes.js';
import { SetupService } from './setup.js';

export { authServiceFor } from './context.js';
export {
  requireAdmin,
  requireAuth,
  installAuthHook,
  isPublicRoute,
  PUBLIC_ROUTES,
  PUBLIC_PREFIXES,
  type PublicRoutePredicate,
} from './hook.js';
export { AuthService, AuthError, type RequestAuth } from './service.js';
export { SetupService } from './setup.js';
export { hashPassword, verifyPassword } from './password.js';
export { isLocalAddress } from './network.js';
export { SESSION_COOKIE } from './cookies.js';
export * from './schema.js';

/**
 * Called by app.ts on the /api/v1 scope before any module registers: decorates requests with
 * `auth`, adds the onRequest hook and makes sure the install has an API key.
 */
export function installAuth(scope: FastifyInstance, ctx: AppContext): void {
  const service = authServiceFor(ctx);
  service.ensureApiKey();
  installAuthHook(scope, service);
}

// Users, sessions, API key, security settings and first-run setup.
export const authModule: AppModule = (ctx) => async (app) => {
  const service = authServiceFor(ctx);
  await app.register(authRoutes(service, new SetupService(ctx.db, service)));
};
