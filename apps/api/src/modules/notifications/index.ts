import type { NotificationEvent } from '@arclight/notifications';
import type { AppContext, AppModule } from '../../app.js';
import { notificationsRoutes } from './routes.js';
import { NotificationsService } from './service.js';
import { EventTranslator } from './translate.js';

export {
  NotificationsService,
  NotificationsError,
  wantsEvent,
  type AgentFactory,
  type ConnectionStatus,
  type DispatchOutcome,
} from './service.js';
export { EventTranslator, toMediaInfo, toEpisodeInfo, toFileInfo, releaseFrom } from './translate.js';
export * from './schema.js';

/** Health notifications are held back this long after start (download clients still booting). */
export const HEALTH_NOTIFICATION_GRACE_MS = 15 * 60_000;

// One service per app context so every module dispatches through the same instance (and the
// same per-connection failure state, which the health checks read).
const services = new WeakMap<AppContext, NotificationsService>();

export function notificationsServiceFor(ctx: AppContext): NotificationsService {
  let service = services.get(ctx);
  if (!service) {
    service = new NotificationsService({ db: ctx.db, log: ctx.log.child({ module: 'notifications' }) });
    services.set(ctx, service);
  }
  return service;
}

/**
 * Subscribe `service` to the bus: each translatable event becomes zero or more
 * NotificationEvents, dispatched without blocking the publisher. Returns an unsubscribe.
 */
export function attachNotificationBus(
  ctx: Pick<AppContext, 'bus' | 'log'>,
  service: Pick<NotificationsService, 'dispatch'>,
  translator: EventTranslator,
): () => void {
  return ctx.bus.subscribe((event) => {
    let built: NotificationEvent[];
    try {
      built = translator.translate(event);
    } catch (err) {
      ctx.log.error({ err, event: event.type }, 'could not translate event for notifications');
      return;
    }
    for (const n of built) {
      service.dispatch(n).catch((err: unknown) => ctx.log.error({ err, event: n.type }, 'notification dispatch failed'));
    }
  });
}

export interface NotificationsModuleOptions {
  /** See `TranslatorOptions.translateImported`. Default true. */
  translateImported?: boolean;
}

/** Variant for app.ts: lets the wiring take over import notifications from the bus. */
export const notificationsModuleWith =
  (opts: NotificationsModuleOptions): AppModule =>
  (ctx) =>
  async (app) => {
    const service = notificationsServiceFor(ctx);
    await app.register(notificationsRoutes(service));
    const translator = new EventTranslator({
      db: ctx.db,
      log: ctx.log.child({ module: 'notifications' }),
      healthGraceUntil: new Date(ctx.startedAt.getTime() + HEALTH_NOTIFICATION_GRACE_MS),
      ...(opts.translateImported !== undefined ? { translateImported: opts.translateImported } : {}),
    });
    const unsubscribe = attachNotificationBus(ctx, service, translator);
    app.addHook('onClose', async () => unsubscribe());
  };

export const notificationsModule: AppModule = notificationsModuleWith({});
