import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildItems, findItem, itemId } from '@arclight/profiles-engine';
import { QUALITIES, type Job, type QualityName } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { movies } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { insertEpisode, insertFile, insertMovie, insertSeries } from '../notifications/test-support.js';
import { ProfilesService } from '../profiles/index.js';
import { releasesServiceFor, type SearchTarget } from '../releases/index.js';
import { subtitlesServiceFor } from '../subtitles/index.js';
import { BULK_SEARCH_JOB, BULK_SUBTITLE_SEARCH_JOB } from './index.js';

// Full-app tests for the bulk commands. Release and subtitle searches are faked (they record
// what they were asked for), so no indexer or provider is contacted.

const HD: QualityName[] = ['HDTV-720p', 'WEBDL-720p', 'HDTV-1080p', 'WEBDL-1080p', 'Bluray-1080p'];

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

function quality(name: QualityName) {
  return { quality: { ...QUALITIES[name], mediaTypes: [...QUALITIES[name].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}

interface Harness {
  db: Db;
  ctx: AppContext;
  searches: SearchTarget[];
  subtitleSearches: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  api: (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ statusCode: number; json<T = any>(): T }>;
  profiles: ProfilesService;
  profileId: number;
  close: () => Promise<void>;
}

let h: Harness;

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const searches: SearchTarget[] = [];
  const subtitleSearches: number[] = [];
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      releasesServiceFor(ctx).searchFor = async (target) => {
        searches.push(target);
        return { releases: 2, approved: 1, grabbed: [], pending: 0 };
      };
      const subs = subtitlesServiceFor(ctx);
      subs.commandSearch = async (cmd) => {
        subtitleSearches.push(cmd.mediaFileId!);
        return { files: 1, searched: 1, downloaded: 1, message: 'ok' };
      };
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const profiles = new ProfilesService({ db });
  const items = buildItems(HD);
  const profile = profiles.createQualityProfile({
    name: 'Bulk HD',
    upgradeAllowed: true,
    cutoff: itemId(findItem({ items } as never, QUALITIES['WEBDL-1080p'].id)!),
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
  });
  return {
    db,
    ctx,
    searches,
    subtitleSearches,
    profiles,
    profileId: profile.id,
    api: (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    close: () => app.close(),
  };
}

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.close();
});

const settle = () => new Promise((r) => setTimeout(r, 20));

async function finished(name: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const jobs = (await h.api('GET', '/jobs')).json<Job[]>();
    const job = jobs.find((j) => j.name === name);
    if (job && job.status !== 'running') return job;
    await settle();
  }
  throw new Error(`job ${name} did not finish`);
}

function movieWithFile(fileQuality: QualityName, title: string, profileId = h.profileId) {
  const m = insertMovie(h.db, { qualityProfileId: profileId, title, sortTitle: title.toLowerCase(), hasFile: true, status: 'released' });
  const file = insertFile(h.db, { mediaType: 'movie', movieId: m.id, quality: quality(fileQuality), relativePath: `${title}.mkv` });
  h.db.update(movies).set({ movieFileId: file.id }).where(eq(movies.id, m.id)).run();
  return m;
}

function missingMovie(title: string) {
  return insertMovie(h.db, { qualityProfileId: h.profileId, title, sortTitle: title.toLowerCase(), hasFile: false, status: 'released', inCinemas: '2020-01-01', digitalRelease: '2020-02-01' });
}

