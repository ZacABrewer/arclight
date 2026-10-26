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

export async function buildApp(config: AppConfig, db: Db, log: Logger) {
  const app = Fastify({ loggerInstance: log, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const bus = new EventBus();
  const scheduler = new Scheduler(db, bus, log.child({ component: 'scheduler' }));
  const ctx: AppContext = { config, db, bus, scheduler, log, startedAt: new Date() };

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  const modules: AppModule[] = [systemModule, healthModule, jobsModule, eventsModule];
  await app.register(
    async (api) => {
      for (const mod of modules) await api.register(mod(ctx));
    },
    { prefix: '/api/v1' },
  );

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

  return app;
}
