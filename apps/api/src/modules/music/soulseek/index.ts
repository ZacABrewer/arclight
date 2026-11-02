import type { ClientRuntime } from '@arclight/download-clients';
import type { AppContext } from '../../../app.js';
import { getImportsService } from '../../imports/index.js';
import { SoulseekService } from './service.js';

export { SoulseekService, SoulseekError, grabRequestFor, localPathOf, searchQueryFor } from './service.js';
export { chooseCandidates, sharedFileQuality } from './choose.js';
export { registerSoulseekJobs, SOULSEEK_MONITOR_JOB, SOULSEEK_SEARCH_JOB } from './jobs.js';
export { soulseekRoutes } from './routes.js';

// One service per app context; imports go through the shared ImportsService.
const services = new WeakMap<AppContext, SoulseekService>();
const runtimes = new WeakMap<AppContext, Partial<ClientRuntime>>();

/** Test seam: the slskd HTTP runtime (a fake's fetch) for this context. Call before first use. */
export function setSoulseekRuntime(ctx: AppContext, runtime: Partial<ClientRuntime>): void {
  runtimes.set(ctx, runtime);
  services.delete(ctx);
}

export function soulseekServiceFor(ctx: AppContext): SoulseekService {
  let service = services.get(ctx);
  if (!service) {
    const runtime = runtimes.get(ctx);
    service = new SoulseekService({
      db: ctx.db,
      log: ctx.log.child({ module: 'soulseek' }),
      importFolder: (input) => getImportsService(ctx).importMusicFolder(input),
      ...(runtime ? { runtime } : {}),
    });
    services.set(ctx, service);
  }
  return service;
}
