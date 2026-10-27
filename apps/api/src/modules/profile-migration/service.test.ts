import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import pino from 'pino';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { MovieListQuery, QualityProfileInput, type MediaVersion, type QualityName } from '@arclight/shared';
import * as schema from '../../db/schema.js';
import { libraryService } from '../library/index.js';
import { getSection, setSection } from '../settings/service.js';
import { GB, harness, makeProfile, makeRelease, quality } from '../releases/test-support.js';
import { profileMigrationRoutes } from './routes.js';
import * as tables from './schema.js';
import { upcomingRuns } from '../releases/search-status.js';
import { cronForInterval, ProfileMigrationService, replacementState } from './service.js';

const UHD_ALLOWED: QualityName[] = ['WEBDL-1080p', 'Bluray-1080p', 'WEBDL-2160p', 'Bluray-2160p'];

async function setup(opts: { free?: number | null } = {}) {
  const h = await harness({ tables });
  const hd = h.profile; // HDTV-720p .. Bluray-1080p allowed, cutoff WEBDL-1080p
  const { id: _id, ...uhdDraft } = makeProfile(UHD_ALLOWED, {}, 'Bluray-2160p');
  const uhd = h.profiles.createQualityProfile(QualityProfileInput.parse({ ...uhdDraft, name: 'Ultra HD' }));
  const grabbedMovies = new Set<number>();
  const grabbedEpisodes = new Set<number>();
  const migration = new ProfileMigrationService({
    db: h.db,
    log: pino({ level: 'silent' }),
    now: h.now,
    debounceMs: 1,
    ports: {
      search: async (target, o) => {
        const summary = await h.service.searchFor(target, o);
        for (const g of h.downloads.grabs) {
          if (g.tracking.movieId !== undefined) grabbedMovies.add(g.tracking.movieId);
          for (const id of g.tracking.episodeIds ?? []) grabbedEpisodes.add(id);
        }
        return summary;
      },
      activeDownloads: () => ({ movieIds: new Set(grabbedMovies), episodeIds: new Set(grabbedEpisodes) }),
      freeSpace: async () => (opts.free === undefined ? null : opts.free),
    },
  });
  // The decision engine asks the migration for each profile's rule (wiring.ts does this in the app).
  (h.service as unknown as { deps: Record<string, unknown> }).deps['profileMigration'] = migration;

  function movieWithFile(title: string, q: QualityName, values: Partial<typeof schema.movies.$inferInsert> = {}) {
    const movie = h.addMovie({ title, year: 2024, ...values });
    const { file } = libraryService.addMediaFile(h.db, {
      mediaType: 'movie',
      movieId: movie.id,
      relativePath: `${title}.mkv`,
      path: `${movie.path}/${title}.mkv`,
      sizeBytes: 10 * GB,
      quality: quality(q),
      languages: ['en'],
      sceneName: `${title.replace(/ /g, '.')}.2024.${q}-GRP`,
    });
    return { movie, file };
  }

  function seriesWithFiles(title: string, q: QualityName, episodes = 2, values: Partial<typeof schema.series.$inferInsert> = {}) {
    const series = h.addSeries({ title, ...values });
    const eps = [];
    for (let n = 1; n <= episodes; n++) {
      const ep = h.addEpisode(series.id, 1, n, { runtimeMinutes: 40 });
      libraryService.addMediaFile(h.db, {
        mediaType: 'series',
        seriesId: series.id,
        seasonNumber: 1,
        episodeIds: [ep.id],
        relativePath: `S01E0${n}.mkv`,
        path: `${series.path}/S01E0${n}.mkv`,
        sizeBytes: 2 * GB,
        quality: quality(q),
        languages: ['en'],
      });
      eps.push(ep);
    }
    return { series, episodes: eps };
  }

  const historyRows = () => h.db.select().from(schema.history).all();
  return { ...h, hd, uhd, migration, movieWithFile, seriesWithFiles, historyRows, grabbedMovies };
}

