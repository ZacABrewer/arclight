import type { AppContext, AppModule } from '../../app.js';
import { registerPushListener } from './listener.js';
import { pushRoutes } from './routes.js';
import { PushService, type PushServiceOptions } from './service.js';

export { PushService, PushError, PUSH_SECTION, type PushKind, type PushServiceOptions } from './service.js';
export { deliveriesFor, registerPushListener } from './listener.js';
export { encryptPayload, generateVapidKeys, sendWebPush, vapidJwt, b64url, fromB64url, type VapidKeys } from './webpush.js';
export { pushSubscriptions } from './schema.js';

// Browser notifications (Web Push): VAPID keys in settings section `push`, per-user
// subscriptions (table push_subscriptions), per-user preferences in
// users.settings.notifications.push, and a bus listener that turns request / import / issue
// events into pushes. Other modules send with `pushServiceFor(ctx).notify(userId, kind, payload)`.

const services = new WeakMap<AppContext, PushService>();

/** `overrides` apply only when this call creates the instance (tests inject a fake fetch). */
export function pushServiceFor(ctx: AppContext, overrides: Partial<Omit<PushServiceOptions, 'db'>> = {}): PushService {
  let service = services.get(ctx);
  if (!service) {
    service = new PushService({ db: ctx.db, log: ctx.log.child({ module: 'push' }), ...overrides });
    services.set(ctx, service);
  }
  return service;
}

/** Shorthand for other modules: `sendPush(ctx, userId, payload)`. */
export function sendPush(ctx: AppContext, userId: number, payload: Parameters<PushService['sendPush']>[1]) {
  return pushServiceFor(ctx).sendPush(userId, payload);
}

export interface PushModuleOptions {
  /**
   * Turn bus events into pushes (default true). Switch off once the requests module sends
   * its own per-user pushes through pushServiceFor(ctx), or users get each one twice.
   */
  busListener?: boolean;
}

export function pushModuleWith(opts: PushModuleOptions = {}): AppModule {
  return (ctx) => async (app) => {
    const service = pushServiceFor(ctx);
    await app.register(pushRoutes(service));
    if (opts.busListener !== false) {
      const off = registerPushListener({ db: ctx.db, bus: ctx.bus, push: service, log: ctx.log.child({ module: 'push' }) });
      app.addHook('onClose', async () => off());
    }
  };
}

export const pushModule: AppModule = pushModuleWith();
