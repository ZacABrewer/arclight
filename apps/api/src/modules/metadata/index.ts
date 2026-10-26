import type { AppModule } from '../../app.js';
import type { MetadataLookup } from '../library/index.js';
import { registerMetadataJobs } from './jobs.js';
import { createMetadataLookup } from './lookup.js';
import { metadataRoutes } from './routes.js';
import { MetadataService } from './service.js';

export { MetadataService, MetadataNotConfiguredError } from './service.js';
export { createMetadataLookup } from './lookup.js';
export { REFRESH_MOVIE_JOB, REFRESH_SERIES_JOB, refreshAllMovies, refreshAllSeries } from './jobs.js';
export * from './map.js';

// The service instance of the running app. app.ts hands `metadata` to the library module
// before any module is built, so the lookup resolves the service at call time.
let active: MetadataService | null = null;

/** The running app's metadata service (null before the metadata module registered). */
export function activeMetadataService(): MetadataService | null {
  return active;
}

/** Library-facing lookup: pass to `libraryModuleWith({ metadata })`. */
export const metadata: MetadataLookup = createMetadataLookup(() => active);

export const metadataModule: AppModule = (ctx) => async (app) => {
  const service = new MetadataService({ db: ctx.db, log: ctx.log.child({ module: 'metadata' }) });
  active = service;
  registerMetadataJobs(ctx.scheduler, { db: ctx.db, service });
  await app.register(metadataRoutes(service));
};
