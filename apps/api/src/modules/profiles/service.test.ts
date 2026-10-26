import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUALITIES, QUALITY_GROUP_ID_BASE, type QualityProfileInput } from '@arclight/shared';
import { buildItems } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import * as schema from './schema.js';
import { ProfileError, ProfilesService } from './service.js';
import { profilesRoutes } from './routes.js';

// Local in-memory database with this module's tables. The shared createTestDb() helper is
// being added by another module in parallel; this stays self-contained on purpose.
function createProfilesTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE quality_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      upgrade_allowed INTEGER NOT NULL DEFAULT 1,
      cutoff INTEGER NOT NULL,
      items TEXT NOT NULL,
      min_format_score INTEGER NOT NULL DEFAULT 0,
      cutoff_format_score INTEGER NOT NULL DEFAULT 0,
      min_upgrade_format_score INTEGER NOT NULL DEFAULT 1,
      format_items TEXT NOT NULL,
      languages TEXT NOT NULL
    );
    CREATE TABLE custom_formats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      include_when_renaming INTEGER NOT NULL DEFAULT 0,
      specifications TEXT NOT NULL,
      guide_id TEXT
    );
    CREATE TABLE delay_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "order" INTEGER NOT NULL,
      tags TEXT NOT NULL,
      preferred_protocol TEXT NOT NULL DEFAULT 'usenet',
      usenet_delay_minutes INTEGER NOT NULL DEFAULT 0,
      torrent_delay_minutes INTEGER NOT NULL DEFAULT 0,
      bypass_if_highest_quality INTEGER NOT NULL DEFAULT 0,
      bypass_if_above_custom_format_score INTEGER NOT NULL DEFAULT 0,
      minimum_custom_format_score INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX delay_profiles_order_idx ON delay_profiles("order");
    CREATE TABLE release_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      required TEXT NOT NULL,
      ignored TEXT NOT NULL,
      indexer_id INTEGER,
      tags TEXT NOT NULL
    );
    CREATE TABLE quality_definitions (
      quality_id INTEGER PRIMARY KEY,
      min_size REAL,
      max_size REAL,
      preferred_size REAL
    );
  `);
  // The real Db is built over the aggregate schema; this module only touches its own tables,
  // so a Db typed over the aggregate but opened with the module schema is interchangeable here.
  return drizzle(sqlite, { schema }) as unknown as Db;
}

const hd1080Input = (over: Partial<QualityProfileInput> = {}): QualityProfileInput => ({
  name: 'Test 1080p',
  upgradeAllowed: true,
  cutoff: QUALITIES['Bluray-1080p'].id,
  items: buildItems(['HDTV-1080p', 'WEBDL-1080p', 'WEBRip-1080p', 'Bluray-1080p']),
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
  ...over,
});

const code = (fn: () => unknown) => {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => undefined, (e: unknown) => (e as ProfileError).code);
    return undefined;
  } catch (e) {
    return (e as ProfileError).code;
  }
};

describe('ProfilesService', () => {
  let db: Db;
  let service: ProfilesService;
  let inUse: Set<number>;

  beforeEach(() => {
    db = createProfilesTestDb();
    inUse = new Set();
    service = new ProfilesService({ db, isQualityProfileInUse: (id) => inUse.has(id) });
  });

  describe('seeding', () => {
    it('seeds defaults into empty tables once', () => {
      const first = service.seedDefaults();
      expect(first.qualityProfiles).toBeGreaterThanOrEqual(5);
      expect(first.delayProfiles).toBe(1);
      expect(first.qualityDefinitions).toBeGreaterThan(20);
      expect(service.seedDefaults()).toEqual({ qualityProfiles: 0, customFormats: 0, delayProfiles: 0, qualityDefinitions: 0 });
      expect(service.listQualityProfiles().map((p) => p.name)).toContain('HD-1080p');
      expect(service.listDelayProfiles()[0]?.tags).toEqual([]);
    });

    it('does not re-seed profiles the user deleted, but fills in missing quality definitions', async () => {
      service.seedDefaults();
      const any = service.listQualityProfiles().find((p) => p.name === 'Any')!;
      await service.deleteQualityProfile(any.id);
      expect(service.seedDefaults().qualityProfiles).toBe(0);
    });
  });

  describe('quality profiles', () => {
    it('creates, reads, updates and deletes', async () => {
      const created = service.createQualityProfile(hd1080Input());
      expect(created.id).toBeGreaterThan(0);
      expect(service.getQualityProfile(created.id).items.length).toBeGreaterThan(10);

      const updated = service.updateQualityProfile(created.id, hd1080Input({ name: 'Renamed', cutoff: QUALITIES['HDTV-1080p'].id }));
      expect(updated.name).toBe('Renamed');
      expect(updated.cutoff).toBe(QUALITIES['HDTV-1080p'].id);
      // A grouped quality is referenced through its group id, never its own id.
      expect(code(() => service.updateQualityProfile(created.id, hd1080Input({ cutoff: QUALITIES['WEBDL-1080p'].id })))).toBe('VALIDATION');

      await service.deleteQualityProfile(created.id);
      expect(code(() => service.getQualityProfile(created.id))).toBe('NOT_FOUND');
    });

    it('rejects a cutoff that is not an allowed item', () => {
      expect(code(() => service.createQualityProfile(hd1080Input({ cutoff: QUALITIES['HDTV-720p'].id })))).toBe('VALIDATION');
      expect(code(() => service.createQualityProfile(hd1080Input({ cutoff: 4242 })))).toBe('VALIDATION');
    });

    it('accepts a group id as cutoff', () => {
      const p = service.createQualityProfile(hd1080Input({ cutoff: QUALITY_GROUP_ID_BASE + 3 }));
      expect(p.cutoff).toBe(QUALITY_GROUP_ID_BASE + 3);
    });

    it('rejects scoring an unknown custom format', () => {
      expect(code(() => service.createQualityProfile(hd1080Input({ formatItems: [{ formatId: 99, score: 10 }] })))).toBe('VALIDATION');
    });

    it('rejects duplicate names', () => {
      service.createQualityProfile(hd1080Input());
      expect(code(() => service.createQualityProfile(hd1080Input()))).toBe('CONFLICT');
    });

    it('refuses to delete a profile in use', async () => {
      const p = service.createQualityProfile(hd1080Input());
      inUse.add(p.id);
      expect(await code(() => service.deleteQualityProfile(p.id))).toBe('IN_USE');
      inUse.delete(p.id);
      await service.deleteQualityProfile(p.id);
      expect(service.listQualityProfiles()).toEqual([]);
    });

    it('serves a template listing every quality with nothing allowed', () => {
      const t = service.qualityProfileTemplate();
      expect(t.items.every((i) => !i.allowed)).toBe(true);
      const ids = t.items.flatMap((i) => (i.kind === 'quality' ? [i.qualityId] : i.qualityIds));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(QUALITIES['Remux-2160p'].id);
    });
  });

  describe('custom formats', () => {
    it('creates with specs and rejects invalid regex', () => {
      const cf = service.createCustomFormat({
        name: 'x265',
        includeWhenRenaming: true,
        specifications: [{ implementation: 'releaseTitle', name: 'x265', negate: false, required: false, fields: { pattern: 'x265|hevc' } }],
      });
      expect(cf.id).toBeGreaterThan(0);
      expect(service.getCustomFormat(cf.id).specifications[0]?.implementation).toBe('releaseTitle');
      expect(
        code(() =>
          service.createCustomFormat({
            name: 'bad',
            includeWhenRenaming: false,
            specifications: [{ implementation: 'releaseTitle', name: 'bad', negate: false, required: false, fields: { pattern: '[' } }],
          }),
        ),
      ).toBe('VALIDATION');
    });

    it('deleting a format drops it from profile scores', async () => {
      const cf = service.createCustomFormat({ name: 'cf', includeWhenRenaming: false, specifications: [] });
      const p = service.createQualityProfile(hd1080Input({ formatItems: [{ formatId: cf.id, score: 100 }] }));
      await service.deleteCustomFormat(cf.id);
      expect(service.getQualityProfile(p.id).formatItems).toEqual([]);
      expect(code(() => service.getCustomFormat(cf.id))).toBe('NOT_FOUND');
    });

    it('tests a title against all formats and scores it per profile', () => {
      const cf = service.createCustomFormat({
        name: 'HDR',
        includeWhenRenaming: false,
        specifications: [{ implementation: 'releaseTitle', name: 'hdr', negate: false, required: false, fields: { pattern: '\\bHDR\\b' } }],
      });
      const p = service.createQualityProfile(hd1080Input({ formatItems: [{ formatId: cf.id, score: 75 }] }));
      const hit = service.testCustomFormats({ title: 'Movie.2020.2160p.WEB-DL.HDR.x265', mediaType: 'movie', languages: [], qualityId: 0 });
      expect(hit.matchedFormats.map((f) => f.id)).toEqual([cf.id]);
      expect(hit.scores).toEqual([{ profileId: p.id, profileName: p.name, score: 75 }]);
      const miss = service.testCustomFormats({ title: 'Movie.2020.1080p.BluRay.x264', mediaType: 'movie', languages: [], qualityId: 0 });
      expect(miss.matchedFormats).toEqual([]);
      expect(miss.scores[0]?.score).toBe(0);
    });
  });

  describe('delay profiles', () => {
    beforeEach(() => service.seedDefaults());

    it('keeps the default last and orders tagged profiles densely', () => {
      const a = service.createDelayProfile({ tags: [1], preferredProtocol: 'torrent', usenetDelayMinutes: 0, torrentDelayMinutes: 30, bypassIfHighestQuality: false, bypassIfAboveCustomFormatScore: false, minimumCustomFormatScore: 0 });
      const b = service.createDelayProfile({ tags: [2], preferredProtocol: 'usenet', usenetDelayMinutes: 10, torrentDelayMinutes: 0, bypassIfHighestQuality: true, bypassIfAboveCustomFormatScore: false, minimumCustomFormatScore: 0 });
      const list = service.listDelayProfiles();
      expect(list.map((p) => p.order)).toEqual([1, 2, 3]);
      expect(list[2]?.tags).toEqual([]);
      expect(list.map((p) => p.id).slice(0, 2)).toEqual([a.id, b.id]);

      const reordered = service.reorderDelayProfile(b.id);
      expect(reordered.map((p) => p.id)).toEqual([b.id, a.id, list[2]!.id]);

      service.deleteDelayProfile(a.id);
      expect(service.listDelayProfiles().map((p) => p.order)).toEqual([1, 2]);
    });

    it('protects the single default profile', () => {
      const def = service.listDelayProfiles()[0]!;
      expect(code(() => service.deleteDelayProfile(def.id))).toBe('VALIDATION');
      expect(code(() => service.createDelayProfile({ tags: [], preferredProtocol: 'usenet', usenetDelayMinutes: 0, torrentDelayMinutes: 0, bypassIfHighestQuality: false, bypassIfAboveCustomFormatScore: false, minimumCustomFormatScore: 0 }))).toBe('VALIDATION');
      expect(code(() => service.updateDelayProfile(def.id, { ...def, tags: [9] }))).toBe('VALIDATION');
      const updated = service.updateDelayProfile(def.id, { ...def, usenetDelayMinutes: 15 });
      expect(updated.usenetDelayMinutes).toBe(15);
    });
  });

  describe('release profiles', () => {
    it('round-trips indexerId and validates terms', () => {
      const rp = service.createReleaseProfile({ name: 'no x265', enabled: true, required: [], ignored: ['x265', '/hevc/'], tags: [3] });
      expect(rp.indexerId).toBeUndefined();
      const withIndexer = service.updateReleaseProfile(rp.id, { ...rp, indexerId: 4 });
      expect(withIndexer.indexerId).toBe(4);
      expect(service.listReleaseProfiles()).toHaveLength(1);
      expect(code(() => service.createReleaseProfile({ name: 'empty', enabled: true, required: [], ignored: [], tags: [] }))).toBe('VALIDATION');
      expect(code(() => service.createReleaseProfile({ name: 'bad', enabled: true, required: ['/(/'], ignored: [], tags: [] }))).toBe('VALIDATION');
      service.deleteReleaseProfile(rp.id);
      expect(code(() => service.getReleaseProfile(rp.id))).toBe('NOT_FOUND');
    });
  });

  describe('quality definitions', () => {
    it('lists the vocabulary with limits and stores size limits', () => {
      const all = service.listQualityDefinitions();
      expect(all.find((d) => d.qualityId === QUALITIES['Bluray-1080p'].id)).toMatchObject({ title: 'Bluray-1080p', minSize: null, maxSize: null });
      const updated = service.updateQualityDefinition(QUALITIES['Bluray-1080p'].id, { minSize: 10, maxSize: 200, preferredSize: 95 });
      expect(updated).toMatchObject({ minSize: 10, maxSize: 200, preferredSize: 95 });
      expect(code(() => service.updateQualityDefinition(QUALITIES['Bluray-1080p'].id, { minSize: 50, maxSize: 20, preferredSize: null }))).toBe('VALIDATION');
      expect(code(() => service.updateQualityDefinition(777, { minSize: null, maxSize: null, preferredSize: null }))).toBe('NOT_FOUND');
    });
  });
});

describe('profiles routes', () => {
  it('registers under a prefix and maps service errors to HTTP', async () => {
    const service = new ProfilesService({ db: createProfilesTestDb() });
    service.seedDefaults();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(profilesRoutes(service), { prefix: '/api/v1' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/qualityprofile' });
    expect(list.statusCode).toBe(200);
    expect(list.json<unknown[]>().length).toBeGreaterThanOrEqual(5);

    const schemaRes = await app.inject({ method: 'GET', url: '/api/v1/customformat/schema' });
    expect(schemaRes.json<{ implementation: string }[]>().map((d) => d.implementation)).toContain('releaseTitle');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/qualityprofile/9999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });

    const bad = await app.inject({ method: 'POST', url: '/api/v1/qualityprofile', payload: hd1080Input({ cutoff: 4242 }) });
    expect(bad.statusCode).toBe(400);

    const created = await app.inject({ method: 'POST', url: '/api/v1/qualityprofile', payload: hd1080Input() });
    expect(created.statusCode).toBe(201);

    const test = await app.inject({ method: 'POST', url: '/api/v1/customformat/test', payload: { title: 'A.Movie.2020.1080p' } });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ matchedFormats: [] });

    const defs = await app.inject({ method: 'GET', url: '/api/v1/qualitydefinition' });
    expect(defs.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/qualityprofile/${created.json<{ id: number }>().id}` });
    expect(del.statusCode).toBe(204);
    await app.close();
  });
});
