import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { QUALITIES } from '@arclight/shared';
import { HistoryService } from '../history/service.js';
import { Scheduler } from '../../scheduler.js';
import { EventBus } from '../../events.js';
import { BATCHES_PER_ITEM } from './decision-log.js';
import type { GrabHistoryInput } from './deps.js';
import { DECISION_LOG_CLEANUP_JOB, registerReleaseJobs } from './jobs.js';
import { releasesRoutes } from './routes.js';
import { releaseDecisions } from './schema.js';
import { harness, makeRelease } from './test-support.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function tvSetup(opts: Parameters<typeof harness>[0] = {}) {
  const h = await harness(opts);
  const series = h.addSeries({ title: 'Show Name', tvdbId: 4242 });
  const eps = [1, 2, 3].map((n) => h.addEpisode(series.id, 1, n));
  return { ...h, series, eps };
}

async function routesApp(h: Awaited<ReturnType<typeof harness>>) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(releasesRoutes(h.service));
  return app;
}

function rows(h: Awaited<ReturnType<typeof harness>>) {
  return h.db.select().from(releaseDecisions).all();
}

describe('decision log: writing batches', () => {
  it('logs the mapped releases of an RSS batch and skips releases without a library item', async () => {
    const h = await tvSetup();
    await h.service.processReleases(
      [makeRelease('Show.Name.S01E01.1080p.WEB-DL-A'), makeRelease('Unknown.Show.S01E01.1080p.WEB-DL-X')],
      'rss',
    );
    const logged = rows(h);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ source: 'rss', seriesId: h.series.id, episodeIds: [h.eps[0]!.id], title: 'Show.Name.S01E01.1080p.WEB-DL-A' });
    expect(logged[0]!.quality.quality.name).toBe('WEBDL-1080p');
  });

  it('marks the grabbed release chosen and ranks approved releases before rejected ones', async () => {
    const h = await tvSetup({ allowed: ['WEBDL-1080p'] });
    await h.service.processReleases(
      [
        makeRelease('Show.Name.S01E01.720p.HDTV-A'),
        makeRelease('Show.Name.S01E01.1080p.WEB-DL-B', { seeders: 10 }),
        makeRelease('Show.Name.S01E01.1080p.WEB-DL-C', { seeders: 900 }),
      ],
      'rss',
    );
    const logged = rows(h).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    expect(logged.map((r) => r.title)).toEqual([
      'Show.Name.S01E01.1080p.WEB-DL-C',
      'Show.Name.S01E01.1080p.WEB-DL-B',
      'Show.Name.S01E01.720p.HDTV-A',
    ]);
    expect(logged.map((r) => r.chosen)).toEqual([true, false, false]);
    expect(logged[2]!.approved).toBe(false);
    expect(logged[2]!.rejections.length).toBeGreaterThan(0);
    expect(new Set(logged.map((r) => r.batchId)).size).toBe(1);
  });

  it('logs unmatched search results against the searched item', async () => {
    const h = await tvSetup();
    h.indexers.results = [makeRelease('Show.Name.S01E02.1080p.WEB-DL-A'), makeRelease('Other.Thing.S05E05.1080p.WEB-DL-X')];
    await h.service.searchFor({ seriesId: h.series.id, episodeIds: [h.eps[1]!.id] }, { userInvoked: true });
    const logged = rows(h);
    expect(logged).toHaveLength(2);
    expect(logged.every((r) => r.source === 'search' && r.seriesId === h.series.id)).toBe(true);
    const other = logged.find((r) => r.title.startsWith('Other'))!;
    expect(other.rejections[0]!.reason).toBe('unknownSeries');
    expect(other.rank).toBeNull();
    expect(other.episodeIds).toEqual([h.eps[1]!.id]);
  });

  it('logs interactive searches with nothing chosen and the best approved release as winner', async () => {
    const h = await tvSetup();
    h.indexers.results = [makeRelease('Show.Name.S01E01.720p.HDTV-A'), makeRelease('Show.Name.S01E01.1080p.WEB-DL-B')];
    await h.service.interactiveSearch({ episodeId: h.eps[0]!.id });
    const page = h.service.listDecisionBatches({ episodeId: h.eps[0]!.id, page: 1, pageSize: 10 });
    expect(page.records).toHaveLength(1);
    const batch = page.records[0]!;
    expect(batch).toMatchObject({ source: 'interactive', grabbed: false, total: 2 });
    expect(batch.decisions.find((d) => d.id === batch.winnerId)!.title).toBe('Show.Name.S01E01.1080p.WEB-DL-B');
  });

  it('logs an interactive grab and passes its batch id to the history hook', async () => {
    const grabs: GrabHistoryInput[] = [];
    const h = await tvSetup({ deps: { history: { recordGrab: (g) => void grabs.push(g) } } });
    h.indexers.results = [makeRelease('Show.Name.S01E01.1080p.WEB-DL-B')];
    await h.service.interactiveSearch({ episodeId: h.eps[0]!.id });
    await h.service.grab({ guid: 'Show.Name.S01E01.1080p.WEB-DL-B', indexerId: 1 });
    expect(grabs).toHaveLength(1);
    const batch = h.service.getDecisionBatch(grabs[0]!.batchId!);
    expect(batch).toMatchObject({ source: 'interactive', grabbed: true });
    expect(batch.decisions[0]!.chosen).toBe(true);
  });

  it('attaches the batch id to RSS grabs recorded in history', async () => {
    const grabs: GrabHistoryInput[] = [];
    const h = await tvSetup({ deps: { history: { recordGrab: (g) => void grabs.push(g) } } });
    await h.service.processReleases([makeRelease('Show.Name.S01E03.1080p.WEB-DL-A')], 'rss');
    expect(grabs[0]!.batchId).toBe(rows(h)[0]!.batchId);
  });

  it('logs pushed releases as push and re-decided pending releases as pending', async () => {
    const h = await tvSetup();
    const dp = h.profiles.listDelayProfiles()[0]!;
    h.profiles.updateDelayProfile(dp.id, {
      tags: [],
      preferredProtocol: 'usenet',
      usenetDelayMinutes: 0,
      torrentDelayMinutes: 60,
      bypassIfHighestQuality: false,
      bypassIfAboveCustomFormatScore: false,
      minimumCustomFormatScore: 0,
    });
    await h.service.push({
      title: 'Show.Name.S01E02.1080p.WEB-DL-P',
      downloadUrl: 'http://indexer.test/dl/p',
      protocol: 'torrent',
      publishDate: h.now().toISOString(),
      size: 1_500_000_000,
    });
    h.advance(61 * MINUTE);
    await h.service.processPending();
    const sources = rows(h).map((r) => [r.source, r.chosen]);
    expect(sources).toEqual([
      ['push', false],
      ['pending', true],
    ]);
  });

  it('keeps the last 20 batches per item without touching other items', async () => {
    const h = await tvSetup();
    const other = h.addSeries({ title: 'Other Show' });
    h.addEpisode(other.id, 1, 1);
    await h.service.processReleases([makeRelease('Other.Show.S01E01.720p.HDTV-Z')], 'rss');
    for (let i = 0; i < BATCHES_PER_ITEM + 2; i++) {
      h.advance(MINUTE);
      // A permanently rejected release: logged every time, never grabbed.
      await h.service.processReleases([makeRelease(`Show.Name.S01E01.480p.SDTV-${i}`)], 'rss');
    }
    const page = h.service.listDecisionBatches({ seriesId: h.series.id, page: 1, pageSize: 100 });
    expect(page.totalRecords).toBe(BATCHES_PER_ITEM);
    expect(page.records[0]!.decisions[0]!.title).toBe(`Show.Name.S01E01.480p.SDTV-${BATCHES_PER_ITEM + 1}`);
    expect(h.service.listDecisionBatches({ seriesId: other.id, page: 1, pageSize: 10 }).totalRecords).toBe(1);
  });
});

