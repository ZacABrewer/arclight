import Fastify, { type FastifyPluginAsync, type RawServerDefault } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { EventBus } from './events.js';
import { Scheduler } from './scheduler.js';
import { systemModule } from './modules/system/index.js';
import { jobsModule } from './modules/jobs/index.js';
import { eventsModule } from './modules/events/index.js';
import { healthModule } from './modules/health/index.js';
import { profilesModule } from './modules/profiles/index.js';
import { settingsModule } from './modules/settings/index.js';
import { metadataModule, metadata } from './modules/metadata/index.js';
import { libraryModuleWith, type MetadataLookup } from './modules/library/index.js';
import { indexersModule } from './modules/indexers/index.js';
import { downloadClientsModule } from './modules/download-clients/index.js';
import { historyModule } from './modules/history/index.js';
import { blocklistModule } from './modules/blocklist/index.js';
import { releasesModuleWith } from './modules/releases/index.js';
import { importsModuleWith } from './modules/imports/index.js';
import { notificationsModuleWith } from './modules/notifications/index.js';
import { calendarModule } from './modules/calendar/index.js';
import { importListsModule } from './modules/import-lists/index.js';
import { logsModule } from './modules/logs/index.js';
import { backupModule } from './modules/backup/index.js';
import { compatApi, compatModule, type CompatMetadata } from './modules/compat/index.js';
import { migrateModule } from './modules/migrate/index.js';
import { vpnModule } from './modules/vpn/index.js';
import { torrentModule } from './modules/torrent/index.js';
import { subtitlesModule } from './modules/subtitles/index.js';
import { requestsModule } from './modules/requests/index.js';
import { authModule, installAuth } from './modules/auth/index.js';
import { wireModules } from './wiring.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  scheduler: Scheduler;
  log: Logger;
  startedAt: Date;
}

// A module is a Fastify plugin that receives the shared context. It registers routes under
// /api/v1 and any jobs it owns. This is the only extension point; every feature area in
// the roadmap is a module.
export type AppModule = (
  ctx: AppContext,
) => FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

/** Test seams; production passes none. */
export interface BuildAppOptions {
  /** Replaces the metadata module's lookup for POST /series and /movie. */
  metadata?: MetadataLookup;
  /** Called with the context before any module is built (tests pre-seed per-context services). */
  onContext?: (ctx: AppContext) => void;
  /** Inject an ffprobe probe into imports when available. Default true. */
  probe?: boolean;
  /** Replaces the compat API's TMDB lookups (tests). */
  compatMetadata?: CompatMetadata;
}

export async function buildApp(config: AppConfig, db: Db, log: Logger, opts: BuildAppOptions = {}) {
  const app = Fastify({ loggerInstance: log, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const bus = new EventBus();
  const scheduler = new Scheduler(db, bus, log.child({ component: 'scheduler' }));
  const ctx: AppContext = { config, db, bus, scheduler, log, startedAt: new Date() };
  opts.onContext?.(ctx);
  // Cross-module dependency objects for the pipeline (see wiring.ts for the flows).
  const wiring = wireModules(ctx, opts.probe === undefined ? {} : { probe: opts.probe });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  // Dependency-safe order: providers before the pipeline modules that consume them.
  const modules: AppModule[] = [
    systemModule,
    logsModule,
    healthModule,
    jobsModule,
    eventsModule,
    settingsModule,
    backupModule,
    metadataModule,
    libraryModuleWith({ metadata: opts.metadata ?? metadata }),
    profilesModule,
    indexersModule,
    downloadClientsModule,
    historyModule,
    blocklistModule,
    releasesModuleWith(wiring.releases),
    importListsModule,
    importsModuleWith(wiring.imports),
    // Imports dispatch their own import/upgrade notifications through the wiring.
    notificationsModuleWith({ translateImported: false }),
    subtitlesModule,
    requestsModule,
    calendarModule,
    compatModule,
    migrateModule,
    vpnModule,
    torrentModule,
    authModule,
  ];
  await app.register(
    async (api) => {
      // Auth first: the hook must be on this scope before any module's routes are added.
      // Public routes and bypass rules: modules/auth/hook.ts.
      installAuth(api, ctx);
      for (const mod of modules) await api.register(mod(ctx));
    },
    { prefix: '/api/v1' },
  );
  // Sonarr/Radarr-shaped API for third-party tools; mounted at the root (/api/v3, probes).
  await app.register(compatApi(ctx, opts.compatMetadata ? { metadata: opts.compatMetadata } : {}));

  if (config.webDist) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    // SPA fallback: anything that is not /api goes to the web app's index.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onReady', async () => scheduler.start());
  app.addHook('onClose', async () => scheduler.stop());
  app.addHook('onClose', async () => wiring.dispose());

  return app;
}
