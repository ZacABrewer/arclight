import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { MediaServerTagSync, type MediaServerConfig } from '@arclight/shared';
import { mergeTags, type MediaServerItem } from '@arclight/media-servers';
import { eq } from 'drizzle-orm';
import { movies, tags } from '../../db/schema.js';
import { authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { addUser, setup } from '../requests/test-support.js';
import { addMovie } from '../watch-history/test-support.js';
import { tagSyncRoutes } from './routes.js';
import { TagSyncService, type TagSyncTarget } from './service.js';

describe('tag sync routes', () => {
  it('are admin-only and serve status, preview, run, forget and remove-all', async () => {
    const h = await setup();
    const remote = new Map<string, string[]>([['m1', ['Favourite']]]);
    const target: TagSyncTarget = {
      listItems: async (kind) => (kind === 'movie' ? [{ id: 'm1', mediaType: 'movie', title: 'Arrival', year: null, ids: { tmdbId: 1 }, path: null, libraryId: '1' } as MediaServerItem] : []),
      readTags: async (ids) => new Map(ids.filter((id) => remote.has(id)).map((id) => [id, remote.get(id)!])),
      writeTags: async (item, add, remove) => {
        remote.set(item.id, mergeTags(remote.get(item.id) ?? [], add, remove));
      },
      requestsPerWrite: 2,
    };
    const servers = [
      { id: 'jf1', name: 'Den', kind: 'jellyfin', enabled: true, url: 'http://jellyfin.example.com', apiKey: 'k', tagSync: MediaServerTagSync.parse({ enabled: true, prefix: 'arclight:' }) },
      { id: 'abs', name: 'Books', kind: 'audiobookshelf', enabled: true, url: 'http://abs.example.com', apiKey: 'k' },
    ] as MediaServerConfig[];
    const service = new TagSyncService({ db: h.db, servers: () => servers, target: () => target, sleep: async () => undefined });
    const kids = h.db.insert(tags).values({ label: 'kids' }).returning().get().id;
    const movieId = addMovie(h.db, 1, 'Arrival');
    h.db.update(movies).set({ tags: [kids] }).where(eq(movies.id, movieId)).run();

    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      async (api) => {
        installAuth(api, h.ctx);
        await api.register(tagSyncRoutes(service));
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    const auth = authServiceFor(h.ctx);
    addUser(h.db, { role: 'admin', username: 'owner' });
    const admin = { 'x-api-key': auth.apiKey() };
    const user = addUser(h.db, { username: 'kid' });
    const userHeaders = { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}` };
    const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = admin) => app.inject({ method, url: `/api/v1${url}`, headers });

    expect((await call('GET', '/mediaserver/jf1/tag-sync', userHeaders)).statusCode).toBe(403);
    expect((await call('POST', '/mediaserver/jf1/tag-sync/run', userHeaders)).statusCode).toBe(403);

    expect((await call('GET', '/mediaserver/jf1/tag-sync')).json()).toEqual({ running: false, lastRunAt: null, lastChanged: 0, lastUnmatched: 0, lastError: null });
    const preview = await call('POST', '/mediaserver/jf1/tag-sync/preview');
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      changes: [{ entityType: 'movie', entityId: movieId, title: 'Arrival', remoteItemId: 'm1', add: ['arclight:kids'], remove: [] }],
      totalChanges: 1,
      unmatched: 0,
      truncated: false,
    });
    expect(remote.get('m1')).toEqual(['Favourite']);

    expect((await call('POST', '/mediaserver/jf1/tag-sync/run')).statusCode).toBe(202);
    await service.schedule('jf1', []);
    expect(remote.get('m1')).toEqual(['Favourite', 'arclight:kids']);
    expect((await call('GET', '/mediaserver/jf1/tag-sync')).json()).toMatchObject({ lastChanged: 1, lastError: null });

    expect((await call('POST', '/mediaserver/jf1/tag-sync/remove-all')).statusCode).toBe(202);
    await service.schedule('jf1', []);
    expect(remote.get('m1')).toEqual(['Favourite']);
    expect(service.owned('jf1')).toEqual([]);

    expect((await call('POST', '/mediaserver/jf1/tag-sync/forget')).statusCode).toBe(204);
    expect((await call('POST', '/mediaserver/abs/tag-sync/preview')).statusCode).toBe(400);
    expect((await call('GET', '/mediaserver/nope/tag-sync')).statusCode).toBe(404);
    await app.close();
  });
});