describe('file fit', () => {
  it('judges each file against the profile governing it', async () => {
    const t = await setup();
    const a = t.movieWithFile('Alpha', 'Bluray-2160p'); // not allowed by HD
    const b = t.movieWithFile('Bravo', 'HDTV-720p'); // below the WEBDL-1080p cutoff
    const c = t.movieWithFile('Charlie', 'Bluray-1080p'); // meets
    t.seriesWithFiles('Delta', 'WEBDL-1080p');

    const summary = t.migration.reevaluate('all');
    expect(summary.files).toBe(5);
    const fits = new Map(t.db.select().from(tables.profileFileFits).all().map((f) => [f.mediaFileId, f]));
    expect(fits.get(a.file.id)).toMatchObject({ status: 'notAllowed', reasons: ['qualityNotAllowed'], qualityProfileId: t.hd.id });
    expect(fits.get(b.file.id)).toMatchObject({ status: 'upgradeAllowed', reasons: ['belowQualityCutoff'] });
    expect(fits.get(c.file.id)).toMatchObject({ status: 'meets', reasons: [] });

    expect(t.migration.itemStatuses()).toEqual(
      expect.arrayContaining([
        { mediaType: 'movie', id: a.movie.id, status: 'notAllowed', notAllowed: 1, upgradeAllowed: 0 },
        { mediaType: 'movie', id: b.movie.id, status: 'upgradeAllowed', notAllowed: 0, upgradeAllowed: 1 },
      ]),
    );
    const progress = t.migration.progress(t.hd.id);
    expect(progress).toMatchObject({ items: 4, mismatchedItems: 2, files: { meets: 3, upgradeAllowed: 1, notAllowed: 1 } });
    // No replacement rule: nothing on the work list.
    expect(progress.queue).toEqual({ remaining: 0, inProgress: 0, done: 0, failed: 0 });
  });

  it('re-judges files when a profile is edited, and lists mismatches for Wanted', async () => {
    const t = await setup();
    t.movieWithFile('Alpha', 'HDTV-720p');
    t.migration.reevaluate('all');
    expect(t.migration.mismatchPage({ page: 1, pageSize: 50 }).totalRecords).toBe(0);

    // Drop HDTV-720p from the allowed list.
    const { id, ...rest } = t.profiles.getQualityProfile(t.hd.id);
    const items = rest.items.map((i) => (i.kind === 'quality' && i.qualityId === quality('HDTV-720p').quality.id ? { ...i, allowed: false } : i));
    t.profiles.updateQualityProfile(id, { ...rest, items });
    t.migration.reevaluate('all');

    const page = t.migration.mismatchPage({ page: 1, pageSize: 50 });
    expect(page.totalRecords).toBe(1);
    expect(page.records[0]).toMatchObject({ title: 'Alpha', status: 'notAllowed', quality: 'HDTV-720p', qualityProfileName: 'Test HD', migration: null });
    expect(t.migration.mismatchPage({ page: 1, pageSize: 50, status: ['upgradeAllowed'] }).totalRecords).toBe(0);
  });
});

describe('profile change detection', () => {
  it('records one profileChanged history event with the old and new names', async () => {
    const t = await setup();
    const { movie } = t.movieWithFile('Alpha', 'Bluray-1080p');
    t.migration.reevaluate('all'); // first pass only takes a snapshot
    expect(t.historyRows()).toHaveLength(0);

    libraryService.updateMovie(t.db, movie.id, { qualityProfileId: t.uhd.id });
    t.migration.reevaluate({ movieIds: [movie.id] });
    t.migration.reevaluate({ movieIds: [movie.id] });

    const rows = t.historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'profileChanged',
      movieId: movie.id,
      data: { oldProfile: 'Test HD', newProfile: 'Ultra HD', oldProfileId: String(t.hd.id), newProfileId: String(t.uhd.id) },
    });
  });

  it('runs event-driven re-evaluations merged and in the background', async () => {
    const t = await setup();
    const { movie } = t.movieWithFile('Alpha', 'Bluray-1080p');
    t.migration.reevaluate('all');
    libraryService.updateMovie(t.db, movie.id, { qualityProfileId: t.uhd.id });
    t.migration.requestReevaluate({ movieIds: [movie.id] });
    t.migration.requestReevaluate({ movieIds: [movie.id] });
    await t.migration.flush();
    expect(t.historyRows().filter((r) => r.eventType === 'profileChanged')).toHaveLength(1);
    expect(t.db.select().from(tables.profileFileFits).all()[0]).toMatchObject({ qualityProfileId: t.uhd.id, status: 'upgradeAllowed' });
  });
});