describe('decision log: reading', () => {
  it('lists batches newest first and pages them', async () => {
    const h = await tvSetup();
    for (const q of ['480p.SDTV', '720p.HDTV', '1080p.WEB-DL']) {
      h.advance(MINUTE);
      await h.service.processReleases([makeRelease(`Show.Name.S01E01.${q}-G`)], 'rss');
    }
    const page1 = h.service.listDecisionBatches({ seriesId: h.series.id, page: 1, pageSize: 2 });
    expect(page1.totalRecords).toBe(3);
    expect(page1.records.map((b) => b.decisions[0]!.title)).toEqual(['Show.Name.S01E01.1080p.WEB-DL-G', 'Show.Name.S01E01.720p.HDTV-G']);
    const page2 = h.service.listDecisionBatches({ seriesId: h.series.id, page: 2, pageSize: 2 });
    expect(page2.records.map((b) => b.decisions[0]!.title)).toEqual(['Show.Name.S01E01.480p.SDTV-G']);
  });

  it('filters per episode and per movie', async () => {
    const h = await tvSetup();
    const movie = h.addMovie({ title: 'The Movie', year: 2020 });
    await h.service.processReleases(
      [makeRelease('Show.Name.S01E01.1080p.WEB-DL-A'), makeRelease('Show.Name.S01E02.1080p.WEB-DL-B'), makeRelease('The.Movie.2020.1080p.BluRay.x264-M')],
      'rss',
    );
    const ep2 = h.service.listDecisionBatches({ episodeId: h.eps[1]!.id, page: 1, pageSize: 10 });
    expect(ep2.records[0]!.decisions.map((d) => d.title)).toEqual(['Show.Name.S01E02.1080p.WEB-DL-B']);
    const movies = h.service.listDecisionBatches({ movieId: movie.id, page: 1, pageSize: 10 });
    expect(movies.records[0]!.decisions.map((d) => d.title)).toEqual(['The.Movie.2020.1080p.BluRay.x264-M']);
    expect(movies.records[0]!.decisions[0]!.mediaType).toBe('movie');
  });

  it('serves GET /release/decisions and /release/decisions/:batchId', async () => {
    const h = await tvSetup();
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-A'), makeRelease('Show.Name.S01E02.1080p.WEB-DL-B')], 'rss');
    const app = await routesApp(h);
    const list = await app.inject({ method: 'GET', url: `/release/decisions?episodeId=${h.eps[0]!.id}` });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.records[0].decisions).toHaveLength(1);
    expect(body.records[0].winnerId).toBe(body.records[0].decisions[0].id);
    const one = await app.inject({ method: 'GET', url: `/release/decisions/${body.records[0].batchId}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().decisions).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/release/decisions/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/release/decisions' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/release/decisions?seriesId=1&movieId=2` })).statusCode).toBe(400);
  });
});

