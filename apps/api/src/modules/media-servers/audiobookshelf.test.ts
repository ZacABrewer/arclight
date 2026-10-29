// Audiobookshelf as a configured media server: stored like the others, never a sign-in
// provider, left out of the video purposes, and refreshed after audiobook imports when one of
// its book libraries holds the book folder. Real clients against fake HTTP servers.

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { SECRET_MASK, type MediaServerConfig } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { getSection, setSection } from '../settings/service.js';
import { mediaServerView, primaryMediaServer } from './legacy.js';
import { mediaServersRoutes } from './routes.js';
import { MediaServersService } from './service.js';

interface Call {
  host: string;
  method: string;
  path: string;
  auth: string | undefined;
}

const ABS_LIBRARIES = {
  libraries: [
    { id: 'books', name: 'Audiobooks', mediaType: 'book', folders: [{ id: 'f1', fullPath: '/data/audiobooks' }] },
    { id: 'other', name: 'Other Books', mediaType: 'book', folders: [{ id: 'f2', fullPath: '/data/other' }] },
    { id: 'pods', name: 'Podcasts', mediaType: 'podcast', folders: [{ id: 'f3', fullPath: '/data/audiobooks/podcasts' }] },
  ],
};
const JELLYFIN_FOLDERS = [{ Name: 'Music', ItemId: 'mu', CollectionType: 'music', Locations: ['/data/music'] }];

function fakeServers() {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ host: url.hostname, method: init?.method ?? 'GET', path: url.pathname, auth: headers['Authorization'] });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.hostname === 'abs.lan') {
      if (headers['Authorization'] !== 'Bearer abs-token') return new Response('Unauthorized', { status: 401 });
      if (url.pathname === '/status') return json({ app: 'audiobookshelf', serverVersion: '2.17.2', isInit: true });
      if (url.pathname === '/api/libraries') return json(ABS_LIBRARIES);
      if (/^\/api\/libraries\/[^/]+\/scan$/.test(url.pathname) && init?.method === 'POST') return new Response('OK', { status: 200 });
    }
    if (url.hostname === 'jf.lan' && url.pathname === '/Library/VirtualFolders') return json(JELLYFIN_FOLDERS);
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

const server = (id: string, kind: MediaServerConfig['kind'], host: string, o: Partial<MediaServerConfig> = {}): MediaServerConfig => ({
  id,
  kind,
  name: id,
  url: `http://${host}`,
  apiKey: kind === 'audiobookshelf' ? 'abs-token' : 'key',
  enabled: true,
  usedForAvailability: true,
  usedForRetention: true,
  usedForRefresh: true,
  loginEnabled: false,
  createUsersOnLogin: false,
  ...o,
});

async function build(servers: MediaServerConfig[] = []) {
  const db = await createTestDb();
  setSection(db, 'mediaServers', { servers });
  const fake = fakeServers();
  let n = 0;
  const service = new MediaServersService({ db, fetch: fake.fetch, newId: () => `srv${++n}` });
  return { db, service, calls: fake.calls };
}

describe('Audiobookshelf media servers', () => {
  it('refreshes only the book library holding the imported book folder', async () => {
    const { service, calls } = await build([server('abs', 'audiobookshelf', 'abs.lan'), server('jf', 'jellyfin', 'jf.lan')]);
    const path = '/data/audiobooks/Fixture Author/Lantern Road';
    const results = await service.refreshPath({ path, mediaType: 'audiobook', updateType: 'Created' });
    expect(results).toEqual([
      { serverId: 'abs', name: 'abs', status: 'refreshed', libraries: ['Audiobooks'] },
      { serverId: 'jf', name: 'jf', status: 'skipped', libraries: [], message: `No audiobook/music library contains ${path}` },
    ]);
    const scans = calls.filter((c) => c.method === 'POST');
    expect(scans).toEqual([{ host: 'abs.lan', method: 'POST', path: '/api/libraries/books/scan', auth: 'Bearer abs-token' }]);
  });

  it('skips Audiobookshelf for music and video paths', async () => {
    const { service, calls } = await build([server('abs', 'audiobookshelf', 'abs.lan')]);
    expect(await service.refreshPath({ path: '/data/music/Artist/Album', mediaType: 'music' })).toMatchObject([{ serverId: 'abs', status: 'skipped' }]);
    expect(await service.refreshPath({ path: '/data/audiobooks/x', mediaType: 'movie' })).toMatchObject([{ serverId: 'abs', status: 'skipped' }]);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('is left out of the video purposes and of sign-in', async () => {
    const { service, db } = await build([server('abs', 'audiobookshelf', 'abs.lan', { loginEnabled: true }), server('jf', 'jellyfin', 'jf.lan')]);
    expect(service.clients('availability').map((c) => c.config.id)).toEqual(['jf']);
    expect(service.clients('retention').map((c) => c.config.id)).toEqual(['jf']);
    expect(service.clients('refresh').map((c) => c.config.id)).toEqual(['abs', 'jf']);
    // Even a stored login flag never makes Audiobookshelf the sign-in server.
    expect(primaryMediaServer(service.stored())?.id).toBe('jf');
    expect(mediaServerView(db).kind).toBe('jellyfin');
  });

  it('stores an Audiobookshelf connection with its login flags forced off, and tests it', async () => {
    const { service, db } = await build();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mediaServersRoutes(service), { prefix: '/api/v1' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/mediaserver',
      payload: { kind: 'audiobookshelf', name: 'Shelf', url: 'abs.lan', apiKey: 'abs-token', usedForRefresh: true, loginEnabled: true, createUsersOnLogin: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'audiobookshelf', name: 'Shelf', url: 'http://abs.lan', apiKey: SECRET_MASK, usedForRefresh: true, loginEnabled: false, createUsersOnLogin: false });
    expect(getSection(db, 'mediaServers').servers[0]).toMatchObject({ apiKey: 'abs-token', loginEnabled: false });

    const id = created.json<{ id: string }>().id;
    const updated = await app.inject({ method: 'PUT', url: `/api/v1/mediaserver/${id}`, payload: { kind: 'audiobookshelf', name: 'Shelf', url: 'abs.lan', apiKey: SECRET_MASK, loginEnabled: true } });
    expect(updated.json()).toMatchObject({ loginEnabled: false });
    expect(getSection(db, 'mediaServers').servers[0]!.apiKey).toBe('abs-token');

    const test = await app.inject({ method: 'POST', url: `/api/v1/mediaserver/${id}/test` });
    expect(test.json()).toEqual({
      ok: true,
      serverName: 'Audiobookshelf',
      version: '2.17.2',
      libraries: [
        { id: 'books', name: 'Audiobooks', type: 'audiobook' },
        { id: 'other', name: 'Other Books', type: 'audiobook' },
        { id: 'pods', name: 'Podcasts', type: 'other' },
      ],
    });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/mediaserver/test', payload: { kind: 'audiobookshelf', name: 'X', url: 'abs.lan', apiKey: 'wrong' } });
    expect(bad.json()).toMatchObject({ ok: false, code: 'unauthorized' });
    await app.close();
  });
});
