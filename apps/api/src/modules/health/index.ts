import { HealthResponse } from '@media-tron/shared';
import type { AppContext, AppModule } from '../../app.js';
import { createChecks } from './checks/index.js';
import { createHealthDeps } from './deps.js';
import { HealthService } from './service.js';

export { HealthService, overallStatus } from './service.js';
export { createChecks } from './checks/index.js';
export { createHealthDeps, nodeHealthFs, findMount, RECYCLE_BIN_SETTING } from './deps.js';
export * from './types.js';

// Health checks: a catalogue of functions (checks/*.ts) over injectable dependencies. Results
// are cached by HealthService; the HealthCheck job refreshes them and publishes a `health`
// event (the notifications module turns failures/restores into notifications).

const services = new WeakMap<AppContext, HealthService>();

export function healthServiceFor(ctx: AppContext): HealthService {
  let service = services.get(ctx);
  if (!service) {
    // Deps are built lazily, on the first run, so module registration order does not matter.
    let deps: ReturnType<typeof createHealthDeps> | null = null;
    service = new HealthService(
      createChecks(),
      () => (deps ??= createHealthDeps(ctx)),
      ctx.log.child({ module: 'health' }),
    );
    services.set(ctx, service);
  }
  return service;
}

export const healthModule: AppModule = (ctx) => async (app) => {
  const service = healthServiceFor(ctx);

  const runAndPublish = async () => {
    const health = await service.run();
    ctx.bus.publish({ type: 'health', health });
    return health;
  };

  app.get('/health', { schema: { response: { 200: HealthResponse } } }, async () => service.current());

  app.post('/health/recheck', { schema: { response: { 200: HealthResponse } } }, async () => runAndPublish());

  ctx.scheduler.register({
    name: 'HealthCheck',
    cron: '*/5 * * * *',
    handler: async () => {
      const health = await runAndPublish();
      return `${health.checks.length} finding(s), status ${health.status}`;
    },
  });
};
