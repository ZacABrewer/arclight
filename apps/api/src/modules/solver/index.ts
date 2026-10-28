import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import {
  PROXY_AUTODETECT_CRON,
  PROXY_AUTODETECT_JOB,
  isBuiltinSolverRow,
  probeFlareSolverr,
  runProxyAutoDetect,
  type AutoDetectDeps,
} from './autodetect.js';
import { solverRoutes } from './routes.js';
import { SolverService, type SolverServiceOptions } from './service.js';

export { SolverService, type SolverServiceOptions } from './service.js';
export * from './autodetect.js';

// Cloudflare challenge solving (docs/CLOUDFLARE.md): the built-in browser solver behind
// POST /api/v1/solver/v1, the `solver` settings section, and the ProxyAutoDetect job that
// registers "FlareSolverr (bundled)" / "Built-in solver" indexer proxies on boot and every
// 10 minutes.

const services = new WeakMap<AppContext, SolverService>();

/** `overrides` apply only when this call creates the instance (tests inject fakes). */
export function solverServiceFor(ctx: AppContext, overrides: Partial<Omit<SolverServiceOptions, 'db' | 'configDir'>> = {}): SolverService {
  let service = services.get(ctx);
  if (!service) {
    service = new SolverService({ db: ctx.db, configDir: ctx.config.configDir, log: ctx.log.child({ module: 'solver' }), ...overrides });
    services.set(ctx, service);
  }
  return service;
}

/** Production dependencies of runProxyAutoDetect; `overrides` are test seams. */
export function autoDetectDepsFor(ctx: AppContext, overrides: Partial<Pick<AutoDetectDeps, 'probe' | 'envUrl'>> = {}): AutoDetectDeps {
  const proxies = indexersServiceFor(ctx).proxies;
  const solver = solverServiceFor(ctx);
  const log = ctx.log.child({ module: 'solver' });
  return {
    db: ctx.db,
    proxies: {
      allRows: () => proxies.allRows(),
      create: (input) => proxies.create(input),
      update: (id, input) => proxies.update(id, input),
      delete: (id) => proxies.delete(id),
    },
    envUrl: 'envUrl' in overrides ? overrides.envUrl : process.env['ARCLIGHT_FLARESOLVERR_URL'],
    probe: overrides.probe ?? ((url) => probeFlareSolverr(url)),
    builtin: () => ({
      available: solver.available(),
      listenHost: ctx.config.host,
      port: ctx.config.port,
      apiKey: authServiceFor(ctx).apiKey(),
      timeoutSeconds: solver.settings().timeoutSeconds,
    }),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  };
}

export interface SolverModuleOptions {
  /** Test seam for the auto-detect probe / env. */
  autodetect?: Partial<Pick<AutoDetectDeps, 'probe' | 'envUrl'>>;
}

export function solverModuleWith(opts: SolverModuleOptions = {}): AppModule {
  return (ctx) => async (app) => {
    const service = solverServiceFor(ctx);
    const autodetect = () => runProxyAutoDetect(autoDetectDepsFor(ctx, opts.autodetect));
    const builtinProxyId = () => indexersServiceFor(ctx).proxies.allRows().find(isBuiltinSolverRow)?.id ?? null;

    const externalSolvers = () =>
      indexersServiceFor(ctx)
        .proxies.allRows()
        .filter((r) => r.type === 'flaresolverr' && !isBuiltinSolverRow(r))
        .map((r) => ({ id: r.id, name: r.name }));
    await app.register(solverRoutes({ service, builtinProxyId, autodetect, externalSolvers, docker: ctx.config.isDocker }));

    ctx.scheduler.register({
      name: PROXY_AUTODETECT_JOB,
      cron: PROXY_AUTODETECT_CRON,
      handler: async () => {
        const result = await autodetect();
        return result.messages.length > 0 ? result.messages.join('; ') : 'no changes';
      },
    });

    app.addHook('onReady', async () => {
      // A slow or absent FlareSolverr must not hold up boot beyond the probe's short timeout.
      await autodetect().catch((err: unknown) => ctx.log.warn({ err }, 'proxy auto-detect failed'));
    });
    app.addHook('onClose', async () => service.shutdown());
  };
}

export const solverModule: AppModule = solverModuleWith();
