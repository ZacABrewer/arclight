import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrateSourceInput, MigrationPlan, MigrationResult } from '@arclight/shared';
import type { Db } from '../../../db/index.js';
import * as t from '../../../db/schema.js';
import { createTestDb } from '../../../db/test-utils.js';
import type { DefinitionRef } from '../deps.js';
import { MigrateError } from '../errors.js';
import { fetchAllPages, SourceHttp } from '../http.js';
import { migrateImported, migrateStaging } from '../schema.js';
import { MigrateService } from '../service.js';
import { makeRadarrDb, makeSonarrDb } from '../test-fixtures.js';
import { fieldsToSettings } from './arr-api.js';
import { fakeArr, paged, prowlarrApiRoutes, radarrApiRoutes, sonarrApiRoutes, type FakeArr } from './fixtures-arr.js';

let tmp: string;
let db: Db;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mt-migrate-api-'));
  db = await createTestDb({ migrateImported, migrateStaging });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = 'test-api-key';

function serviceWith(fake: FakeArr, findDefinition?: (id: string) => DefinitionRef | null): MigrateService {
  return new MigrateService({ db, now: () => new Date('2024-06-01T00:00:00Z'), deps: { fetch: fake.fetch, ...(findDefinition ? { findDefinition } : {}) } });
}

function api(app: 'sonarr' | 'radarr' | 'prowlarr', extra: Partial<MigrateSourceInput> = {}): MigrateSourceInput {
  return { app, mode: 'api', url: `http://${app}:1234`, apiKey: KEY, ...extra };
}

/** Area counts, the part of a plan that must not depend on how the source was read. */
const counts = (plan: MigrationPlan) => plan.areas.map((a) => [a.area, a.total, a.create, a.unsupported, a.details]);
const area = (r: MigrationResult, name: string) => r.areas.find((a) => a.area === name)!;

describe('fieldsToSettings', () => {
  it('folds dotted names into objects and reports masked secrets', () => {
    const masked: string[] = [];
    const s = fieldsToSettings(
      [
        { name: 'baseUrl', value: 'http://x' },
        { name: 'seedCriteria.seedRatio', value: 1.5 },
        { name: 'seedCriteria.seedTime', value: 60 },
        { name: 'apiKey', value: '********' },
      ],
      masked,
    );
    expect(s).toEqual({ baseUrl: 'http://x', seedCriteria: { seedRatio: 1.5, seedTime: 60 } });
    expect(masked).toEqual(['apiKey']);
  });
});

describe('fetchAllPages', () => {
  it('reads every page', async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const fake = fakeArr({ '/api/v3/history': paged(records) }, KEY);
    const http = new SourceHttp({ baseUrl: 'http://sonarr:1', headers: { 'X-Api-Key': KEY }, appName: 'Sonarr', fetch: fake.fetch });
    const all = await fetchAllPages<{ id: number }>(http, '/api/v3/history', {}, 2);
    expect(all.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fake.calls.filter((c) => c.startsWith('/api/v3/history'))).toHaveLength(3);
  });
});

