import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import type { AppContext } from '../../app.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import * as s from '../../db/schema.js';
import { itemsForEvent, tagRulesModuleWith, TAG_RULES_JOB } from './index.js';
import { tagRulesRoutes } from './routes.js';
import { addArtist, addMovie, addRequest, addTag, addUser, labelsOf, setup, type Fixture } from './test-support.js';

async function build(fx?: Fixture) {
  const f = fx ?? (await setup());
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(tagRulesRoutes(f.service), { prefix: '/api/v1' });
  return { app, fx: f };
}

const RULE = { name: 'Genres', appliesTo: ['movie'], addTags: ['genre:{genre}'] };

describe('tag rule routes', () => {
  it('CRUDs, orders and validates rules', async () => {
    const { app } = await build();
    const created = await app.inject({ method: 'POST', url: '/api/v1/tagrule', payload: RULE });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Genres', enabled: true, match: 'all', conditions: [], removeWhenUnmatched: true, starterKey: null });
    const id = created.json().id as number;
    const second = (await app.inject({ method: 'POST', url: '/api/v1/tagrule', payload: { ...RULE, name: 'Two' } })).json().id as number;

    expect((await app.inject({ method: 'PUT', url: '/api/v1/tagrule/order', payload: { ids: [second, id] } })).json().map((r: { id: number }) => r.id)).toEqual([second, id]);
    const put = await app.inject({ method: 'PUT', url: `/api/v1/tagrule/${id}`, payload: { ...RULE, enabled: false } });
    expect(put.json().enabled).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/v1/tagrule/${id}` })).json().name).toBe('Genres');

    const bad = await app.inject({ method: 'POST', url: '/api/v1/tagrule', payload: { ...RULE, addTags: ['{nope}'] } });
    expect(bad.statusCode).toBe(400);
    const code = await app.inject({ method: 'POST', url: '/api/v1/tagrule', payload: { ...RULE, conditions: [{ kind: 'script', source: 'process.exit()' }] } });
    expect(code.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/tagrule/999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/tagrule/${id}?removeTags=true` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/tagrule' })).json()).toHaveLength(1);
  });

  it('previews, runs (dry and real) and lists applied tags for an item', async () => {
    const { app, fx } = await build();
    const m = addMovie(fx, { genres: ['Horror'] });
    const preview = await app.inject({ method: 'POST', url: '/api/v1/tagrule/preview', payload: { rule: RULE } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, itemsChanged: 1, add: [{ label: 'genre:horror', count: 1, isNew: true }] });

    const rule = (await app.inject({ method: 'POST', url: '/api/v1/tagrule', payload: RULE })).json();
    const dry = await app.inject({ method: 'POST', url: '/api/v1/tagrule/run', payload: { ruleIds: [rule.id], dryRun: true } });
    expect(dry.json()).toMatchObject({ dryRun: true, itemsChanged: 1 });
    expect(labelsOf(fx, 'movie', m)).toEqual([]);
    const run = await app.inject({ method: 'POST', url: '/api/v1/tagrule/run' });
    expect(run.json()).toMatchObject({ dryRun: false, itemsChanged: 1 });
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:horror']);

    const applied = await app.inject({ method: 'GET', url: `/api/v1/tagrule/applied?entityType=movie&entityId=${m}` });
    expect(applied.json()).toEqual([{ tagId: expect.any(Number), ruleId: rule.id, ruleName: 'Genres' }]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/tagrule/applied?entityType=book&entityId=1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/tagrule/run', payload: { ruleIds: [999] } })).statusCode).toBe(404);

    const options = await app.inject({ method: 'GET', url: '/api/v1/tagrule/options' });
    expect(options.json().values.genre).toEqual(['Horror']);
  });

  it('manages tags: usage, merge, bulk delete with an in-use refusal', async () => {
    const { app, fx } = await build();
    const a = addTag(fx, 'a');
    const b = addTag(fx, 'b');
    const unused = addTag(fx, 'unused');
    addMovie(fx, { tags: [a] });
    const usage = (await app.inject({ method: 'GET', url: '/api/v1/tag/usage' })).json();
    expect(usage.map((u: { label: string; total: number }) => [u.label, u.total])).toEqual([
      ['a', 1],
      ['b', 0],
      ['unused', 0],
    ]);
    const merged = await app.inject({ method: 'POST', url: `/api/v1/tag/${a}/merge`, payload: { intoId: b } });
    expect(merged.json()).toEqual({ id: b, label: 'b' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/tag/${b}/merge`, payload: { intoId: 999 } })).statusCode).toBe(404);
    const refused = await app.inject({ method: 'POST', url: '/api/v1/tag/delete', payload: { ids: [b, unused] } });
    expect(refused.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/tag/delete', payload: { ids: [unused] } })).json()).toEqual({ deleted: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/v1/tag/delete', payload: { ids: [b], force: true } })).json()).toEqual({ deleted: 1 });
  });
});

describe('tag rules module', () => {
  const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

  async function moduleHarness() {
    const fx = await setup();
    const log = pino({ level: 'silent' });
    const bus = new EventBus();
    const ctx: AppContext = { config, db: fx.db, bus, scheduler: new Scheduler(fx.db, bus, log), log, startedAt: new Date() };
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(tagRulesModuleWith({ debounceMs: 0 })(ctx), { prefix: '/api/v1' });
    await app.ready();
    return { fx, ctx, app };
  }

  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('seeds the disabled starter rules and registers the daily job', async () => {
    const { ctx, app } = await moduleHarness();
    const rules = (await app.inject({ method: 'GET', url: '/api/v1/tagrule' })).json();
    expect(rules.map((r: { name: string; enabled: boolean }) => [r.name, r.enabled])).toEqual([
      ['Genre tags', false],
      ['Resolution tags', false],
      ['Requested-by tags', false],
      ['4K HDR', false],
      ['Kids', false],
    ]);
    expect(ctx.scheduler.jobSchedule(TAG_RULES_JOB)).toEqual({ cron: '15 4 * * *', enabled: true });
    await app.close();
  });

  it('tags items when library and request events arrive', async () => {
    const { fx, ctx, app } = await moduleHarness();
    const genre = fx.service.listRules().find((r) => r.starterKey === 'genre')!;
    const requested = fx.service.listRules().find((r) => r.starterKey === 'requested-by')!;
    for (const r of [genre, requested]) {
      await app.inject({ method: 'PUT', url: `/api/v1/tagrule/${r.id}`, payload: { ...r, enabled: true } });
    }
    const m = addMovie(fx, { genres: ['Western'] });
    const other = addMovie(fx, { genres: ['Drama'] });
    ctx.bus.publish({ type: 'library', action: 'added', mediaType: 'movie', id: m });
    await tick();
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:western']);
    expect(labelsOf(fx, 'movie', other)).toEqual([]);

    const user = addUser(fx, 'Robin');
    const tmdbId = fx.db.select().from(s.movies).all().find((x) => x.id === m)!.tmdbId;
    const requestId = addRequest(fx, { type: 'movie', tmdbId, userId: user });
    ctx.bus.publish({ type: 'request', action: 'approved', id: requestId });
    await tick();
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:western', 'requested:robin']);
    await app.close();
  });

  it('maps events to items', async () => {
    const fx = await setup();
    const artist = addArtist(fx);
    expect(itemsForEvent(fx, { type: 'library', action: 'fileAdded', mediaType: 'series', id: 4 })).toEqual([{ type: 'series', id: 4 }]);
    expect(itemsForEvent(fx, { type: 'library', action: 'deleted', mediaType: 'series', id: 4 })).toBeNull();
    expect(itemsForEvent(fx, { type: 'import', action: 'imported', title: 'x', mediaType: 'music', mediaId: artist })).toEqual([{ type: 'artist', id: artist }]);
    expect(itemsForEvent(fx, { type: 'import', action: 'imported', title: 'x', mediaType: 'audiobook', mediaId: 3 })).toEqual([{ type: 'author', id: 3 }]);
    expect(itemsForEvent(fx, { type: 'import', action: 'failed', title: 'x', mediaType: 'movie', mediaId: 3 })).toBeNull();
    expect(itemsForEvent(fx, { type: 'request', action: 'declined', id: 1 })).toBeNull();
    expect(itemsForEvent(fx, { type: 'request', action: 'created', id: 999 })).toBeNull();
    expect(itemsForEvent(fx, { type: 'queue', action: 'changed' })).toBeNull();
  });
});
