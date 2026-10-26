import type { AppContext } from '../../app.js';
import { AuthService, type AuthServiceOptions } from './service.js';

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