describe('POST /command/bulksearch', () => {
  it('mode all: queues one job that searches every selected movie and series', async () => {
    const a = missingMovie('Alpha');
    const b = movieWithFile('Bluray-1080p', 'Bravo');
    const s = insertSeries(h.db, { qualityProfileId: h.profileId });
    const res = await h.api('POST', '/command/bulksearch', { movieIds: [a.id, b.id, 999], seriesIds: [s.id] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: 3, skipped: 1, job: { name: BULK_SEARCH_JOB } });
    const job = await finished(BULK_SEARCH_JOB);
    expect(job.status).toBe('completed');
    expect(job.message).toContain('searched 3 of 3');
    expect(h.searches).toEqual(expect.arrayContaining([{ movieId: a.id }, { movieId: b.id }, { seriesId: s.id }]));
    expect(h.searches).toHaveLength(3);
  });

  it('mode upgrade: searches only selected items below their profile cutoff', async () => {
    const low = movieWithFile('HDTV-720p', 'Low');
    const done = movieWithFile('Bluray-1080p', 'Done');
    const missing = missingMovie('Missing');
    const res = await h.api('POST', '/command/bulksearch', { mode: 'upgrade', movieIds: [low.id, done.id, missing.id] });
    expect(res.json()).toMatchObject({ queued: 1, skipped: 2 });
    await finished(BULK_SEARCH_JOB);
    expect(h.searches).toEqual([{ movieId: low.id }]);
  });

  it('mode upgrade: skips items whose profile does not allow upgrades', async () => {
    const { id: _id, ...p } = h.profiles.getQualityProfile(h.profileId);
    const locked = h.profiles.createQualityProfile({ ...p, name: 'Bulk no upgrades', upgradeAllowed: false });
    const m = movieWithFile('HDTV-720p', 'Locked Movie', locked.id);
    const res = await h.api('POST', '/command/bulksearch', { mode: 'upgrade', movieIds: [m.id] });
    expect(res.json()).toEqual({ queued: 0, skipped: 1, job: null });
    expect(h.searches).toEqual([]);
  });

  it('mode missing with allEpisodes: every missing episode, grouped per series and season', async () => {
    const s = insertSeries(h.db, { qualityProfileId: h.profileId });
    const e1 = insertEpisode(h.db, s.id, { episodeNumber: 1, airDateUtc: '2024-01-01T00:00:00Z' });
    const e2 = insertEpisode(h.db, s.id, { episodeNumber: 2, airDateUtc: '2024-01-08T00:00:00Z' });
    const e3 = insertEpisode(h.db, s.id, { seasonNumber: 2, episodeNumber: 1, airDateUtc: '2024-06-01T00:00:00Z' });
    // Not aired yet and unmonitored: not on the missing list.
    insertEpisode(h.db, s.id, { episodeNumber: 3, airDateUtc: '2999-01-01T00:00:00Z' });
    insertEpisode(h.db, s.id, { episodeNumber: 4, airDateUtc: '2024-01-15T00:00:00Z', monitored: false });
    const res = await h.api('POST', '/command/bulksearch', { mode: 'missing', allEpisodes: true });
    expect(res.json()).toMatchObject({ queued: 3, skipped: 0 });
    await finished(BULK_SEARCH_JOB);
    expect(h.searches).toHaveLength(2);
    expect(h.searches).toEqual(
      expect.arrayContaining([
        { seriesId: s.id, episodeIds: expect.arrayContaining([e1.id, e2.id]) },
        { seriesId: s.id, episodeIds: [e3.id] },
      ]),
    );
  });

  it('mode missing with episode ids: narrows the list to the selection', async () => {
    const s = insertSeries(h.db, { qualityProfileId: h.profileId });
    const e1 = insertEpisode(h.db, s.id, { episodeNumber: 1, airDateUtc: '2024-01-01T00:00:00Z' });
    insertEpisode(h.db, s.id, { episodeNumber: 2, airDateUtc: '2024-01-08T00:00:00Z' });
    const res = await h.api('POST', '/command/bulksearch', { mode: 'missing', episodeIds: [e1.id] });
    expect(res.json()).toMatchObject({ queued: 1, skipped: 0 });
    await finished(BULK_SEARCH_JOB);
    expect(h.searches).toEqual([{ seriesId: s.id, episodeIds: [e1.id] }]);
  });

  it('rejects an empty selection and allMovies in mode all', async () => {
    expect((await h.api('POST', '/command/bulksearch', {})).statusCode).toBe(400);
    expect((await h.api('POST', '/command/bulksearch', { mode: 'all', allMovies: true })).statusCode).toBe(400);
    expect((await h.api('POST', '/command/bulksearch', { mode: 'sideways', movieIds: [1] })).statusCode).toBe(400);
  });
});

describe('bulk rename', () => {
  it('previews many items and reports the ones that cannot be previewed', async () => {
    const m = insertMovie(h.db, { title: 'Plain' });
    const res = await h.api('POST', '/rename/bulk', { movieIds: [m.id, 4242] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; failed: Array<{ mediaType: string; id: number }> }>();
    expect(body.items).toEqual([]);
    expect(body.failed).toEqual([expect.objectContaining({ mediaType: 'movie', id: 4242 })]);
  });

  it('executes over many items and keeps going past a missing one', async () => {
    const m = insertMovie(h.db, { title: 'Plain' });
    const res = await h.api('POST', '/command/bulkrename', { movieIds: [4242, m.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ renamed: [], failed: [] });
  });

  it('requires ids', async () => {
    expect((await h.api('POST', '/rename/bulk', {})).statusCode).toBe(400);
  });
});

describe('POST /command/subtitlesearch/bulk', () => {
  it('queues one job over the selected files', async () => {
    const res = await h.api('POST', '/command/subtitlesearch/bulk', { mediaFileIds: [5, 6, 5] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: 2, job: { name: BULK_SUBTITLE_SEARCH_JOB } });
    const job = await finished(BULK_SUBTITLE_SEARCH_JOB);
    expect(job.message).toContain('searched 2 of 2 files: 2 downloaded');
    expect(h.subtitleSearches).toEqual([5, 6]);
  });

  it('answers without a job when the wanted list is empty', async () => {
    const res = await h.api('POST', '/command/subtitlesearch/bulk', { wanted: 'movie' });
    expect(res.json()).toEqual({ queued: 0, skipped: 0, job: null });
  });

  it('requires ids or a wanted list', async () => {
    expect((await h.api('POST', '/command/subtitlesearch/bulk', {})).statusCode).toBe(400);
  });
});