describe('Sonarr through the API', () => {
  it('plans the same areas and counts as the database reader', async () => {
    const fake = fakeArr(sonarrApiRoutes(), KEY);
    const service = serviceWith(fake);
    const dbPath = join(tmp, 'sonarr.db');
    makeSonarrDb(dbPath);
    const fromFiles = await service.plan({ app: 'sonarr', dbPath });
    const fromApi = await service.plan(api('sonarr'));
    expect(counts(fromApi)).toEqual(counts(fromFiles));
    expect(fromApi.schemaVersion).toBe('4.0.10.2544');
    expect(fromApi.source.apiKey).toBe('********');
    // Episodes and files are read per series.
    expect(fake.calls).toContain('/api/v3/episode?seriesId=1');
    expect(fake.calls).toContain('/api/v3/episodefile?seriesId=3');
  });

  it('warns about secrets the API hides and never imports the mask', async () => {
    const service = serviceWith(fakeArr(sonarrApiRoutes(), KEY));
    const plan = await service.plan(api('sonarr'));
    expect(plan.warnings).toContainEqual(expect.objectContaining({ area: 'indexers', sourceId: '1', message: expect.stringMatching(/"NZBgeek": apiKey hidden by the API/) }));
    expect(plan.warnings).toContainEqual(expect.objectContaining({ area: 'downloadClients', message: expect.stringMatching(/"qBit": password/) }));
    const result = await service.apply(api('sonarr'));
    expect(area(result, 'indexers').created).toBe(2);
    const geek = db.select().from(t.indexers).all().find((r) => r.name === 'NZBgeek')!;
    expect(geek.settings.apiKey).toBeUndefined();
    const jackett = db.select().from(t.indexers).all().find((r) => r.name === 'Jackett 1337x')!;
    expect(jackett.settings).toMatchObject({ apiKey: 'jk', minimumSeeders: 5, seedRatio: 1.5, seedTime: 3_600_000 });
    const qbit = db.select().from(t.downloadClients).all().find((r) => r.name === 'qBit')!;
    expect(qbit.settings['password']).toBe('');
    expect(JSON.stringify(db.select().from(t.downloadClients).all())).not.toContain('********');
  });

  it('imports the library, history and blocklist and is idempotent', async () => {
    const service = serviceWith(fakeArr(sonarrApiRoutes(), KEY));
    const first = await service.apply(api('sonarr', { pathMappings: [{ from: '/tv', to: join(tmp, 'tv') }] }));
    expect(area(first, 'series')).toMatchObject({ created: 2, failed: 0 });
    const bb = db.select().from(t.series).all().find((s) => s.tmdbId === 1396)!;
    expect(bb).toMatchObject({ title: 'Breaking Bad', status: 'ended', monitored: true, monitorNewItems: 'all', originalLanguage: 'en', path: join(tmp, 'tv', 'Breaking Bad') });
    const anime = db.select().from(t.series).all().find((s) => s.tmdbId === 999)!;
    expect(anime).toMatchObject({ seriesType: 'anime', monitorNewItems: 'none', seasonFolder: false });
    const file = db.select().from(t.mediaFiles).all().find((f) => f.seriesId === bb.id)!;
    expect(file).toMatchObject({ sizeBytes: 3_000_000_000, releaseGroup: 'NTb' });
    expect(file.mediaInfo).toMatchObject({ resolution: '1920x1080', videoCodec: 'x264' });
    expect(db.select().from(t.episodes).all().filter((e) => e.seriesId === bb.id && e.hasFile)).toHaveLength(2);
    expect(area(first, 'history')).toMatchObject({ created: 3 });
    expect(area(first, 'blocklist')).toMatchObject({ created: 1 });
    expect(db.select().from(t.blocklist).get()).toMatchObject({ protocol: 'torrent', torrentInfoHash: 'abcdef' });
    expect(area(first, 'delayProfiles').created + area(first, 'delayProfiles').skipped).toBe(2);

    const before = { series: db.select().from(t.series).all().length, history: db.select().from(t.history).all().length, files: db.select().from(t.mediaFiles).all().length };
    const second = await service.apply(api('sonarr', { pathMappings: [{ from: '/tv', to: join(tmp, 'tv') }] }));
    expect(second.areas.reduce((n, a) => n + a.created + a.failed, 0)).toBe(0);
    expect({ series: db.select().from(t.series).all().length, history: db.select().from(t.history).all().length, files: db.select().from(t.mediaFiles).all().length }).toEqual(before);
  });

  it('carries naming and media management settings', async () => {
    const service = serviceWith(fakeArr(sonarrApiRoutes(), KEY));
    await service.apply(api('sonarr'));
    const naming = db.select().from(t.settings).all().find((s) => s.key === 'naming')!;
    expect(naming.value).toMatchObject({ renameEpisodes: true, colonReplacement: 'dash', multiEpisodeStyle: 'range', seasonFolderFormat: 'Season {season:00}' });
    const mm = db.select().from(t.settings).all().find((s) => s.key === 'mediaManagement')!;
    expect(mm.value).toMatchObject({ recycleBinPath: '/data/recycle', recycleBinCleanupDays: 14, useHardlinks: false, extraFileExtensions: ['srt', 'nfo'] });
  });

  it('refuses the wrong app and a rejected key', async () => {
    const routes = sonarrApiRoutes();
    routes['/api/v3/system/status'] = { appName: 'Radarr', version: '5.0' };
    await expect(serviceWith(fakeArr(routes, KEY)).plan(api('sonarr'))).rejects.toMatchObject({ code: 'WRONG_APP' });
    const err = await serviceWith(fakeArr(sonarrApiRoutes(), 'other-key'))
      .plan(api('sonarr'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrateError);
    expect((err as MigrateError).code).toBe('AUTH');
  });
});

describe('Radarr through the API', () => {
  it('plans the same as the database reader and imports movies with their file', async () => {
    const service = serviceWith(fakeArr(radarrApiRoutes(), KEY));
    const dbPath = join(tmp, 'radarr.db');
    makeRadarrDb(dbPath);
    const fromFiles = await service.plan({ app: 'radarr', dbPath });
    const fromApi = await service.plan(api('radarr'));
    expect(counts(fromApi)).toEqual(counts(fromFiles));

    const result = await service.apply(api('radarr'));
    expect(area(result, 'movies')).toMatchObject({ created: 1, skipped: 1 });
    expect(area(result, 'collections')).toMatchObject({ staged: 1 });
    const movie = db.select().from(t.movies).get()!;
    expect(movie).toMatchObject({ tmdbId: 603, status: 'released', minimumAvailability: 'inCinemas', hasFile: true, collection: { tmdbId: 2344, title: 'The Matrix Collection' } });
    expect(movie.ratings).toMatchObject({ imdb: { votes: 100, value: 8.7 } });
    expect(db.select().from(t.mediaFiles).get()).toMatchObject({ edition: "Director's Cut", languages: ['en', 'hi'] });
    const naming = db.select().from(t.settings).all().find((s) => s.key === 'naming')!;
    expect(naming.value).toMatchObject({ colonReplacement: 'smart', renameMovies: true });
  });
});

describe('Prowlarr through the API', () => {
  const knows1337x = (id: string): DefinitionRef | null =>
    id.toLowerCase() === '1337x' ? { id: '1337x', name: '1337x', privacy: 'public', settings: ['sort'], links: ['https://1337x.to/'] } : null;

  it('maps definitions, proxies unknown sites through Prowlarr, imports proxies, reports applications', async () => {
    const service = serviceWith(fakeArr(prowlarrApiRoutes(), KEY), knows1337x);
    const plan = await service.plan(api('prowlarr'));
    expect(plan.areas.find((a) => a.area === 'indexers')).toMatchObject({ total: 3, create: 3, details: { definitions: 1, proxied: 1 } });
    expect(plan.areas.find((a) => a.area === 'indexerProxies')).toMatchObject({ total: 3, create: 2, unsupported: 1 });
    expect(plan.unsupported).toContainEqual(expect.objectContaining({ area: 'indexerProxies', name: 'Old Socks', reason: expect.stringMatching(/Socks4/) }));
    expect(plan.warnings).toContainEqual(expect.objectContaining({ area: 'indexers', message: expect.stringMatching(/"Secret Tracker": password hidden/) }));
    expect(plan.warnings).toContainEqual(expect.objectContaining({ area: 'indexers', message: expect.stringMatching(/Secret Tracker.*must keep running/) }));

    const result = await service.apply(api('prowlarr'));
    expect(area(result, 'indexers')).toMatchObject({ created: 3, failed: 0 });
    expect(area(result, 'indexerProxies')).toMatchObject({ created: 2 });
    expect(area(result, 'applications')).toMatchObject({ skipped: 1 });
    const rows = db.select().from(t.indexers).all();
    const leet = rows.find((r) => r.name === '1337x')!;
    expect(leet.implementation).toBe('definition');
    expect(leet.settings).toMatchObject({ definitionId: '1337x', fields: { sort: 'seeders' }, seedRatio: 2, seedTime: 1440 * 60_000 });
    const secret = rows.find((r) => r.name === 'Secret Tracker')!;
    expect(secret).toMatchObject({ implementation: 'torznab' });
    expect(secret.settings).toMatchObject({ baseUrl: 'http://prowlarr:1234/4', apiKey: KEY });
    const corp = db.select().from(t.indexerProxies).all().find((p) => p.name === 'Corp')!;
    expect(corp).toMatchObject({ type: 'http', host: 'proxy.example', port: 3128, username: 'u', password: null });

    const again = await service.apply(api('prowlarr'));
    expect(again.areas.reduce((n, a) => n + a.created + a.failed, 0)).toBe(0);
  });

  it('without a catalogue match every Cardigann indexer is proxied', async () => {
    const service = serviceWith(fakeArr(prowlarrApiRoutes(), KEY), () => null);
    const plan = await service.plan(api('prowlarr'));
    expect(plan.areas.find((a) => a.area === 'indexers')).toMatchObject({ details: { definitions: 0, proxied: 2 } });
  });
});
