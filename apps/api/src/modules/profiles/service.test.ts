import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUALITIES, QUALITY_GROUP_ID_BASE, qualityById, qualityDomain, type QualityProfileInput } from '@arclight/shared';
import { buildItems } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import { albumTypeProfiles, artists, authors, series } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { ProfileError, ProfilesService } from './service.js';
import { profilesRoutes } from './routes.js';

// The aggregate schema: seeding also writes music's album-type profiles, and domain checks
// count series/movies/artists.
const createProfilesTestDb = (): Promise<Db> => createTestDb();

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

  beforeEach(async () => {
    db = await createProfilesTestDb();
    inUse = new Set();
    service = new ProfilesService({ db, isQualityProfileInUse: (id) => inUse.has(id) });
  });

  describe('seeding', () => {
    it('seeds defaults into empty tables once', () => {
      const first = service.seedDefaults();
      expect(first.qualityProfiles).toBeGreaterThanOrEqual(5);
      expect(first.delayProfiles).toBe(1);
      expect(first.qualityDefinitions).toBeGreaterThan(20);
      expect(first.albumTypeProfiles).toBe(2);
      expect(service.seedDefaults()).toEqual({ qualityProfiles: 0, customFormats: 0, delayProfiles: 0, qualityDefinitions: 0, albumTypeProfiles: 0 });
      expect(service.listQualityProfiles().map((p) => p.name)).toContain('HD-1080p');
      expect(service.listDelayProfiles()[0]?.tags).toEqual([]);
    });

    it('does not re-seed profiles the user deleted, but fills in missing quality definitions', async () => {
      service.seedDefaults();
      const any = service.listQualityProfiles().find((p) => p.name === 'Any')!;
      await service.deleteQualityProfile(any.id);
      expect(service.seedDefaults().qualityProfiles).toBe(0);
    });

    it('seeds the music profiles once, with music qualities only', () => {
      service.seedDefaults();
      expect(service.seedMusicDefaults()).toBe(4);
      expect(service.seedMusicDefaults()).toBe(0);
      const music = service.listQualityProfiles('music');
      expect(music.map((p) => p.name)).toEqual(expect.arrayContaining(['Lossless', 'Hi-Res', 'High-quality lossy', 'Any (music)']));
      for (const p of music) {
        expect(p.mediaDomain).toBe('music');
        // Unknown (id 0) heads every profile; everything else is a music quality.
        for (const item of p.items) if (item.kind === 'quality' && item.qualityId !== 0) expect(qualityDomain(qualityById(item.qualityId))).toBe('music');
      }
      // Video profiles are untouched.
      expect(service.listQualityProfiles('video').every((p) => p.mediaDomain === 'video')).toBe(true);
    });

    it('seeds the audiobook profiles once, with audiobook qualities only', () => {
      service.seedDefaults();
      expect(service.seedAudiobookDefaults()).toBe(3);
      expect(service.seedAudiobookDefaults()).toBe(0);
      const books = service.listQualityProfiles('audiobook');
      expect(books.map((p) => p.name)).toEqual(['Standard', 'M4B only', 'Any (audiobook)']);
      for (const p of books) {
        expect(p.mediaDomain).toBe('audiobook');
        expect(p.cutoff).toBe(QUALITIES['AB-AAC'].id);
        for (const item of p.items) if (item.kind === 'quality' && item.qualityId !== 0) expect(qualityDomain(qualityById(item.qualityId))).toBe('audiobook');
      }
      const allowed = (name: string) =>
        books.find((p) => p.name === name)!.items.filter((i) => i.kind === 'quality' && i.allowed).map((i) => (i.kind === 'quality' ? i.qualityId : 0));
      expect(allowed('Standard').sort()).toEqual([QUALITIES['AB-MP3'].id, QUALITIES['AB-MP3-High'].id, QUALITIES['AB-AAC'].id].sort());
      expect(allowed('M4B only').sort()).toEqual([QUALITIES['AB-AAC-Low'].id, QUALITIES['AB-AAC'].id].sort());
      // Music and video profiles are untouched; music seeding still works independently.
      expect(service.listQualityProfiles('music')).toEqual([]);
      expect(service.seedMusicDefaults()).toBe(4);
    });

    it('seeds the audiobook quality definitions with the default MB/min bands', () => {
      service.seedDefaults();
      const defs = service.listQualityDefinitions('audiobook');
      expect(defs.map((d) => d.qualityId).sort((a, b) => a - b)).toEqual([201, 202, 203, 210, 211, 212, 220]);
      expect(defs.find((d) => d.qualityId === QUALITIES['AB-AAC'].id)).toMatchObject({ minSize: 0.25, maxSize: 1.5 });
      for (const d of defs) expect(d.minSize).not.toBeNull();
    });

    it('rejects an audiobook profile for artists and a music profile for authors, and counts authors as users', async () => {
      service.seedDefaults();
      service.seedMusicDefaults();
      service.seedAudiobookDefaults();
      const book = service.listQualityProfiles('audiobook')[0]!;
      const music = service.listQualityProfiles('music')[0]!;
      expect(service.domainMismatch(book.id, 'audiobook')).toBeNull();
      expect(service.domainMismatch(music.id, 'audiobook')).toMatch(/authors need an audiobook profile/);
      expect(service.domainMismatch(book.id, 'music')).toMatch(/artists need a music profile/);
      db.insert(authors)
        .values({
          name: 'A',
          sortName: 'A',
          cleanName: 'a',
          images: [],
          genres: [],
          aliases: [],
          path: '/books/A',
          rootFolderPath: '/books',
          qualityProfileId: book.id,
          languages: [],
          tags: [],
          added: '2026-01-01T00:00:00.000Z',
        })
        .run();
      expect(code(() => service.updateQualityProfile(book.id, { ...book, mediaDomain: 'music' }))).toBe('IN_USE');
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

describe('media domains', () => {
  let db: Db;
  let service: ProfilesService;
  const flacInput = (over: Partial<QualityProfileInput> = {}): QualityProfileInput => ({
    ...hd1080Input({ name: 'Lossless', cutoff: QUALITIES.FLAC.id, items: buildItems(['FLAC', 'FLAC-24bit'], 'music') }),
    mediaDomain: 'music',
    ...over,
  });

  beforeEach(async () => {
    db = await createProfilesTestDb();
    service = new ProfilesService({ db });
    service.seedDefaults();
  });

  it('seeds the album-type profiles with "Studio albums" as the default', () => {
    const rows = db.select().from(albumTypeProfiles).all();
    expect(rows.map((r) => r.name)).toEqual(['Studio albums', 'Everything']);
    expect(rows.find((r) => r.isDefault)).toMatchObject({ name: 'Studio albums', primaryTypes: ['Album', 'EP'], secondaryTypes: [], releaseStatuses: ['Official'] });
  });

  it('defaults new and seeded profiles to video, and filters by domain', () => {
    expect(service.listQualityProfiles().every((p) => p.mediaDomain === 'video')).toBe(true);
    const video = service.createQualityProfile(hd1080Input());
    expect(video.mediaDomain).toBe('video');
    const music = service.createQualityProfile(flacInput());
    expect(music.mediaDomain).toBe('music');
    expect(service.listQualityProfiles('music').map((p) => p.id)).toEqual([music.id]);
    expect(service.listQualityProfiles('video').map((p) => p.id)).not.toContain(music.id);
  });

  it('refuses qualities of another domain', () => {
    expect(code(() => service.createQualityProfile(flacInput({ mediaDomain: undefined })))).toBe('VALIDATION');
    expect(code(() => service.createQualityProfile(hd1080Input({ mediaDomain: 'music' })))).toBe('VALIDATION');
  });

  it('keeps the stored domain on update and refuses a change while in use', () => {
    const music = service.createQualityProfile(flacInput());
    const { mediaDomain: _omit, ...withoutDomain } = flacInput({ name: 'Lossless 2' });
    expect(service.updateQualityProfile(music.id, withoutDomain).mediaDomain).toBe('music');

    const video = service.createQualityProfile(hd1080Input());
    db.insert(series)
      .values({
        tmdbId: 1, title: 'S', sortTitle: 's', cleanTitle: 's', year: 2020, status: 'continuing', genres: [], images: [], ratings: {},
        originalLanguage: 'en', path: '/tv/S', rootFolderPath: '/tv', qualityProfileId: video.id, tags: [], added: '2026-01-01T00:00:00Z',
      })
      .run();
    expect(code(() => service.updateQualityProfile(video.id, flacInput({ name: video.name })))).toBe('IN_USE');
    expect(db.select().from(artists).all()).toEqual([]);
  });

  it('answers cross-domain assignment questions', () => {
    const music = service.createQualityProfile(flacInput());
    const video = service.listQualityProfiles('video')[0]!;
    expect(service.domainMismatch(video.id, 'video')).toBeNull();
    expect(service.domainMismatch(music.id, 'music')).toBeNull();
    expect(service.domainMismatch(music.id, 'video')).toMatch(/music profile/);
    expect(service.domainMismatch(9999, 'video')).toBeNull();
  });

  it('serves video templates and definitions exactly as before, audio ones on request', () => {
    const template = service.qualityProfileTemplate();
    expect(template).not.toHaveProperty('mediaDomain');
    expect(template.items).toEqual(buildItems([]));
    expect(service.qualityProfileTemplate('music')).toMatchObject({ mediaDomain: 'music' });

    const video = service.listQualityDefinitions();
    expect(video.every((d) => d.qualityId < 100 && d.audio === undefined)).toBe(true);
    const music = service.listQualityDefinitions('music');
    expect(music.length).toBeGreaterThan(10);
    expect(music.every((d) => d.qualityId >= 100 && d.qualityId < 200 && d.audio !== undefined)).toBe(true);
    expect(service.updateQualityDefinition(QUALITIES.FLAC.id, { minSize: 3.5, maxSize: 12, preferredSize: null })).toMatchObject({ qualityId: 131, minSize: 3.5 });
  });
});

describe('profiles routes', () => {
  it('registers under a prefix and maps service errors to HTTP', async () => {
    const service = new ProfilesService({ db: await createProfilesTestDb() });
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
