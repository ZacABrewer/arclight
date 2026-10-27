import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { ItemSearchStatus } from '@arclight/shared';
import { SEARCH_JOB_CRONS } from './jobs.js';
import { releasesRoutes } from './routes.js';
import { isSearchDue, itemOutcomes, planSearchRuns, searchBackoffMs, searchDueAt, topRejection, upcomingRuns, type OutcomeDecision } from './search-status.js';
import { GB, harness, makeRelease } from './test-support.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('back-off', () => {
  it('waits a day per automatic search without a grab, at most a week', () => {
    expect(searchBackoffMs(0)).toBe(DAY);
    expect(searchBackoffMs(1)).toBe(DAY);
    expect(searchBackoffMs(3)).toBe(3 * DAY);
    expect(searchBackoffMs(12)).toBe(7 * DAY);
  });

  it('is due right away without a state, and a minute early otherwise', () => {
    const t0 = Date.parse('2026-03-01T03:00:00.000Z');
    expect(searchDueAt(undefined)).toBe(Number.NEGATIVE_INFINITY);
    expect(isSearchDue(undefined, t0)).toBe(true);
    const state = { lastSearchedAt: new Date(t0).toISOString(), searchCount: 2 };
    expect(searchDueAt(state)).toBe(t0 + 2 * DAY - MINUTE);
    expect(isSearchDue(state, t0 + 2 * DAY - 2 * MINUTE)).toBe(false);
    expect(isSearchDue(state, t0 + 2 * DAY - MINUTE)).toBe(true);
  });
});

describe('planSearchRuns', () => {
  const runs = [0, 1, 2, 3].map((d) => new Date(Date.parse('2026-03-02T03:00:00.000Z') + d * DAY));

  it('takes due items in list order, at most the limit per run', () => {
    const items = [1, 2, 3, 4, 5].map((id) => ({ id, dueAt: Number.NEGATIVE_INFINITY }));
    const plan = planSearchRuns(items, runs, 2);
    expect(plan.get(1)).toEqual({ at: runs[0], runsAhead: 0 });
    expect(plan.get(2)).toEqual({ at: runs[0], runsAhead: 0 });
    expect(plan.get(3)).toEqual({ at: runs[1], runsAhead: 1 });
    expect(plan.get(5)).toEqual({ at: runs[2], runsAhead: 2 });
  });

  it('leaves an item for the first run after its back-off, and reports none beyond the runs', () => {
    const items = [
      { id: 1, dueAt: runs[1]!.getTime() + HOUR },
      { id: 2, dueAt: runs[3]!.getTime() + DAY },
      { id: 3, dueAt: runs[0]!.getTime() },
    ];
    const plan = planSearchRuns(items, runs, 10);
    expect(plan.get(1)).toEqual({ at: runs[2], runsAhead: 0 });
    expect(plan.get(2)).toEqual({ at: null, runsAhead: 0 });
    expect(plan.get(3)).toEqual({ at: runs[0], runsAhead: 0 });
  });

  it('lists upcoming runs of a cron within the horizon', () => {
    const from = new Date('2026-03-01T12:00:00.000Z');
    const runs = upcomingRuns('0 3 * * *', from);
    expect(runs).toHaveLength(14);
    expect(runs.every((r) => r.getTime() > from.getTime())).toBe(true);
    expect(upcomingRuns('not a cron', from)).toEqual([]);
  });
});

