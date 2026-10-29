import type { AppContext, AppModule } from '../../app.js';
import { createCombinedTagReader, createFfprobeTagReader } from '../imports/audio/index.js';
import { getImportsService } from '../imports/index.js';
import { ffprobeRunnerFor } from '../media-analysis/index.js';
import type { MetadataLookup } from '../library/index.js';
import { MetadataRefresher, type RescanPort } from './commands.js';
import { registerMetadataJobs } from './jobs.js';
import { createMetadataLookup } from './lookup.js';
import { metadataRoutes } from './routes.js';
import { MetadataService } from './service.js';
import { MusicRefresher, registerMusicJobs, type MusicSearchPort } from './music-jobs.js';
import { MusicMetadataService, type MusicProviderOverrides } from './music-service.js';
import { AudiobookRefresher, registerAudiobookJobs, type AudiobookSearchPort } from './audiobook-jobs.js';
import { AudiobookMetadataService, type AudiobookProviderOverrides } from './audiobook-service.js';

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

export { MusicMetadataService, albumCoverImages, musicUserAgent, PROJECT_URL, type MusicProviderOverrides } from './music-service.js';
export {
  ALBUM_SEARCH_JOB,
  ARTIST_ADD_JOB,
  ARTIST_SEARCH_JOB,
  METADATA_CACHE_CLEANUP_JOB,
  MusicRefresher,
  REFRESH_ARTIST_JOB,
  REFRESH_ARTISTS_JOB,
  RESCAN_ARTIST_JOB,
  SEARCH_NOT_AVAILABLE,
  type MusicSearchPort,
} from './music-jobs.js';
export {
  AudiobookMetadataService,
  AUDIOBOOK_CACHE_PROVIDER,
  AUDIOBOOK_CACHE_TTLS,
  audiobookUserAgent,
  type AudiobookProviderOverrides,
} from './audiobook-service.js';
export {
  AUDIOBOOK_SEARCH_NOT_AVAILABLE,
  AUTHOR_ADD_JOB,
  AUTHOR_SEARCH_JOB,
  AudiobookRefresher,
  BOOK_SEARCH_JOB,
  REFRESH_AUTHOR_JOB,
  REFRESH_AUTHORS_JOB,
  RESCAN_AUTHOR_JOB,
  type AudiobookSearchPort,
} from './audiobook-jobs.js';
export { createMetadataCacheStore, withPersistentCache, CACHE_RETENTION_MS, type MetadataCacheStore } from './cache.js';

const refreshers = new WeakMap<AppContext, MetadataRefresher>();
const musicRefreshers = new WeakMap<AppContext, MusicRefresher>();
const musicServices = new WeakMap<AppContext, MusicMetadataService>();
const musicOverrides = new WeakMap<AppContext, MusicProviderOverrides>();
const musicSearchPorts = new WeakMap<AppContext, MusicSearchPort>();
const audiobookRefreshers = new WeakMap<AppContext, AudiobookRefresher>();
const audiobookServices = new WeakMap<AppContext, AudiobookMetadataService>();
const audiobookOverrides = new WeakMap<AppContext, AudiobookProviderOverrides>();
const audiobookSearchPorts = new WeakMap<AppContext, AudiobookSearchPort>();

/** Where AuthorSearch / BookSearch run their searches (wiring.ts sets the release pipeline). */
export function setAudiobookSearchPort(ctx: AppContext, port: AudiobookSearchPort | undefined): void {
  if (port) audiobookSearchPorts.set(ctx, port);
  else audiobookSearchPorts.delete(ctx);
}

/** Test seam: Audible/Audnexus/OpenLibrary fetch (or a whole catalog), limiter and clock. Call from `onContext`. */
export function setAudiobookProviders(ctx: AppContext, overrides: AudiobookProviderOverrides): void {
  audiobookOverrides.set(ctx, overrides);
}

/** The running app's audiobook refresher (null before the metadata module registered). */
export function audiobookRefresherFor(ctx: AppContext): AudiobookRefresher | null {
  return audiobookRefreshers.get(ctx) ?? null;
}

/** The running app's audiobook metadata clients (null before the metadata module registered). */
export function audiobookMetadataFor(ctx: AppContext): AudiobookMetadataService | null {
  return audiobookServices.get(ctx) ?? null;
}

/** Where ArtistSearch / AlbumSearch run their searches (wiring.ts sets the release pipeline). */
export function setMusicSearchPort(ctx: AppContext, port: MusicSearchPort | undefined): void {
  if (port) musicSearchPorts.set(ctx, port);
  else musicSearchPorts.delete(ctx);
}

/** Test seam: MusicBrainz/Wikidata/Fanart fetch, limiter and clock. Call from `onContext`. */
export function setMusicProviders(ctx: AppContext, overrides: MusicProviderOverrides): void {
  musicOverrides.set(ctx, overrides);
}

/** The running app's music refresher (null before the metadata module registered). */
export function musicRefresherFor(ctx: AppContext): MusicRefresher | null {
  return musicRefreshers.get(ctx) ?? null;
}

/** The running app's music metadata clients (null before the metadata module registered). */
export function musicMetadataFor(ctx: AppContext): MusicMetadataService | null {
  return musicServices.get(ctx) ?? null;
}

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

  const overrides = musicOverrides.get(ctx);
  const musicLog = ctx.log.child({ module: 'music-metadata' });
  const musicService = new MusicMetadataService({ db: ctx.db, log: musicLog, ...(overrides ? { overrides } : {}) });
  const musicRefresher = new MusicRefresher({
    db: ctx.db,
    scheduler: ctx.scheduler,
    service: musicService,
    log: musicLog,
    tagReader: () => createCombinedTagReader({ ffprobe: createFfprobeTagReader({ runner: ffprobeRunnerFor(ctx) }) }),
    search: () => musicSearchPorts.get(ctx) ?? null,
    ...(overrides?.now ? { now: overrides.now } : {}),
  });
  musicServices.set(ctx, musicService);
  musicRefreshers.set(ctx, musicRefresher);
  registerMusicJobs(ctx.scheduler, musicRefresher);

  const abOverrides = audiobookOverrides.get(ctx);
  const abLog = ctx.log.child({ module: 'audiobook-metadata' });
  const audiobookService = new AudiobookMetadataService({ db: ctx.db, log: abLog, ...(abOverrides ? { overrides: abOverrides } : {}) });
  const audiobookRefresher = new AudiobookRefresher({
    db: ctx.db,
    scheduler: ctx.scheduler,
    service: audiobookService,
    log: abLog,
    tagReader: () => createCombinedTagReader({ ffprobe: createFfprobeTagReader({ runner: ffprobeRunnerFor(ctx) }) }),
    search: () => audiobookSearchPorts.get(ctx) ?? null,
    ...(abOverrides?.now ? { now: abOverrides.now } : {}),
  });
  audiobookServices.set(ctx, audiobookService);
  audiobookRefreshers.set(ctx, audiobookRefresher);
  registerAudiobookJobs(ctx.scheduler, audiobookRefresher);

  await app.register(metadataRoutes(service, refresher));
};
