import { rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { RetentionActions } from './actions.js';
import { retentionRoutes } from './routes.js';
import { RetentionService } from './service.js';
import { addMovie, configured, FakeMediaServer, NOW, setupLibrary, type LibraryFixture } from './test-support.js';

let fx: LibraryFixture;

afterEach(async () => {
  await rm(fx.tmp, { recursive: true, force: true });
});

async function build() {
  fx = await setupLibrary();
  const server = new FakeMediaServer();
  const service = new RetentionService({ db: fx.db, servers: () => [configured(server)], apply: new RetentionActions(fx.db).apply, now: () => NOW });
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(retentionRoutes(service), { prefix: '/api/v1' });
  return { app, service, server };
}

const RULE = { name: 'Old movies', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 3 };

describe('retention routes', () => {
  it('CRUDs rules', async () => {
    const { app } = await build();
    const created = await app.inject({ method: 'POST', url: '/api/v1/retentionrule', payload: RULE });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json()).toMatchObject({ dryRun: true, scope: { type: 'all' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/retentionrule' })).json()).toHaveLength(1);
    const put = await app.inject({ method: 'PUT', url: `/api/v1/retentionrule/${id}`, payload: { ...RULE, dryRun: false } });
    expect(put.json().dryRun).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/retentionrule/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/retentionrule/${id}` })).statusCode).toBe(404);
  });

  it('validates rule bodies', async () => {
    const { app } = await build();
    const bad = await app.inject({ method: 'POST', url: '/api/v1/retentionrule', payload: { ...RULE, conditions: [{ type: 'watchedForever' }] } });
    expect(bad.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/v1/retentionrule', payload: RULE });
    expect((await app.inject({ method: 'POST', url: '/api/v1/retentionrule', payload: RULE })).statusCode).toBe(409);
  });

  it('sweeps (dry run and real), lists candidates, keeps and applies them', async () => {
    const { app } = await build();
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    await addMovie(fx, { tmdbId: 12, title: 'B' });
    await app.inject({ method: 'POST', url: '/api/v1/retentionrule', payload: RULE });

    const preview = await app.inject({ method: 'POST', url: '/api/v1/retention/sweep', payload: { dryRun: true } });
    expect(preview.json()).toMatchObject({ dryRun: true, staged: 0 });
    expect(preview.json().matches).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/api/v1/retention/candidates' })).json()).toEqual([]);

    const real = await app.inject({ method: 'POST', url: '/api/v1/retention/sweep' });
    expect(real.statusCode).toBe(200);
    expect(real.json().staged).toBe(2);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/retention/candidates?status=pending' })).json();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ ruleName: 'Old movies', status: 'pending', dryRun: true });

    const kept = await app.inject({ method: 'POST', url: `/api/v1/retention/candidate/${list[0].id}/keep` });
    expect(kept.json().status).toBe('kept');
    const applied = await app.inject({ method: 'POST', url: `/api/v1/retention/candidate/${list[1].id}/apply` });
    expect(applied.json().status).toBe('applied');
    expect((await app.inject({ method: 'POST', url: `/api/v1/retention/candidate/${list[1].id}/apply` })).statusCode).toBe(409);

    expect((await app.inject({ method: 'GET', url: '/api/v1/retention/candidates?status=kept' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/retention/candidate/${list[0].id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/v1/retention/candidate/999/keep' })).statusCode).toBe(404);
  });
});
