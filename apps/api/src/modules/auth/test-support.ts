import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import type { AppContext } from '../../app.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { authServiceFor } from './context.js';
import { authModule, installAuth } from './index.js';
import type { AuthServiceOptions } from './service.js';

/** Test-only: an api scope with the auth hook, the auth module and two probe routes. */
export async function buildAuthApp(overrides: Partial<Omit<AuthServiceOptions, 'db'>> = {}) {
  const db = await createTestDb();
  const log = pino({ level: 'silent' });
  const bus = new EventBus();
  const ctx: AppContext = {
    config: {
      configDir: '.',
      dbPath: ':memory:',
      logDir: '.',
      port: 0,
      host: '127.0.0.1',
      logLevel: 'silent',
      isDocker: false,
      webDist: null,
    },
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: new Date(),
  };
  const auth = authServiceFor(ctx, overrides);
  const app = Fastify({ trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (api) => {
      installAuth(api, ctx);
      await api.register(authModule(ctx));
      api.get('/probe', async (req) => ({ via: req.auth?.via ?? null, user: req.auth?.user?.username ?? null }));
      api.post('/probe', async () => ({ ok: true }));
      api.get('/system/ping', async () => ({ status: 'ok' }));
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  return { app, auth, db, ctx };
}

/** The `mt_session=...` pair from a response's set-cookie header. */
export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? String(header[0]) : String(header ?? '');
  return raw.split(';')[0] ?? '';
}