describe('bulk migration', () => {
  it('previews counts and an estimate, then applies and records the change', async () => {
    const t = await setup();
    // 1 GB per hour at Bluray-2160p (the cutoff of Ultra HD) = 1024/60 MB per minute.
    t.profiles.updateQualityDefinition(quality('Bluray-2160p').quality.id, { minSize: null, maxSize: null, preferredSize: 1024 / 60 });
    t.movieWithFile('Alpha', 'Bluray-2160p', { runtimeMinutes: 120 }); // meets UHD
    t.movieWithFile('Bravo', 'Bluray-1080p', { runtimeMinutes: 60 }); // allowed, below cutoff
    t.movieWithFile('Charlie', 'HDTV-720p', { runtimeMinutes: 90 }); // not allowed
    h_addBare(t);
    t.migration.reevaluate('all');

    const request = { selection: { fromProfileId: t.hd.id, mediaType: 'movie' as const }, toProfileId: t.uhd.id };
    const preview = t.migration.preview(request);
    expect(preview).toMatchObject({
      toProfileName: 'Ultra HD',
      mismatchAction: 'none',
      items: 4,
      movies: 4,
      series: 0,
      itemsWithoutFiles: 1,
      files: { total: 3, meets: 1, upgradeAllowed: 1, notAllowed: 1 },
      needReplacing: 2,
    });
    expect(preview.estimatedDownloadBytes).toBe(150 * 1024 * 1024 * 1024 / 60);
    expect(preview.sample[0]).toMatchObject({ title: 'Charlie', status: 'notAllowed', fromProfiles: ['Test HD'] });

    const applied = t.migration.apply(request);
    expect(applied.changedMovies).toHaveLength(4);
    expect(libraryService.listMovies(t.db, MovieListQuery.parse({})).every((m) => m.qualityProfileId === t.uhd.id)).toBe(true);
    expect(t.historyRows().filter((r) => r.eventType === 'profileChanged')).toHaveLength(4);
    expect(t.migration.progress(t.uhd.id)).toMatchObject({ mismatchedItems: 2, files: { meets: 1, upgradeAllowed: 1, notAllowed: 1 } });
    // Applying again changes nothing.
    expect(t.migration.preview(request)).toMatchObject({ items: 0 });
  });

  it('moves only one version slot when a version tag is given', async () => {
    const t = await setup();
    const versions: MediaVersion[] = [
      { tag: 'Standard', qualityProfileId: t.hd.id, enabled: true },
      { tag: '4K', qualityProfileId: t.hd.id, enabled: true },
    ];
    const { movie } = t.movieWithFile('Alpha', 'Bluray-1080p', { versions });
    const preview = t.migration.preview({ selection: { movieIds: [movie.id], versionTag: '4k' }, toProfileId: t.uhd.id });
    expect(preview).toMatchObject({ items: 1, files: { total: 0 } }); // the file fills Standard, not 4K
    t.migration.apply({ selection: { movieIds: [movie.id], versionTag: '4k' }, toProfileId: t.uhd.id });
    const saved = libraryService.getMovie(t.db, movie.id);
    expect(saved.qualityProfileId).toBe(t.hd.id);
    expect(saved.versions).toEqual([
      { tag: 'Standard', qualityProfileId: t.hd.id, enabled: true },
      { tag: '4K', qualityProfileId: t.uhd.id, enabled: true },
    ]);
  });
});

/** A movie with no file, on the HD profile. */
function h_addBare(t: Awaited<ReturnType<typeof setup>>) {
  return t.addMovie({ title: 'Echo', year: 2024 });
}