describe('itemOutcomes', () => {
  const rejected = (title: string, message: string, episodeIds: number[] = [1]): OutcomeDecision => ({
    title,
    approved: false,
    rejections: [{ message }],
    seriesId: 7,
    episodeIds,
  });

  it('tells grabbed, pending, found, rejected and nothing found apart per item', () => {
    const grab: OutcomeDecision = { title: 'Show.S01E01', approved: true, rejections: [], seriesId: 7, episodeIds: [1] };
    const held: OutcomeDecision = { title: 'Show.S01E02', approved: false, rejections: [{ message: 'delay' }], seriesId: 7, episodeIds: [2] };
    const ok: OutcomeDecision = { title: 'Show.S01E03', approved: true, rejections: [], seriesId: 7, episodeIds: [3] };
    const bad = [rejected('a', 'Quality not wanted', [4]), rejected('b', 'Too small', [4]), rejected('c', 'Quality not wanted', [4])];
    const all = [grab, held, ok, ...bad];
    const out = itemOutcomes('episode', [1, 2, 3, 4, 5], all, new Set([grab]), new Set([held]));
    expect(out.get(1)).toEqual({ outcome: 'grabbed', releases: 1, approved: 1, detail: 'Show.S01E01' });
    expect(out.get(2)).toEqual({ outcome: 'pending', releases: 1, approved: 0, detail: 'Show.S01E02' });
    expect(out.get(3)).toEqual({ outcome: 'found', releases: 1, approved: 1, detail: null });
    expect(out.get(4)).toEqual({ outcome: 'rejected', releases: 3, approved: 0, detail: 'Quality not wanted' });
    expect(out.get(5)).toEqual({ outcome: 'noResults', releases: 0, approved: 0, detail: null });
  });

  it('counts releases that matched nothing against every searched item', () => {
    const unknown: OutcomeDecision = { title: 'Other.Show.S01E01', approved: false, rejections: [{ message: 'Unknown series' }] };
    const out = itemOutcomes('movie', [9], [unknown], new Set(), new Set());
    expect(out.get(9)).toEqual({ outcome: 'rejected', releases: 1, approved: 0, detail: 'Unknown series' });
  });

  it('picks the most common first rejection', () => {
    expect(topRejection([])).toBeNull();
    expect(topRejection([rejected('a', 'x'), rejected('b', 'y'), rejected('c', 'y')])).toBe('y');
  });
});

