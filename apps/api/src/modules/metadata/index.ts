import type { AppContext, AppModule } from '../../app.js';
import { getImportsService } from '../imports/index.js';
import type { MetadataLookup } from '../library/index.js';
import { MetadataRefresher, type RescanPort } from './commands.js';
import { registerMetadataJobs } from './jobs.js';
import { createMetadataLookup } from './lookup.js';
import { metadataRoutes } from './routes.js';
import { MetadataService } from './service.js';

export { MetadataService, MetadataNotConfiguredError } from './service.js';
export { createMetadataLookup } from './lookup.js';
export { REFRESH_MOVIE_JOB, REFRESH_SERIES_JOB, refreshAllMovies, refreshAllSeries } from './jobs.js';
export * from './map.js';
export {
  MetadataRefresher,
  RefreshTargetNotFound,
  REFRESH_LIBRARY_JOB,
  REFRESH_MOVIE_ITEM_JOB,
  REFRESH_SERIES_ITEM_JOB,
  type RescanPort,
  type Started,
} from './commands.js';

const refreshers = new WeakMap<AppContext, MetadataRefresher>();

/** The running app's on-demand refresher (null before the metadata module registered). */
export function metadataRefresherFor(ctx: AppContext): MetadataRefresher | null {
  return refreshers.get(ctx) ?? null;
}

/** Rescans go through the imports module's service, resolved when a refresh runs. */
function rescanPort(ctx: AppContext): RescanPort {
  const imports = () => getImportsService(ctx);
  return {
    series: (id) => imports().rescanSeries(id),
    movie: (id) => imports().rescanMovie(id),
    all: async () => {
      const a = await imports().rescanAll('series');
      const b = await imports().rescanAll('movie');
      return { scanned: a.scanned + b.scanned };
    },
  };
}

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
  const refresher = new MetadataRefresher(ctx.db, ctx.scheduler, service, () => rescanPort(ctx), ctx.bus);
  refreshers.set(ctx, refresher);
  await app.register(metadataRoutes(service, refresher));
};
