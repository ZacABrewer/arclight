import type { AppModule } from '../../app.js';
import { libraryImportRoutes } from '../imports/audio/library-import-routes.js';
import { audioRoutes } from './audio-routes.js';
import { audiobookRoutes } from './routes.js';

// Audiobook library (design 4.4): authors, books, series, co-author links and their audio
// files, wanted books. Gated by `features.audiobooks`. The catalogue refresh jobs live in the
// metadata module (audiobook-jobs.ts) next to the music ones. This module also serves the two
// routes music and audiobooks share (POST /command, GET /audiofile; audio-routes.ts), each
// gated by the flag of the media type a request names, and the library import of existing
// music and audiobook folders (imports/audio/library-import.ts), gated the same way.
export const audiobooksModule: AppModule = (ctx) => async (app) => {
  await app.register(audiobookRoutes(ctx));
  await app.register(audioRoutes(ctx));
  await app.register(libraryImportRoutes(ctx));
};

export * as audiobookService from './service.js';
export { authorStatistics, bookStatistics } from './statistics.js';
export { booksToMonitor, monitorNewBook, nextAuthorRefreshAt, positionSortOf } from './monitoring.js';
export { audiobookFileQuality } from './quality.js';
export { groupBookFiles, matchBookGroup, scanAuthorFolder, type KnownBook } from './rescan.js';
export { AudioCommand, AudioFileQuery } from './audio-routes.js';