describe('replacement rule through the decision engine', () => {
  async function uhdFileOnHd(action: 'none' | 'replace' | 'replaceIfBetter') {
    const t = await setup();
    const { movie, file } = t.movieWithFile('Dune Part Two', 'Bluray-2160p');
    t.migration.updateProfileSettings(t.hd.id, { mismatchAction: action });
    t.indexers.results = [makeRelease('Dune.Part.Two.2024.1080p.BluRay.x264-GRP', { size: 8 * GB })];
    return { t, movie, file };
  }

  it('does nothing without a rule: the 2160p file "meets cutoff"', async () => {
    const { t, movie } = await uhdFileOnHd('none');
    const summary = await t.service.searchFor({ movieId: movie.id });
    expect(summary.grabbed).toEqual([]);
    expect(t.migration.progress(t.hd.id).queue.remaining).toBe(0);
  });

  it('replaces a file the profile does not allow, even a higher-ranked one', async () => {
    const { t, movie } = await uhdFileOnHd('replace');
    expect(t.migration.progress(t.hd.id).queue.remaining).toBe(1);
    expect(t.migration.pendingSearches(t.hd.id)).toBe(1);
    const summary = await t.service.searchFor({ movieId: movie.id });
    expect(summary.grabbed).toEqual(['Dune.Part.Two.2024.1080p.BluRay.x264-GRP']);
  });

  it('only replaces with strictly better releases under replaceIfBetter', async () => {
    const { t, movie } = await uhdFileOnHd('replaceIfBetter');
    const summary = await t.service.searchFor({ movieId: movie.id });
    expect(summary.grabbed).toEqual([]);
  });

  it('marks the item done and records profileReplaced once the replacement is imported', async () => {
    const { t, movie, file } = await uhdFileOnHd('replace');
    setSection(t.db, 'profileMigration', { enabled: true, intervalMinutes: 30, searchesPerRun: 10, maxSearchesPerDay: 100, maxAttempts: 3, retryAfterHours: 24 });
    t.migration.updateProfileSettings(t.hd.id, { autoEnabled: true });
    expect(await t.migration.runAutomatic()).toBe('searched 1, grabbed 1');
    expect(t.migration.progress(t.hd.id).queue).toMatchObject({ remaining: 0, inProgress: 1 });

    // The import puts the new file in place (the old one goes to the recycle bin).
    libraryService.addMediaFile(t.db, {
      mediaType: 'movie',
      movieId: movie.id,
      relativePath: 'Dune.mkv',
      path: `${movie.path}/Dune.1080p.mkv`,
      sizeBytes: 8 * GB,
      quality: quality('Bluray-1080p'),
      languages: ['en'],
      sceneName: 'Dune.Part.Two.2024.1080p.BluRay.x264-GRP',
    });
    // An unversioned movie keeps one file: adding the new one replaced the old row.
    expect(libraryService.listMediaFiles(t.db, { movieId: movie.id }).map((f) => f.id)).not.toContain(file.id);
    t.migration.reevaluate({ movieIds: [movie.id] });

    expect(t.migration.progress(t.hd.id).queue).toMatchObject({ remaining: 0, inProgress: 0, done: 1 });
    const replaced = t.historyRows().filter((r) => r.eventType === 'profileReplaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ movieId: movie.id, data: { qualityProfile: 'Test HD', oldQuality: 'Bluray-2160p', reason: 'notAllowed' } });
  });
});

describe('automatic mode', () => {
  async function queueOf(n: number, opts: { free?: number | null } = {}) {
    const t = await setup(opts);
    const movies = [];
    for (let i = 0; i < n; i++) movies.push(t.movieWithFile(`Film ${i}`, 'HDTV-720p').movie);
    t.migration.updateProfileSettings(t.hd.id, { mismatchAction: 'replace', autoEnabled: true });
    return { t, movies };
  }

  it('stays within the per-run batch and the daily limit', async () => {
    const { t } = await queueOf(5);
    t.migration.updateSettings({ searchesPerRun: 2, maxSearchesPerDay: 3 });
    expect(await t.migration.runAutomatic()).toBe('searched 2, grabbed 0');
    expect(await t.migration.runAutomatic()).toBe('searched 1, grabbed 0');
    expect(await t.migration.runAutomatic()).toBe('daily search limit reached (3)');
    expect(t.indexers.searches).toHaveLength(3);
    // A day later the budget is back; items searched earlier wait for their retry time.
    t.advance(25 * 60 * 60 * 1000);
    expect(await t.migration.runAutomatic()).toBe('searched 2, grabbed 0');
  });

  it('marks items failed after the maximum attempts, and retry puts them back', async () => {
    const { t } = await queueOf(1);
    t.migration.updateSettings({ maxAttempts: 2, retryAfterHours: 1 });
    await t.migration.runAutomatic();
    expect(await t.migration.runAutomatic()).toBe('searched 0, grabbed 0'); // not due yet
    t.advance(2 * 60 * 60 * 1000);
    await t.migration.runAutomatic();
    expect(t.migration.progress(t.hd.id).queue).toMatchObject({ remaining: 0, failed: 1 });
    expect(t.migration.retryFailed(t.hd.id).queue).toMatchObject({ remaining: 1, failed: 0 });
  });

  it('respects the global switch, the profile switch and pause', async () => {
    const { t } = await queueOf(1);
    t.migration.updateSettings({ enabled: false });
    expect(await t.migration.runAutomatic()).toBe('automatic profile migration is off');
    t.migration.updateSettings({ enabled: true });
    t.migration.updateProfileSettings(t.hd.id, { paused: true });
    expect(await t.migration.runAutomatic()).toBe('no profile has automatic migration on');
    expect(t.indexers.searches).toHaveLength(0);
  });

  it('skips items with an active download and searches nothing when disk space is low', async () => {
    const { t, movies } = await queueOf(2, { free: 10 * 1024 * 1024 });
    expect(await t.migration.runAutomatic()).toBe('searched 0, grabbed 0, skipped 2');
    const page = t.migration.mismatchPage({ page: 1, pageSize: 50, status: ['upgradeAllowed'] });
    expect(page.records[0]?.migration?.message).toMatch(/not enough free space/);
    t.grabbedMovies.add(movies[0]!.id);
    setSection(t.db, 'mediaManagement', { ...getSection(t.db, 'mediaManagement'), skipFreeSpaceCheck: true });
    expect(await t.migration.runAutomatic()).toBe('searched 1, grabbed 0, skipped 1');
  });

  it('runs a manual "search all now" as a job without the limits', async () => {
    const { t } = await queueOf(3);
    t.migration.updateSettings({ searchesPerRun: 1 });
    const result = t.migration.searchAllNow(t.hd.id);
    expect(result.searches).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.indexers.searches).toHaveLength(3);
  });

  it('refuses "search all" for a profile without a rule', async () => {
    const t = await setup();
    expect(() => t.migration.searchAllNow(t.hd.id)).toThrow(/no replacement rule/);
  });

  it('turns the interval into a cron expression', () => {
    expect(cronForInterval(30)).toBe('*/30 * * * *');
    expect(cronForInterval(120)).toBe('0 */2 * * *');
    expect(cronForInterval(1440)).toBe('0 3 * * *');
  });
});

