import type { AppContext, AppModule } from '../../app.js';
import type { MetadataLookup } from '../library/index.js';
import { metadata as metadataLookup } from '../metadata/index.js';
import { releasesServiceFor } from '../releases/index.js';
import { registerImportListJobs } from './jobs.js';
import type { FetchLike } from './providers/index.js';
import { importListsRoutes } from './routes.js';
import { ImportListsService, type SearchTrigger } from './service.js';

export { ImportListsService, maskSettings, type ResolvedItem, type SearchTrigger } from './service.js';
export { ImportListsError, ImportListFetchError } from './errors.js';
export { IMPORT_LIST_SYNC_JOB } from './jobs.js';
export * from './schema.js';

export interface ImportListsModuleOptions {
  /** Defaults to the metadata module's lookup. */
  metadata?: MetadataLookup;
  /** Defaults to the releases module's search (resolved at call time). */
  search?: SearchTrigger;
  fetch?: FetchLike;
}

const services = new WeakMap<AppContext, ImportListsService>();

export function importListsServiceFor(ctx: AppContext, opts: ImportListsModuleOptions = {}): ImportListsService {
  let service = services.get(ctx);
  if (!service) {
    service = new ImportListsService({
      db: ctx.db,
      log: ctx.log.child({ module: 'import-lists' }),
      bus: ctx.bus,
      metadata: opts.metadata ?? metadataLookup,
      // Resolved lazily: the releases module registers its service (with its wiring) first.
      search: opts.search ?? ((target) => releasesServiceFor(ctx).searchFor(target)),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    services.set(ctx, service);
  }
  return service;
}

export const importListsModuleWith =
  (opts: ImportListsModuleOptions): AppModule =>
  (ctx) =>
  async (app) => {
    const service = importListsServiceFor(ctx, opts);
    await app.register(importListsRoutes(service));
    registerImportListJobs(ctx.scheduler, service);
  };

/** Automatically add series/movies from external lists (TMDB, Trakt, Plex, IMDb, feeds). */
export const importListsModule: AppModule = importListsModuleWith({});
