import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { engineAgentRoutes } from './routes.js';
import { EngineAgentService } from './service.js';

export { EngineAgentService, ENGINE_AGENT_PATH, ENGINE_AGENT_SETTINGS_KEY, ENGINE_AGENT_TOKEN_KEY, EngineAgentSettingsError } from './service.js';
export { engineAgentRoutes } from './routes.js';

// Arclight as a remote engine agent (see service.ts). Reads the torrent module's Session and
// downloads root; never starts or stops the engine.

const services = new WeakMap<AppContext, EngineAgentService>();

export function engineAgentServiceFor(ctx: AppContext): EngineAgentService {
  let service = services.get(ctx);
  if (!service) {
    service = new EngineAgentService({
      db: ctx.db,
      // Resolved per call, so module registration order does not matter.
      session: () => torrentServiceFor(ctx).session,
      downloadsRoot: () => torrentServiceFor(ctx).effectiveDownloadsRoot(),
      // Deprecated way in (remotes set up before 0.24), only while acceptApiKey is on.
      verifyApiKey: (candidate) => authServiceFor(ctx).verifyApiKey(candidate),
    });
    services.set(ctx, service);
  }
  return service;
}

export const engineAgentModule: AppModule = (ctx) => async (app) => {
  await app.register(engineAgentRoutes(engineAgentServiceFor(ctx)));
};
