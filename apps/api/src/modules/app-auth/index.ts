import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/context.js';
import { normaliseServerUrl } from '../mobile/service.js';
import { getSection } from '../settings/service.js';
import { appAuthRoutes } from './routes.js';
import { AppAuthService, type AppAuthServiceOptions } from './service.js';

export { AppAuthService, AppAuthError, generateAppToken, generatePairCode, APP_DEVICE_TOUCH_MS, PAIR_CODES_PER_WINDOW } from './service.js';
export { appDevices, type AppDeviceRow } from './schema.js';

// The Arclight player app (apps/player): device tokens instead of the session cookie. Registers
// the Bearer resolver on the auth service (so `Authorization: Bearer alt_…` authenticates every
// route the token's user may call) and the /app routes.

const services = new WeakMap<AppContext, AppAuthService>();

/** `overrides` apply only when this call creates the instance (tests inject a clock). */
export function appAuthServiceFor(ctx: AppContext, overrides: Partial<Omit<AppAuthServiceOptions, 'db' | 'auth'>> = {}): AppAuthService {
  let service = services.get(ctx);
  if (!service) {
    const auth = authServiceFor(ctx);
    service = new AppAuthService({
      db: ctx.db,
      auth,
      log: ctx.log.child({ module: 'app-auth' }),
      // The Application URL (Settings → Requests), as the companion pairing uses it.
      serverUrl: () => normaliseServerUrl(getSection(ctx.db, 'requests').applicationUrl),
      ...overrides,
    });
    const s = service;
    auth.bearerAuth = (token, creds) => s.resolveBearer(token, creds);
    auth.revokeAppDevices = (userId) => s.revokeAll(userId);
    services.set(ctx, service);
  }
  return service;
}

export const appAuthModule: AppModule = (ctx) => async (app) => {
  await app.register(appAuthRoutes(appAuthServiceFor(ctx), { basePath: ctx.config.basePath ?? '' }));
};
