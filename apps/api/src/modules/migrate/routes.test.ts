import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../app.js';
import * as t from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { authServiceFor } from '../auth/context.js';
import { authModule, installAuth } from '../auth/index.js';
import { cookieFrom } from '../auth/test-support.js';
import { migrateModule } from './index.js';
import { migrateImported, migrateStaging } from './schema.js';
import { makeSonarrDb } from './test-fixtures.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mt-migrate-routes-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function buildMigrateApp() {
  const db = await createTestDb({ migrateImported, migrateStaging });
  const log = pino({ level: 'silent' });
  const bus = new EventBus();
  const ctx: AppContext = {
    config: { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null },
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: new Date(),
  };
  const app = Fastify({ trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (api) => {
      installAuth(api, ctx);
      await api.register(authModule(ctx));
      await api.register(migrateModule(ctx));
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  const admin = cookieFrom(await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: 'password1' } }));
  await app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie: admin }, payload: {} });
  await authServiceFor(ctx).createUser({ username: 'viewer', password: 'password2', role: 'user' });
  const user = cookieFrom(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'viewer', password: 'password2' } }));
  return { app, db, ctx, admin, user };
}

describe('/migrate routes', () => {
  it('are admin only, even for reads', async () => {
    const { app, user } = await buildMigrateApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/migrate/status' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/v1/migrate/status', headers: { cookie: user } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/migrate/sources', headers: { cookie: user } })).statusCode).toBe(403);
    await app.close();
  });

  it('plans a source and maps reader errors to HTTP', async () => {
    const { app, admin, db } = await buildMigrateApp();
    const dbPath = join(tmp, 'sonarr.db');
    makeSonarrDb(dbPath);
    const res = await app.inject({ method: 'POST', url: '/api/v1/migrate/plan', headers: { cookie: admin }, payload: { app: 'sonarr', dbPath, pathMappings: [{ from: '/tv', to: join(tmp, 'tv') }] } });
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan.app).toBe('sonarr');
    expect(plan.areas.find((a: { area: string }) => a.area === 'series')).toMatchObject({ create: 2 });
    expect(db.select().from(t.series).all()).toHaveLength(0);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/migrate/plan', headers: { cookie: admin }, payload: { app: 'sonarr', dbPath: join(tmp, 'none.db') } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/migrate/plan', headers: { cookie: admin }, payload: { app: 'radarr', dbPath } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'WRONG_APP' });
    await app.close();
  });

  it('applies through the MigrateFromArr job and reports status with job events', async () => {
    const { app, admin, db, ctx } = await buildMigrateApp();
    const events: string[] = [];
    ctx.bus.subscribe((e) => {
      if (e.type === 'job' && e.job.name === 'MigrateFromArr') events.push(e.job.status);
    });
    const dbPath = join(tmp, 'sonarr.db');
    makeSonarrDb(dbPath);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/migrate/apply',
      headers: { cookie: admin },
      payload: { source: { app: 'sonarr', dbPath, pathMappings: [{ from: '/tv', to: join(tmp, 'tv') }] }, areas: ['tags', 'qualityProfiles', 'series'], conflictPolicy: 'skip' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ state: 'running', app: 'sonarr' });
    let status = res.json();
    for (let i = 0; i < 50 && status.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await app.inject({ method: 'GET', url: '/api/v1/migrate/status', headers: { cookie: admin } })).json();
    }
    expect(status.state).toBe('completed');
    expect(status.jobId).toEqual(expect.any(Number));
    expect(status.result.areas.map((a: { area: string }) => a.area)).toEqual(['tags', 'qualityProfiles', 'series']);
    expect(db.select().from(t.series).all()).toHaveLength(2);
    expect(events[0]).toBe('running');
    expect(events.at(-1)).toBe('completed');
    expect(events.length).toBeGreaterThan(3);
    const job = db.select().from(t.jobs).all().find((j) => j.name === 'MigrateFromArr')!;
    expect(job.status).toBe('completed');
    await app.close();
  });

  it('lists detected sources', async () => {
    const { app, admin } = await buildMigrateApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/migrate/sources', headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });
});
