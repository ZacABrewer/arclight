import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import { importListsRoutes } from './routes.js';
import { fakeFetch, setup } from './test-support.js';

async function build() {
  const fetch = fakeFetch([
    [/feeds\.example\/a\.json$/, () => [{ tmdbId: 1, title: 'One', year: 2001 }]],
    [/api\.trakt\.tv\/oauth\/device\/code$/, () => ({ device_code: 'dc', user_code: 'UC', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 })],
    [/api\.trakt\.tv\/oauth\/device\/token$/, () => new Response('', { status: 400 })],
  ]);
  const ctx = await setup(fetch);
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(importListsRoutes(ctx.service), { prefix: '/api/v1' });
  const body = (over: object = {}) => ({
    name: 'Feed',
    implementation: 'rss',
    rootFolderPath: '/movies',
    qualityProfileId: ctx.profileId,
    mediaType: 'movie',
    settings: { url: 'https://feeds.example/a.json' },
    ...over,
  });
  return { ...ctx, app, body };
}

describe('import-lists routes', () => {
  it('CRUD with error mapping and masked secrets', async () => {
    const { app, body } = await build();
    const created = await app.inject({ method: 'POST', url: '/api/v1/importlist', payload: body() });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: 'POST', url: '/api/v1/importlist', payload: body() })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/importlist/99' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/importlist', payload: body({ name: 'X', implementation: 'bogus' }) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/importlist', payload: body({ name: 'X', settings: {} }) })).json()).toMatchObject({
      code: 'VALIDATION',
    });

    const plex = await app.inject({
      method: 'PUT',
      url: `/api/v1/importlist/${id}`,
      payload: body({ implementation: 'plexWatchlist', settings: { plexToken: 'tok-secret' } }),
    });
    expect(plex.statusCode).toBe(200);
    expect(plex.json().settings.plexToken).toBe(SECRET_MASK);
    const all = await app.inject({ method: 'GET', url: '/api/v1/importlist' });
    expect(all.json()).toHaveLength(1);
    expect(all.body).not.toContain('tok-secret');

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/importlist/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/importlist/${id}` })).statusCode).toBe(404);
  });

  it('serves the schema with field definitions', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/importlist/schema' });
    const trakt = res.json().find((s: { implementation: string }) => s.implementation === 'trakt');
    expect(trakt.requiresTraktAuth).toBe(true);
    expect(trakt.fields.find((f: { name: string }) => f.name === 'accessToken')).toMatchObject({ secret: true, readOnly: true });
    expect(res.json()).toHaveLength(12);
  });

  it('test, sync, preview items and found-in-list', async () => {
    const { app, body } = await build();
    const test = await app.inject({ method: 'POST', url: '/api/v1/importlist/test', payload: body() });
    expect(test.json()).toMatchObject({ ok: true, itemCount: 1, items: [{ tmdbId: 1, title: 'One', inLibrary: false }] });

    const id = (await app.inject({ method: 'POST', url: '/api/v1/importlist', payload: body() })).json().id;
    const sync = await app.inject({ method: 'POST', url: '/api/v1/importlist/sync' });
    expect(sync.json()).toMatchObject({ lists: 1, added: 1 });
    const items = await app.inject({ method: 'GET', url: `/api/v1/importlist/${id}/items` });
    expect(items.json()).toEqual([expect.objectContaining({ tmdbId: 1, inLibrary: true, excluded: false })]);
    const found = await app.inject({ method: 'GET', url: '/api/v1/importlist/items?mediaType=movie&tmdbId=1' });
    expect(found.json()).toEqual([expect.objectContaining({ importListName: 'Feed' })]);
  });

  it('exclusion CRUD and the settings section', async () => {
    const { app } = await build();
    const ex = await app.inject({ method: 'POST', url: '/api/v1/importlistexclusion', payload: { mediaType: 'movie', tmdbId: 5, title: 'Five' } });
    expect(ex.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/api/v1/importlistexclusion', payload: { mediaType: 'movie', tmdbId: 5, title: 'Five' } });
    expect(dup.statusCode).toBe(409);
    const put = await app.inject({ method: 'PUT', url: `/api/v1/importlistexclusion/${ex.json().id}`, payload: { mediaType: 'series', tmdbId: 5, title: 'Five' } });
    expect(put.json().mediaType).toBe('series');
    expect((await app.inject({ method: 'GET', url: '/api/v1/importlistexclusion' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/importlistexclusion/${ex.json().id}` })).statusCode).toBe(204);

    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/importlists' })).json()).toEqual({
      syncIntervalHours: 6,
      cleanLibraryLevel: 'disabled',
      cleanLibraryTags: [],
    });
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/settings/importlists', payload: { syncIntervalHours: 12, cleanLibraryLevel: 'unmonitor' } });
    expect(saved.json()).toMatchObject({ syncIntervalHours: 12, cleanLibraryLevel: 'unmonitor' });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/importlists', payload: { syncIntervalHours: 0 } })).statusCode).toBe(400);
  });

  it('trakt device routes', async () => {
    const { app } = await build();
    const device = await app.inject({ method: 'POST', url: '/api/v1/importlist/trakt/device', payload: { clientId: 'cid' } });
    expect(device.json()).toMatchObject({ deviceCode: 'dc', userCode: 'UC', interval: 5 });
    const poll = await app.inject({ method: 'POST', url: '/api/v1/importlist/trakt/poll', payload: { deviceCode: 'dc', clientId: 'cid', clientSecret: 'cs' } });
    expect(poll.json()).toEqual({ status: 'pending' });
    const noSecret = await app.inject({ method: 'POST', url: '/api/v1/importlist/trakt/poll', payload: { deviceCode: 'dc', clientId: 'cid' } });
    expect(noSecret.statusCode).toBe(400);
  });
});