describe('search results and status', () => {
  async function setup() {
    const h = await harness();
    const series = h.addSeries({ title: 'Show Name', tvdbId: 4242 });
    const eps = [1, 2, 3].map((n) => h.addEpisode(series.id, 1, n));
    return { ...h, series, eps };
  }

  it('records the last search per episode with its outcome and source', async () => {
    const h = await setup();
    h.indexers.results = [makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP'), makeRelease('Show.Name.S01E02.2160p.WEB-DL-GRP')];
    await h.service.searchFor({ seriesId: h.series.id, episodeIds: h.eps.map((e) => e.id) }, { userInvoked: true });
    const status = h.service.searchStatus({ mediaType: 'episode', ids: h.eps.map((e) => e.id) });
    const byId = new Map(status.map((s) => [s.id, s]));
    expect(byId.get(h.eps[0]!.id)!.lastSearch).toMatchObject({ source: 'manual', outcome: 'grabbed', detail: 'Show.Name.S01E01.1080p.WEB-DL-GRP', time: h.now().toISOString() });
    expect(byId.get(h.eps[1]!.id)!.lastSearch).toMatchObject({ outcome: 'rejected', releases: 1, approved: 0 });
    expect(byId.get(h.eps[1]!.id)!.lastSearch!.detail).toBeTruthy();
    expect(byId.get(h.eps[2]!.id)!.lastSearch).toMatchObject({ outcome: 'noResults', releases: 0 });
  });

  it('records a failed search as an error and keeps throwing', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Dune: Part Two', year: 2024, digitalRelease: '2024-04-16' });
    h.indexers.search = async () => {
      throw new Error('indexer unreachable');
    };
    await expect(h.service.searchFor({ movieId: movie.id })).rejects.toThrow('indexer unreachable');
    const [status] = h.service.searchStatus({ mediaType: 'movie', ids: [movie.id] });
    expect(status!.lastSearch).toMatchObject({ source: 'automatic', outcome: 'error', detail: 'indexer unreachable' });
  });

  it('records interactive searches without grabbing', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Dune: Part Two', year: 2024, digitalRelease: '2024-04-16' });
    h.indexers.results = [makeRelease('Dune.Part.Two.2024.1080p.WEB-DL-GRP', { size: 8 * GB })];
    await h.service.interactiveSearch({ movieId: movie.id });
    expect(h.downloads.grabs).toHaveLength(0);
    const [status] = h.service.searchStatus({ mediaType: 'movie', ids: [movie.id] });
    expect(status!.lastSearch).toMatchObject({ source: 'interactive', outcome: 'found', approved: 1 });
  });

  it('estimates the next automatic search from the job schedule and the back-off', async () => {
    const h = await setup();
    const unmonitored = h.addEpisode(h.series.id, 1, 4, { monitored: false });
    const future = h.addEpisode(h.series.id, 1, 5, { airDate: '2027-01-01', airDateUtc: '2027-01-01T20:00:00.000Z' });
    const special = h.addEpisode(h.series.id, 0, 1);
    const ids = [...h.eps.map((e) => e.id), unmonitored.id, future.id, special.id];

    const before = h.service.searchStatus({ mediaType: 'episode', ids });
    const firstRun = upcomingRuns(SEARCH_JOB_CRONS.MissingEpisodeSearch, h.now())[0]!;
    expect(before[0]).toMatchObject({
      monitored: true,
      lastSearch: null,
      automatic: { state: 'scheduled', job: 'MissingEpisodeSearch', nextSearchAt: firstRun.toISOString(), searchCount: 0, runsAhead: 0 },
    });
    expect(before.find((s) => s.id === unmonitored.id)).toMatchObject({ monitored: false, automatic: { state: 'unmonitored', job: null, nextSearchAt: null } });
    expect(before.find((s) => s.id === future.id)!.automatic.state).toBe('notAvailable');
    expect(before.find((s) => s.id === special.id)!.automatic.state).toBe('special');

    h.indexers.results = [];
    await h.service.missingEpisodeSearch();
    const after = h.service.searchStatus({ mediaType: 'episode', ids: [h.eps[0]!.id] })[0]!;
    // One miss: due again a day (less a minute) later, at the first run from then on.
    const due = h.now().getTime() + DAY - MINUTE;
    const expected = upcomingRuns(SEARCH_JOB_CRONS.MissingEpisodeSearch, h.now()).find((r) => r.getTime() >= due)!;
    expect(after.lastSearch).toMatchObject({ source: 'automatic', outcome: 'noResults' });
    expect(after.automatic).toMatchObject({ state: 'scheduled', searchCount: 1, nextSearchAt: expected.toISOString() });
  });

  it('says so when the job does not run, and when a file meets the cutoff', async () => {
    const h = await setup();
    const movie = h.addMovie({ title: 'Arrival', year: 2016, hasFile: true });
    h.service.setJobSchedules((name) => (name === 'MissingEpisodeSearch' ? { cron: null, enabled: true } : null));
    const [episode] = h.service.searchStatus({ mediaType: 'episode', ids: [h.eps[0]!.id] });
    expect(episode!.automatic).toMatchObject({ state: 'jobDisabled', job: 'MissingEpisodeSearch', nextSearchAt: null });
    // A movie with a file that the library has no file rows for is not on the cutoff list.
    const [m] = h.service.searchStatus({ mediaType: 'movie', ids: [movie.id] });
    expect(m!.automatic.state).toBe('satisfied');
  });

  it('serves GET /release/searchstatus', async () => {
    const h = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(releasesRoutes(h.service));
    const res = await app.inject({ method: 'GET', url: `/release/searchstatus?mediaType=episode&ids=${h.eps[0]!.id},${h.eps[1]!.id},99999` });
    expect(res.statusCode).toBe(200);
    const body = ItemSearchStatus.array().parse(res.json());
    expect(body.map((s) => s.id)).toEqual([h.eps[0]!.id, h.eps[1]!.id]);
    expect((await app.inject({ method: 'GET', url: '/release/searchstatus?mediaType=episode' })).statusCode).toBe(400);
  });
});
