import type { AppModule } from '../../app.js';
import { libraryRoutes, type LibraryCommands, type LibraryCommandTarget, type LibraryRoutesOptions, type MetadataLookup } from './routes.js';

// The library owns root folders, series/seasons/episodes, movies, media files and tags. It has
// no jobs of its own: refreshes are driven by the metadata module, imports by downloads.
export const libraryModule: AppModule = (ctx) => libraryRoutes(ctx);

/** Variant for app.ts once the metadata module exists: wires tmdbId lookups into POST /series and /movie. */
export const libraryModuleWith = (opts: LibraryRoutesOptions): AppModule => (ctx) => libraryRoutes(ctx, opts);

export type { MetadataLookup, LibraryRoutesOptions, LibraryCommands, LibraryCommandTarget };
export { LibraryError } from './errors.js';
export { createCutoffChecker, fileFormatScore, type CutoffProfiles } from './cutoff.js';
export * as libraryService from './service.js';
export type {
  AddMediaFileInput,
  EpisodeMetadataInput,
  EpisodeRefreshResult,
  IsCutoffMet,
  MovieMetadataInput,
  SeriesMetadataInput,
} from './service.js';
export {
  DEFAULT_VERSION_TAG,
  UHD_VERSION_TAG,
  canonicalTag,
  enabledVersions,
  findVersion,
  isVersioned,
  pickVersion,
  primaryOf,
  profileIdForSlot,
  rankVersions,
  sameTag,
  slotOf,
  upsertVersion,
  type VersionFit,
} from './versions.js';
