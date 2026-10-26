import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE_MAPPING_FEED_URL, QUALITIES, SceneMappingInput } from '@arclight/shared';
import { FeedsRegistry } from '../../feeds.js';
import { libraryService } from '../library/index.js';
import { harness, makeRelease } from '../releases/test-support.js';
import { SceneMappingFeed, type FetchLike } from './feed.js';
import { sceneMappingRoutes } from './routes.js';
import { sceneMappings } from './schema.js';
import { SceneMappingError, SceneMappingService } from './service.js';

const quality = { quality: { ...QUALITIES['WEBDL-1080p'], mediaTypes: [...QUALITIES['WEBDL-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

async function setup(opts: { rescan?: boolean } = {}) {
  const h = await harness({ tables: { sceneMappings } });
  const series = h.addSeries({ title: 'Show Name', tvdbId: 4242, tmdbId: 777 });
  const s1 = Array.from({ length: 24 }, (_, i) => h.addEpisode(series.id, 1, i + 1));
  const s2 = Array.from({ length: 12 }, (_, i) => h.addEpisode(series.id, 2, i + 1));
  const rescans: number[] = [];
  const service = new SceneMappingService({
    db: h.db,
    log: pino({ level: 'silent' }),
    ...(opts.rescan ? { rescan: async (id: number) => (rescans.push(id), { scanned: 3, added: [1], unmapped: [] }) } : {}),
  });
  return { ...h, series, s1, s2, sceneService: service, rescans };
}

const input = (v: Parameters<typeof SceneMappingInput.parse>[0]) => SceneMappingInput.parse(v);

function feedFetch(status: number, body: unknown): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as FetchLike & { urls: string[] };
  fn.urls = urls;
  return fn;
}

describe('manual editor', () => {
  it('creates, lists (manual first), updates and deletes manual mappings', async () => {
    const t = await setup();
    t.db.insert(sceneMappings).values({ seriesId: t.series.id, kind: 'season', sceneSeason: 3, tvdbSeason: 2, source: 'feed' }).run();
    const created = t.sceneService.create(t.series.id, input({ kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 13, comment: 'split cour' }));
    expect(created).toMatchObject({ source: 'manual', seriesId: t.series.id, tvdbEpisode: 13, comment: 'split cour' });
    expect(t.sceneService.list(t.series.id).map((m) => m.source)).toEqual(['manual', 'feed']);
    const updated = t.sceneService.update(t.series.id, created.id, input({ kind: 'season', sceneSeason: 2, tvdbSeason: 1, tvdbEpisode: 14 }));
    expect(updated.tvdbEpisode).toBe(14);
    t.sceneService.delete(t.series.id, created.id);
    expect(t.sceneService.list(t.series.id)).toHaveLength(1);
  });

  it('keeps feed mappings read-only and validates input', async () => {
    const t = await setup();
    const feed = t.db.insert(sceneMappings).values({ seriesId: t.series.id, kind: 'season', sceneSeason: 3, tvdbSeason: 2, source: 'feed' }).returning().get();
    expect(() => t.sceneService.delete(t.series.id, feed.id)).toThrow(SceneMappingError);
    expect(() => t.sceneService.update(t.series.id, feed.id, input({ kind: 'season', sceneSeason: 3, tvdbSeason: 1 }))).toThrow(/read-only/);
    expect(SceneMappingInput.safeParse({ kind: 'season', sceneSeason: 2 }).success).toBe(false);
    expect(SceneMappingInput.safeParse({ kind: 'absolute', sceneAbsolute: 25, tvdbSeason: 2 }).success).toBe(false);
    expect(SceneMappingInput.safeParse({ kind: 'title' }).success).toBe(false);
    expect(() => t.sceneService.list(99999)).toThrow();
  });

  it('serves the CRUD and apply routes', async () => {
    const t = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(sceneMappingRoutes(t.sceneService, undefined));
    const base = `/series/${t.series.id}/scenemapping`;
    const post = await app.inject({ method: 'POST', url: base, payload: { kind: 'title', sceneTitle: 'Alias Name' } });
    expect(post.statusCode).toBe(201);
    const id = post.json().id;
    expect((await app.inject({ method: 'GET', url: base })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'PUT', url: `${base}/${id}`, payload: { kind: 'title', sceneTitle: 'Other' } })).json().sceneTitle).toBe('Other');
    expect((await app.inject({ method: 'POST', url: base, payload: { kind: 'season' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/series/9999/scenemapping' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${base}/apply` })).json()).toMatchObject({ checked: 0, unchanged: 0 });
    expect((await app.inject({ method: 'DELETE', url: `${base}/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `${base}/${id}` })).statusCode).toBe(404);
  });
});

describe('release matching against stored mappings', () => {
  it('grabs a scene-numbered release for the mapped library episode', async () => {
    const t = await setup();
    t.sceneService.create(t.series.id, input({ kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 13 }));
    const [decision] = await t.service.processReleases([makeRelease('Show.Name.S02E03.1080p.WEB-DL-GRP')], 'rss');
    expect(decision!.episodeIds).toEqual([t.s1[14]!.id]);
    expect(t.downloads.grabs[0]!.tracking.episodeIds).toEqual([t.s1[14]!.id]);
  });

  it('matches a release through a stored title alias', async () => {
    const t = await setup();
    t.sceneService.create(t.series.id, input({ kind: 'title', sceneTitle: 'Nombre del Show' }));
    const [decision] = await t.service.processReleases([makeRelease('Nombre.del.Show.S01E02.1080p.WEB-DL-GRP')], 'rss');
    expect(decision!.seriesId).toBe(t.series.id);
    expect(decision!.episodeIds).toEqual([t.s1[1]!.id]);
  });
});

describe('community feed', () => {
  const doc = {
    schemaVersion: 1,
    series: [
      {
        tvdbId: 4242,
        title: 'Show Name',
        mappings: [
          { kind: 'season', sceneSeason: 3, tvdbSeason: 2 },
          { kind: 'title', sceneTitle: 'Show Name Alt' },
          { kind: 'season', sceneSeason: 9 }, // invalid: no target
        ],
      },
      { tmdbId: 123456, mappings: [{ kind: 'season', sceneSeason: 1, tvdbSeason: 1 }] }, // not in library
      { title: 'no ids', mappings: [] }, // invalid: no id
    ],
  };

  it('replaces feed rows, keeps manual ones and reports counts', async () => {
    const t = await setup();
    t.sceneService.create(t.series.id, input({ kind: 'season', sceneSeason: 5, tvdbSeason: 1 }));
    t.db.insert(sceneMappings).values({ seriesId: t.series.id, kind: 'season', sceneSeason: 7, tvdbSeason: 1, source: 'feed' }).run();
    const fetch = feedFetch(200, doc);
    const feed = new SceneMappingFeed({ db: t.db, fetch, now: t.now });
    const status = await feed.sync();
    expect(fetch.urls).toEqual([DEFAULT_SCENE_MAPPING_FEED_URL]);
    expect(status).toMatchObject({ feedSeries: 3, matchedSeries: 1, mappings: 2, rejected: 2, notPublished: false, lastError: null });
    const rows = t.sceneService.list(t.series.id);
    expect(rows.map((r) => [r.source, r.kind, r.sceneSeason ?? r.sceneTitle])).toEqual([
      ['manual', 'season', 5],
      ['feed', 'season', 3],
      ['feed', 'title', 'Show Name Alt'],
    ]);
    expect(feed.feedStatus()).toMatchObject({ enabled: true, lastError: null });
    expect(feed.feedStatus().detail).toContain('2 mappings');
  });

  it('matches feed series by tmdbId when tvdbId is absent', async () => {
    const t = await setup();
    const feed = new SceneMappingFeed({ db: t.db, fetch: feedFetch(200, { schemaVersion: 1, series: [{ tmdbId: 777, mappings: [{ kind: 'season', sceneSeason: 3, tvdbSeason: 2 }] }] }) });
    expect((await feed.sync()).matchedSeries).toBe(1);
  });

  it('treats a 404 as "not published" and keeps existing feed rows', async () => {
    const t = await setup();
    t.db.insert(sceneMappings).values({ seriesId: t.series.id, kind: 'season', sceneSeason: 7, tvdbSeason: 1, source: 'feed' }).run();
    const feed = new SceneMappingFeed({ db: t.db, fetch: feedFetch(404, 'Not Found') });
    const status = await feed.sync();
    expect(status).toMatchObject({ notPublished: true, lastError: null, lastSuccessAt: null });
    const registry = new FeedsRegistry();
    registry.register({ id: 'sceneMappings', name: 'Scene numbering mappings', status: () => feed.feedStatus() });
    const [summary] = (await registry.summary()).filter((f) => f.id === 'sceneMappings');
    expect(summary).toMatchObject({ state: 'never', registered: true });
    expect(summary!.detail).toContain('not published');
    expect(t.sceneService.list(t.series.id)).toHaveLength(1);
  });

  it('records HTTP errors, bad JSON and unsupported versions as failures', async () => {
    const t = await setup();
    await expect(new SceneMappingFeed({ db: t.db, fetch: feedFetch(500, 'oops') }).sync()).rejects.toThrow(/HTTP 500/);
    await expect(new SceneMappingFeed({ db: t.db, fetch: feedFetch(200, '{not json') }).sync()).rejects.toThrow(/not JSON/);
    const v2 = new SceneMappingFeed({ db: t.db, fetch: feedFetch(200, { schemaVersion: 2, series: [] }) });
    await expect(v2.sync()).rejects.toThrow(/schemaVersion 2/);
    expect(v2.status().lastError).toMatch(/schemaVersion 2/);
    expect(v2.feedStatus().lastError).toMatch(/schemaVersion 2/);
  });
});

describe('apply to existing files', () => {
  function addFile(t: Awaited<ReturnType<typeof setup>>, name: string, episodeIds: number[], season: number) {
    return libraryService.addMediaFile(t.db, {
      mediaType: 'series',
      seriesId: t.series.id,
      seasonNumber: season,
      episodeIds,
      relativePath: `Season ${season}/${name}.mkv`,
      path: `${t.series.path}/Season ${season}/${name}.mkv`,
      sizeBytes: 100,
      quality,
      languages: ['en'],
      sceneName: name,
    }).file;
  }

  it('re-links files whose scene numbers map elsewhere and runs the rescan', async () => {
    const t = await setup({ rescan: true });
    // Imported before the mapping existed: scene S02E03 was linked to library S02E03.
    const wrong = addFile(t, 'Show.Name.S02E03.1080p.WEB-DL-GRP', [t.s2[2]!.id], 2);
    const right = addFile(t, 'Show.Name.S01E01.1080p.WEB-DL-GRP', [t.s1[0]!.id], 1);
    t.sceneService.create(t.series.id, input({ kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 13 }));
    const result = await t.sceneService.applyToFiles(t.series.id);
    expect(result).toMatchObject({ checked: 2, unchanged: 1, skipped: [], rescan: { scanned: 3, added: 1, unmapped: 0 } });
    expect(result.remapped).toHaveLength(1);
    expect(result.remapped[0]).toMatchObject({ mediaFileId: wrong.id, fromEpisodeIds: [t.s2[2]!.id], toEpisodeIds: [t.s1[14]!.id] });
    const files = libraryService.listMediaFiles(t.db, { seriesId: t.series.id });
    expect(files.find((f) => f.sceneName === 'Show.Name.S02E03.1080p.WEB-DL-GRP')).toMatchObject({ episodeIds: [t.s1[14]!.id], seasonNumber: 1, path: wrong.path });
    expect(files.find((f) => f.id === right.id)!.episodeIds).toEqual([t.s1[0]!.id]);
    const eps = libraryService.listEpisodes(t.db, { seriesId: t.series.id });
    expect(eps.find((e) => e.id === t.s2[2]!.id)!.hasFile).toBe(false);
    expect(eps.find((e) => e.id === t.s1[14]!.id)!.hasFile).toBe(true);
    expect(t.rescans).toEqual([t.series.id]);
  });

  it('skips a file whose mapped episode belongs to another file that stays', async () => {
    const t = await setup();
    addFile(t, 'Show.Name.S02E03.1080p.WEB-DL-GRP', [t.s2[2]!.id], 2);
    addFile(t, 'Show.Name.S01E15.1080p.WEB-DL-OTHER', [t.s1[14]!.id], 1);
    t.sceneService.create(t.series.id, input({ kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 13 }));
    const result = await t.sceneService.applyToFiles(t.series.id);
    expect(result.remapped).toHaveLength(0);
    expect(result.unchanged).toBe(1);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'mapped episodes belong to another file' })]);
    expect(result.rescan).toBeNull();
  });
});
