import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { PASSWORD_MASK } from '@arclight/shared';
import { downloadClientsRoutes } from './routes.js';
import { item, qbit, setup } from './test-support.js';

async function build() {
  const ctx = await setup();
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(downloadClientsRoutes(ctx.service), { prefix: '/api/v1' });
  return { ...ctx, app };
}

describe('download-clients routes', () => {
  it('POST/GET /downloadclient never returns the password', async () => {
    const { app } = await build();
    const created = await app.inject({ method: 'POST', url: '/api/v1/downloadclient', payload: qbit('Main') });
    expect(created.statusCode).toBe(201);
    expect(created.json().settings.password).toBe(PASSWORD_MASK);
    const list = await app.inject({ method: 'GET', url: '/api/v1/downloadclient' });
    expect(JSON.stringify(list.json())).not.toContain('secret');
  });

  it('maps service errors to HTTP status codes', async () => {
    const { app } = await build();
    await app.inject({ method: 'POST', url: '/api/v1/downloadclient', payload: qbit('Main') });
    const dup = await app.inject({ method: 'POST', url: '/api/v1/downloadclient', payload: qbit('Main') });
    expect(dup.statusCode).toBe(409);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/downloadclient/42' });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/downloadclient', payload: { name: 'x', implementation: 'nope' } });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /downloadclient/schema lists implementation templates', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/downloadclient/schema' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ implementation: 'qbittorrent', protocol: 'torrent' });
  });

  it('serves the queue, its status and single/bulk delete', async () => {
    const { app, service, fake } = await build();
    const c = service.create(qbit('Main'));
    fake(c.id).items = [item({ id: 'h1' }), item({ id: 'h2' }), item({ id: 'h3' })];
    await service.refreshQueue();

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/queue' });
    expect(hidden.json().totalRecords).toBe(0);
    const page = await app.inject({ method: 'GET', url: '/api/v1/queue?includeUnknownMediaItems=true&sortKey=title&sortDirection=asc' });
    expect(page.statusCode).toBe(200);
    const ids: number[] = page.json().records.map((r: { id: number }) => r.id);
    expect(ids).toHaveLength(3);

    const status = await app.inject({ method: 'GET', url: '/api/v1/queue/status' });
    expect(status.json()).toEqual({ totalCount: 0, unknownCount: 3, errors: 0, warnings: 0 });

    const one = await app.inject({ method: 'DELETE', url: `/api/v1/queue/${ids[0]}?removeFromClient=false` });
    expect(one.json()).toEqual({ removed: [ids[0]], failed: [] });
    expect(fake(c.id).removed).toEqual([]);

    const bulk = await app.inject({ method: 'DELETE', url: '/api/v1/queue/bulk', payload: { ids: [ids[1], ids[2]] } });
    expect(bulk.json().removed).toEqual([ids[1], ids[2]]);
    expect(fake(c.id).removed.map((r) => r.id)).toEqual(['h2', 'h3']);
  });

  it('remote path mapping CRUD over HTTP', async () => {
    const { app } = await build();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/remotepathmapping',
      payload: { host: 'seedbox', remotePath: '/data', localPath: '/mnt/data' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ remotePath: '/data/', localPath: '/mnt/data/' });
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/remotepathmapping/${created.json().id}` });
    expect(del.statusCode).toBe(204);
  });
});
