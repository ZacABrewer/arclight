import type { AppContext } from '../../../app.js';
import { mediaServersServiceFor } from '../../media-servers/index.js';
import { musicMetadataFor, musicRefresherFor } from '../../metadata/index.js';
import type { PlaylistProviderOverrides } from './providers.js';
import { MusicPlaylistService } from './service.js';

export { MusicPlaylistService, MUSIC_PLAYLIST_SYNC_JOB } from './service.js';
export { PlaylistError, PlaylistProviders, type PlaylistProviderOverrides } from './providers.js';
export { playlistRoutes } from './routes.js';

// One service per app context. Outside calls (sources, MusicBrainz via the metadata module,
// media-server pushes) go through injectable fetch overrides in tests.
const services = new WeakMap<AppContext, MusicPlaylistService>();
const overridesFor = new WeakMap<AppContext, PlaylistProviderOverrides>();

/** Test seam: fake fetch / clock for playlist sources and pushes. Call before first use. */
export function setPlaylistProviders(ctx: AppContext, overrides: PlaylistProviderOverrides): void {
  overridesFor.set(ctx, overrides);
  services.delete(ctx);
}

export function playlistServiceFor(ctx: AppContext): MusicPlaylistService {
  let service = services.get(ctx);
  if (!service) {
    const overrides = overridesFor.get(ctx);
    service = new MusicPlaylistService({
      db: ctx.db,
      log: ctx.log.child({ module: 'music-playlists' }),
      scheduler: ctx.scheduler,
      musicMetadata: () => musicMetadataFor(ctx),
      refresher: () => musicRefresherFor(ctx),
      mediaServers: () => mediaServersServiceFor(ctx).stored(),
      ...(overrides ? { overrides } : {}),
    });
    services.set(ctx, service);
  }
  return service;
}
