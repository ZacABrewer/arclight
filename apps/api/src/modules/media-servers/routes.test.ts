import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { MediaServerError, type MediaServerClientOptions } from '@arclight/media-servers';
import { SECRET_MASK } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { getSection } from '../settings/service.js';
import { FakeMediaServer } from '../retention/test-support.js';
import { mediaServersRoutes } from './routes.js';
import { MediaServersService } from './service.js';

async function build() {
  const db = await createTestDb();
  const built: MediaServerClientOptions[] = [];
  const fake = new FakeMediaServer('jellyfin', 'Basement');
  fake.user('alice', { isAdmin: true });
  let n = 0;
  const service = new MediaServersService({
    db,
    newId: () => `srv${++n}`,
    clientFactory: (opts) => {
      built.push(opts);
      return fake;
    },
  });
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(mediaServersRoutes(service), { prefix: '/api/v1' });
  return { app, db, service, fake, built };
}

const JELLY = { kind: 'jellyfin', name: 'Basement', url: 'jellyfin.lan:8096/', apiKey: 'top-secret', usedForRetention: true };

describe('media-servers routes', () => {
  it('creates a server, masks the key and normalises the URL', async () => {
    const { app, db } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: JELLY });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: 'srv1',
      kind: 'jellyfin',
      name: 'Basement',
      url: 'http://jellyfin.lan:8096',
      apiKey: SECRET_MASK,
      enabled: true,
      usedForAvailability: true,
      usedForRetention: true,
      usedForRefresh: false,
      loginEnabled: false,
      createUsersOnLogin: false,
    });
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/v1/mediaserver' })).json())).not.toContain('top-secret');
    expect(getSection(db, 'mediaServers').servers[0]!.apiKey).toBe('top-secret');
  });

  it('keeps the stored key when the mask is sent back, replaces it otherwise', async () => {
    const { app, service } = await build();
    await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: JELLY });
    await app.inject({ method: 'PUT', url: '/api/v1/mediaserver/srv1', payload: { ...JELLY, name: 'Den', apiKey: SECRET_MASK } });
    expect(service.stored()[0]).toMatchObject({ name: 'Den', apiKey: 'top-secret' });
    await app.inject({ method: 'PUT', url: '/api/v1/mediaserver/srv1', payload: { ...JELLY, apiKey: 'new-key' } });
    expect(service.stored()[0]!.apiKey).toBe('new-key');
  });

  it('maps validation, conflicts and missing servers to HTTP', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: { ...JELLY, apiKey: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: { ...JELLY, kind: 'kodi' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: { ...JELLY, url: 'ftp://x' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: JELLY });
    expect((await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: { ...JELLY, name: 'basement' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/mediaserver/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/mediaserver/srv1' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/mediaserver/srv1' })).statusCode).toBe(404);
  });

  it('tests a stored server and an unsaved candidate (masked key reuses the stored one)', async () => {
    const { app, fake, built } = await build();
    await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: JELLY });
    const ok = await app.inject({ method: 'POST', url: '/api/v1/mediaserver/srv1/test' });
    expect(ok.json()).toMatchObject({ ok: true, serverName: 'Basement', version: '1.0', libraries: [{ id: 'lib1', type: 'movie' }] });
    await app.inject({ method: 'POST', url: '/api/v1/mediaserver/test', payload: { ...JELLY, id: 'srv1', apiKey: SECRET_MASK } });
    expect(built.at(-1)!.apiKey).toBe('top-secret');
    fake.fail = new MediaServerError('jellyfin', 'unauthorized', 'responded 401');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/mediaserver/srv1/test' });
    expect(bad.json()).toEqual({ ok: false, message: 'responded 401', code: 'unauthorized' });
  });

  it('lists server users and maps server failures to 502', async () => {
    const { app, fake } = await build();
    await app.inject({ method: 'POST', url: '/api/v1/mediaserver', payload: JELLY });
    const users = await app.inject({ method: 'GET', url: '/api/v1/mediaserver/srv1/users' });
    expect(users.json()).toEqual([{ id: 'Basement-alice', name: 'alice', isAdmin: true, isDisabled: false, lastActivityAt: null }]);
    fake.fail = new Error('down');
    expect((await app.inject({ method: 'GET', url: '/api/v1/mediaserver/srv1/users' })).statusCode).toBe(502);
  });

  it('hands out clients by purpose: enabled servers with the matching flag only', async () => {
    const { service } = await build();
    service.create({ ...JELLY, kind: 'jellyfin' });
    service.create({ kind: 'plex', name: 'Plex', url: 'http://plex:32400', apiKey: 't', usedForRetention: false, usedForRefresh: true });
    service.create({ kind: 'emby', name: 'Off', url: 'http://emby', apiKey: 'k', enabled: false, usedForRetention: true });
    expect(service.clients('retention').map((c) => c.config.name)).toEqual(['Basement']);
    expect(service.clients('refresh').map((c) => c.config.name)).toEqual(['Plex']);
    expect(service.clients('availability').map((c) => c.config.name)).toEqual(['Basement', 'Plex']);
  });
});
