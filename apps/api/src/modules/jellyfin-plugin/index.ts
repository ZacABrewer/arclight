import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { requestsServicesFor } from '../requests/index.js';
import { accountsPortFor, watchHistoryFor } from '../watch-history/index.js';
import { themesServiceFor } from '../themes/index.js';
import { jellyfinPluginRoutes } from './routes.js';
import { jellyfinThemeRoutes } from './theme-routes.js';
import { JellyfinPluginService } from './service.js';

export { JellyfinPluginService, PluginError, titleStatus, type PluginUser } from './service.js';

const services = new WeakMap<AppContext, JellyfinPluginService>();

export function jellyfinPluginServiceFor(ctx: AppContext): JellyfinPluginService {
  let found = services.get(ctx);
  if (!found) {
    found = new JellyfinPluginService({
      db: ctx.db,
      servers: mediaServersServiceFor(ctx),
      requests: () => requestsServicesFor(ctx),
      store: watchHistoryFor(ctx).store,
      accounts: () => accountsPortFor(ctx),
      queue: () => getDownloadClientsService(ctx).queueSummary(),
    });
    services.set(ctx, found);
  }
  return found;
}

// The API the Arclight Jellyfin plugin calls (/api/v1/jellyfin/*) and the plugin card's admin
// routes. Registered after the requests and watch-history modules, whose services it uses.
export const jellyfinPluginModule: AppModule = (ctx) => async (app) => {
  await app.register(jellyfinPluginRoutes(ctx, jellyfinPluginServiceFor(ctx), watchHistoryFor(ctx), mediaServersServiceFor(ctx)));
  // Themes in Jellyfin (theme-routes.ts).
  await app.register(jellyfinThemeRoutes(jellyfinPluginServiceFor(ctx), themesServiceFor(ctx)));
};
