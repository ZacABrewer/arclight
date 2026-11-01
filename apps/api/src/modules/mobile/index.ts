import { DEFAULT_PUSH_RELAY_URL } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { pushServiceFor } from '../push/index.js';
import { getSection } from '../settings/service.js';
import { mobileRoutes } from './routes.js';
import { MobileService, type MobileServiceOptions } from './service.js';

export { MobileService, MobileError, normaliseServerUrl, TEST_INTERVAL_MS, type MobileServiceOptions, type DeliveryResult } from './service.js';
export { RelayClient, parseRetryAfter, RELAY_TIMEOUT_MS, type RelayOutcome } from './relay.js';
export { mobileDevices } from './schema.js';

// Mobile companion app: paired devices (table mobile_devices), the /mobile routes and delivery
// through the push relay. Every notification the push module sends to a user (notify(), after
// the user's PushPreferences) is also sent to that user's devices.
//
// Environment:
//   ARCLIGHT_PUSH_RELAY_URL  relay base URL (default https://arclight-push.moviemethat.com)
//   ARCLIGHT_PUSH_RELAY=off  no mobile push at all (devices can still be listed and removed)

export interface MobileEnv {
  relayUrl: string;
  enabled: boolean;
}

export function mobileEnv(env: NodeJS.ProcessEnv = process.env): MobileEnv {
  const flag = (env['ARCLIGHT_PUSH_RELAY'] ?? '').trim().toLowerCase();
  const url = (env['ARCLIGHT_PUSH_RELAY_URL'] ?? '').trim();
  return {
    relayUrl: url || DEFAULT_PUSH_RELAY_URL,
    enabled: !['off', '0', 'false', 'no', 'disabled'].includes(flag),
  };
}

const services = new WeakMap<AppContext, MobileService>();

/** `overrides` apply only when this call creates the instance (tests inject a fake fetch or relay URL). */
export function mobileServiceFor(ctx: AppContext, overrides: Partial<Omit<MobileServiceOptions, 'db'>> = {}): MobileService {
  let service = services.get(ctx);
  if (!service) {
    service = new MobileService({
      db: ctx.db,
      log: ctx.log.child({ module: 'mobile' }),
      ...mobileEnv(),
      serverUrl: () => getSection(ctx.db, 'requests').applicationUrl || undefined,
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const mobileModule: AppModule = (ctx) => async (app) => {
  const service = mobileServiceFor(ctx);
  await app.register(mobileRoutes(service));
  const off = pushServiceFor(ctx).addSink(service);
  if (!service.enabled) ctx.log.info({ module: 'mobile' }, 'mobile push disabled (ARCLIGHT_PUSH_RELAY=off)');
  app.addHook('onClose', async () => {
    off();
    service.dispose();
  });
};