describe('decision log: retention and history', () => {
  it('prunes rows older than the configured days', async () => {
    const h = await tvSetup();
    await h.service.processReleases([makeRelease('Show.Name.S01E01.480p.SDTV-OLD')], 'rss');
    h.advance(10 * DAY);
    await h.service.processReleases([makeRelease('Show.Name.S01E01.480p.SDTV-NEW')], 'rss');
    h.advance(5 * DAY);
    expect(h.service.cleanupDecisionLog(14)).toContain('removed 1 row');
    expect(rows(h).map((r) => r.title)).toEqual(['Show.Name.S01E01.480p.SDTV-NEW']);
  });

  it('registers DecisionLogCleanup with the days from settings', async () => {
    const h = await tvSetup();
    await h.service.processReleases([makeRelease('Show.Name.S01E01.480p.SDTV-OLD')], 'rss');
    h.advance(3 * DAY);
    const scheduler = new Scheduler(h.db, new EventBus(), pino({ level: 'silent' }));
    registerReleaseJobs(scheduler, h.service, { decisionLogDays: () => 2 });
    expect(scheduler.has(DECISION_LOG_CLEANUP_JOB)).toBe(true);
    const job = await scheduler.run(DECISION_LOG_CLEANUP_JOB, 'manual');
    expect(job.message).toContain('removed 1 row');
    expect(rows(h)).toHaveLength(0);
  });

  it('stores the batch id in the grabbed history record data', async () => {
    const h = await tvSetup();
    const movie = h.addMovie({ title: 'Some Movie' });
    const history = new HistoryService({ db: h.db, log: pino({ level: 'silent' }) });
    const [record] = history.recordGrab(
      { title: 'Some.Movie.2020.1080p.BluRay-G', protocol: 'torrent', indexerId: 1, indexerName: 'Tracker', size: 1 },
      {
        target: { mediaType: 'movie', movieId: movie.id },
        quality: { quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
        languages: [],
        decisionBatchId: 'batch-123',
      },
      'hash',
      'qBit',
    );
    expect(record!.data.decisionBatchId).toBe('batch-123');
  });
});
