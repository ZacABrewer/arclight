import type { AppModule } from '../../app.js';
import { musicRoutes } from './routes.js';

// Music library (design 4.3): artists, albums (release groups), editions, tracks and their
// audio files, album-type profiles, wanted albums. Gated by `features.music`. The MusicBrainz
// refresh jobs live in the metadata module (music-jobs.ts) next to RefreshSeries/RefreshMovie.
export const musicModule: AppModule = (ctx) => musicRoutes(ctx);

export * as musicService from './service.js';
export { albumStatistics, artistStatistics } from './statistics.js';
export { albumsToMonitor, isReleased, monitorNewAlbum, nextRefreshAt, releaseDateMs } from './monitoring.js';
export { audioCodecOf, musicQualityFor } from './quality.js';
