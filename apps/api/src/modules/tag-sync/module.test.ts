import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { tags } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { addMovie } from '../watch-history/test-support.js';
import { tagSyncServiceFor } from './index.js';

const config: AppConfig = {
  configDir: '.',
  dbPath: ':memory:',
  logDir: '.',
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  isDocker: false,
  webDist: null,
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
});

// The bus wiring between the routes that change tags or server settings and the debounced sync.
describe('tag sync module', () => {
  it('queues a pass when a server is saved and when bulk edits change tags', async () => {
    const db = await createTestDb();
    seedAdmin(db);
    let ctx: AppContext | undefined;
    const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
    close = () => app.close();
    await app.ready();
    const headers = { 'x-api-key': authServiceFor(ctx!).apiKey() };
    const svc = tagSyncServiceFor(ctx!);
    const servers = vi.spyOn(svc, 'markSyncingServersDirty');
    const titles = vi.spyOn(svc, 'markDirty');

    const server = { kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.example.com', apiKey: 'k', tagSync: { enabled: true } };
    const created = await app.inject({ method: 'POST', url: '/api/v1/mediaserver', headers, payload: server });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(servers).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/mediaserver/${id}`, headers, payload: { ...server, apiKey: '********' } })).statusCode).toBe(200);
    expect(servers).toHaveBeenCalledTimes(2);

    const kids = db.insert(tags).values({ label: 'kids' }).returning().get().id;
    const a = addMovie(db, 1, 'Arrival');
    const b = addMovie(db, 2, 'Heat');
    const bulk = await app.inject({ method: 'PUT', url: '/api/v1/movie/bulk', headers, payload: { ids: [a, b], tags: { add: [kids] } } });
    expect(bulk.statusCode).toBe(200);
    expect(titles).toHaveBeenCalledWith({ type: 'movie', id: a });
    expect(titles).toHaveBeenCalledWith({ type: 'movie', id: b });
    svc.dispose();
  });
});
