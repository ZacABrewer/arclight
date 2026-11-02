import type { AppModule } from '../../app.js';
import { musicRoutes } from './routes.js';
import { soulseekRoutes } from './soulseek/routes.js';
import { playlistRoutes } from './playlists/routes.js';

// Music library (design 4.3): artists, albums (release groups), editions, tracks and their
// audio files, album-type profiles, wanted albums. Gated by `features.music`. The MusicBrainz
// refresh jobs live in the metadata module (music-jobs.ts) next to RefreshSeries/RefreshMovie.
// Each area registers its own plugin (own error handler and feature gate).
export const musicModule: AppModule = (ctx) => async (app) => {
  await app.register(musicRoutes(ctx));
  await app.register(soulseekRoutes(ctx));
  await app.register(playlistRoutes(ctx));
};

export * as musicService from './service.js';
export { albumStatistics, artistStatistics } from './statistics.js';
export { albumsToMonitor, isReleased, monitorNewAlbum, nextRefreshAt, releaseDateMs } from './monitoring.js';
export { audioCodecOf, musicQualityFor } from './quality.js';