describe('routes', () => {
  it('serves preview, apply, mismatch and profile settings', async () => {
    const t = await setup();
    t.movieWithFile('Alpha', 'HDTV-720p');
    t.migration.reevaluate('all');
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(profileMigrationRoutes(t.migration), { prefix: '/api/v1' });

    const bad = await app.inject({ method: 'POST', url: '/api/v1/profilemigration/preview', payload: { selection: {}, toProfileId: t.uhd.id } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/profilemigration/preview', payload: { selection: { fromProfileId: t.hd.id }, toProfileId: 999 } });
    expect(missing.statusCode).toBe(404);

    const put = await app.inject({ method: 'PUT', url: `/api/v1/profilemigration/profiles/${t.hd.id}`, payload: { mismatchAction: 'replace' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ settings: { mismatchAction: 'replace', autoEnabled: false }, queue: { remaining: 1 }, pendingSearches: 1 });

    const mismatch = await app.inject({ method: 'GET', url: '/api/v1/profilemigration/mismatch?status=upgradeAllowed,notAllowed&mediaType=movie' });
    expect(mismatch.json()).toMatchObject({ totalRecords: 1, records: [{ title: 'Alpha', migration: { state: 'queued' } }] });

    const settings = await app.inject({ method: 'PUT', url: '/api/v1/profilemigration/settings', payload: { searchesPerRun: 4 } });
    expect(settings.json()).toMatchObject({ searchesPerRun: 4, intervalMinutes: 30, enabled: true });

    const apply = await app.inject({ method: 'POST', url: '/api/v1/profilemigration/apply', payload: { selection: { mediaType: 'movie', fromProfileId: t.hd.id }, toProfileId: t.uhd.id } });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().changedMovies).toHaveLength(1);
    const row = t.db.select().from(schema.movies).where(eq(schema.movies.title, 'Alpha')).get();
    expect(row?.qualityProfileId).toBe(t.uhd.id);
    await app.close();
  });
});

describe('replacement plan on the Wanted list', () => {
  const HOUR = 60 * 60 * 1000;
  const planOf = (t: Awaited<ReturnType<typeof setup>>) =>
    new Map(t.migration.mismatchPage({ page: 1, pageSize: 50, status: ['upgradeAllowed', 'notAllowed'] }).records.map((r) => [r.title, r.replacement]));

  it('explains files nothing will replace', async () => {
    const t = await setup();
    t.movieWithFile('Alpha', 'Bluray-2160p'); // not allowed, no rule
    t.movieWithFile('Bravo', 'HDTV-720p'); // below cutoff, no rule
    t.migration.reevaluate('all');
    expect(planOf(t).get('Alpha')).toEqual({ state: 'noRule', nextSearchAt: null, maxAttempts: 3 });
    expect(planOf(t).get('Bravo')?.state).toBe('cutoffSearch');
  });

  it('says when an unmonitored item will not be replaced', async () => {
    const t = await setup();
    t.movieWithFile('Alpha', 'HDTV-720p', { monitored: false });
    t.migration.updateProfileSettings(t.hd.id, { mismatchAction: 'replace', autoEnabled: true });
    expect(planOf(t).get('Alpha')?.state).toBe('unmonitored');
  });

  it('estimates the run that searches each queued file within the per-run and daily limits', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) t.movieWithFile(`Film ${i}`, 'HDTV-720p');
    t.migration.updateProfileSettings(t.hd.id, { mismatchAction: 'replace', autoEnabled: true });
    t.migration.updateSettings({ searchesPerRun: 2, maxSearchesPerDay: 3 });
    const runs = upcomingRuns(cronForInterval(30), t.now());
    const nextDay = runs.find((r) => r.getTime() >= runs[0]!.getTime() + 24 * HOUR)!;
    const plan = planOf(t);
    expect(plan.get('Film 0')).toMatchObject({ state: 'scheduled', nextSearchAt: runs[0]!.toISOString() });
    expect(plan.get('Film 1')?.nextSearchAt).toBe(runs[0]!.toISOString());
    expect(plan.get('Film 2')?.nextSearchAt).toBe(runs[1]!.toISOString());
    // The daily limit (3) is used up: the rest wait until the first searches leave the 24 h window.
    expect(plan.get('Film 3')?.nextSearchAt).toBe(nextDay.toISOString());

    // A search that found nothing: the file waits out retryAfterHours (24 h by default).
    await t.migration.runAutomatic();
    const row = t.migration.mismatchPage({ page: 1, pageSize: 50, status: ['upgradeAllowed'] }).records.find((r) => r.title === 'Film 0')!;
    expect(row.migration).toMatchObject({ state: 'queued', attempts: 1 });
    expect(Date.parse(row.migration!.nextSearchAt!)).toBe(t.now().getTime() + 24 * HOUR);
    expect(Date.parse(row.replacement!.nextSearchAt!)).toBeGreaterThan(t.now().getTime() + 24 * HOUR);
  });

  it('follows the global switch, the profile switch and pause', async () => {
    const t = await setup();
    t.movieWithFile('Alpha', 'HDTV-720p');
    t.migration.updateProfileSettings(t.hd.id, { mismatchAction: 'replace' });
    expect(planOf(t).get('Alpha')?.state).toBe('manualOnly');
    t.migration.updateProfileSettings(t.hd.id, { autoEnabled: true, paused: true });
    expect(planOf(t).get('Alpha')?.state).toBe('paused');
    t.migration.updateProfileSettings(t.hd.id, { paused: false });
    t.migration.updateSettings({ enabled: false });
    expect(planOf(t).get('Alpha')).toEqual({ state: 'globalOff', nextSearchAt: null, maxAttempts: 3 });
  });

  it('maps work-list states', () => {
    const rule = { mismatchAction: 'replace' as const, autoEnabled: true, paused: false };
    const base = { status: 'notAllowed' as const, monitored: true, rule, enabled: true };
    expect(replacementState({ ...base, queue: { state: 'grabbed' } })).toBe('downloading');
    expect(replacementState({ ...base, queue: { state: 'failed' } })).toBe('failed');
    expect(replacementState({ ...base, queue: { state: 'queued' } })).toBe('scheduled');
    expect(replacementState({ ...base, queue: null, monitored: false })).toBe('unmonitored');
  });
});
