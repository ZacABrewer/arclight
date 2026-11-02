import type { AppContext } from '../../app.js';
import { AuthService, type AuthServiceOptions } from './service.js';
import { IdentityService, type IdentityServiceOptions } from './identity.js';

// One AuthService per app context so the hook, the auth routes and any other module see the
// same instance (and the same failed-login counters).
const services = new WeakMap<AppContext, AuthService>();

/** `overrides` apply only when this call creates the instance (tests inject a clock). */
export function authServiceFor(ctx: AppContext, overrides: Partial<Omit<AuthServiceOptions, 'db'>> = {}): AuthService {
  let service = services.get(ctx);
  if (!service) {
    service = new AuthService({ db: ctx.db, log: ctx.log.child({ module: 'auth' }), ...overrides });
    services.set(ctx, service);
  }
  return service;
}

const identities = new WeakMap<AppContext, IdentityService>();

/**
 * The identity-provider / forward-auth service of an app context (registers the forward-auth
 * resolver on the AuthService). `overrides` apply only when this call creates it (tests inject
 * fetch and signing keys).
 */
export function identityServiceFor(ctx: AppContext, overrides: Partial<Omit<IdentityServiceOptions, 'db' | 'auth'>> = {}): IdentityService {
  let service = identities.get(ctx);
  if (!service) {
    service = new IdentityService({ db: ctx.db, auth: authServiceFor(ctx), log: ctx.log.child({ module: 'identity' }), ...overrides });
    identities.set(ctx, service);
  }
  return service;
}
