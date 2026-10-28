import type { AppContext, AppModule } from '../../app.js';
import { mediaServersRoutes } from './routes.js';
import { MediaServersService } from './service.js';
import { migrateLegacyMediaServer } from './legacy.js';

export {
  MediaServersService,
  MediaServersError,
  libraryKindsFor,
  type ConfiguredClient,
  type RefreshPathInput,
  type MediaServerClientFactory,
  type MediaServerPurpose,
  type MediaServersServiceOptions,
} from './service.js';
export { mediaServerView, saveMediaServerView, migrateLegacyMediaServer, primaryMediaServer, LEGACY_MEDIA_SERVER_SECTION } from './legacy.js';

// Jellyfin/Emby/Plex connections shared by every feature that talks to a media server
// (settings section `mediaServers`, routes under /mediaserver). One service per app context so
// consumers (retention, requests availability, post-import refresh) see the same factory;
// tests replace it with `setMediaServersService` before the modules are built.
const services = new WeakMap<AppContext, MediaServersService>();

export function mediaServersServiceFor(ctx: AppContext): MediaServersService {
  let service = services.get(ctx);
  if (!service) {
    service = new MediaServersService({ db: ctx.db });
    services.set(ctx, service);
  }
  return service;
}

/** Test seam: use `service` for this context (call from BuildAppOptions.onContext). */
export function setMediaServersService(ctx: AppContext, service: MediaServersService): void {
  services.set(ctx, service);
}

export const mediaServersModule: AppModule = (ctx) => async (app) => {
  // The list is the source of truth: move a stored single-server `mediaServer` value into it once.
  if (migrateLegacyMediaServer(ctx.db)) ctx.log.info('moved the legacy media server setting into the media servers list');
  await app.register(mediaServersRoutes(mediaServersServiceFor(ctx)));
};
