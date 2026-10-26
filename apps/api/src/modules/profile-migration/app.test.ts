import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildItems, findItem, itemId } from '@arclight/profiles-engine';
import { QUALITIES, type QualityName, type QualityProfile } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { movies } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { insertFile, insertMovie } from '../notifications/test-support.js';
import { profileMigrationServiceFor } from './index.js';

// The module inside the whole app: bus-driven detection of item and profile changes.

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

const quality = (name: QualityName) => ({
  quality: { ...QUALITIES[name], mediaTypes: [...QUALITIES[name].mediaTypes] },
  revision: { version: 1, real: 0, isRepack: false },
});

function profileBody(name: string, allowed: QualityName[], cutoff: QualityName) {
  const items = buildItems(allowed);
  return {
    name,
    upgradeAllowed: true,
    cutoff: itemId(findItem({ items } as unknown as QualityProfile, QUALITIES[cutoff].id)!),
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function app() {
  const db = await createTestDb();
  let ctxRef: AppContext | undefined;
  const instance = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctxRef = c) });
  await instance.ready();
  close = () => instance.close();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    instance.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const migration = profileMigrationServiceFor(ctx);
  return { db, api, migration };
}

describe('profile migration in the app', () => {
  it('records a profile change made through the movie editor, once', async () => {
    const { db, api, migration } = await app();
    const hd = (await api('POST', '/qualityprofile', profileBody('Plain HD', ['WEBDL-1080p', 'Bluray-1080p'], 'Bluray-1080p'))).json<QualityProfile>();
    const uhd = (await api('POST', '/qualityprofile', profileBody('Plain UHD', ['Bluray-1080p', 'Bluray-2160p'], 'Bluray-2160p'))).json<QualityProfile>();
    const movie = insertMovie(db, { qualityProfileId: hd.id, title: 'Heat' });
    const file = insertFile(db, { mediaType: 'movie', movieId: movie.id, quality: quality('WEBDL-1080p') });
    db.update(movies).set({ hasFile: true, movieFileId: file.id }).run();
    migration.reevaluate('all');

    expect((await api('PUT', `/movie/${movie.id}`, { qualityProfileId: uhd.id })).statusCode).toBe(200);
    await migration.flush();

    const history = (await api('GET', `/history?page=1&pageSize=50`)).json<{ records: Array<{ eventType: string; data: Record<string, string> }> }>();
    const changed = history.records.filter((r) => r.eventType === 'profileChanged');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.data).toMatchObject({ oldProfile: 'Plain HD', newProfile: 'Plain UHD' });
    // WEBDL-1080p is not allowed by the new profile.
    expect((await api('GET', '/profilemigration/items')).json()).toEqual([{ mediaType: 'movie', id: movie.id, status: 'notAllowed', notAllowed: 1, upgradeAllowed: 0 }]);
  });

  it('re-judges files when a profile is edited', async () => {
    const { db, api, migration } = await app();
    const body = profileBody('Plain HD', ['WEBDL-1080p', 'Bluray-1080p'], 'Bluray-1080p');
    const hd = (await api('POST', '/qualityprofile', body)).json<QualityProfile>();
    const movie = insertMovie(db, { qualityProfileId: hd.id, title: 'Heat' });
    insertFile(db, { mediaType: 'movie', movieId: movie.id, quality: quality('WEBDL-1080p') });
    migration.reevaluate('all');
    expect((await api('GET', `/profilemigration/profiles/${hd.id}`)).json()).toMatchObject({ files: { upgradeAllowed: 1, notAllowed: 0 } });

    const narrowed = profileBody('Plain HD', ['Bluray-1080p'], 'Bluray-1080p');
    expect((await api('PUT', `/qualityprofile/${hd.id}`, narrowed)).statusCode).toBe(200);
    await migration.flush();
    expect((await api('GET', `/profilemigration/profiles/${hd.id}`)).json()).toMatchObject({ mismatchedItems: 1, files: { notAllowed: 1 } });
  });
});
