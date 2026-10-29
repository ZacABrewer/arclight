import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import type { GrabHistoryInput } from './deps.js';
import { releasesRoutes } from './routes.js';
import { pendingReleases } from './schema.js';
import { libraryService } from '../library/index.js';
import { KEPT_BY_CHOICE_MESSAGE } from './engine.js';
import { GB, harness, makeIndexer, makeRelease, quality } from './test-support.js';

const MINUTE = 60_000;

async function tvSetup(opts: Parameters<typeof harness>[0] = {}) {
  const h = await harness(opts);
  const series = h.addSeries({ title: 'Show Name', tvdbId: 4242 });
  const eps = [1, 2, 3].map((n) => h.addEpisode(series.id, 1, n));
  return { ...h, series, eps };
}

function setDelay(h: Awaited<ReturnType<typeof harness>>, torrentDelayMinutes: number) {
  const dp = h.profiles.listDelayProfiles()[0]!;
  h.profiles.updateDelayProfile(dp.id, {
    tags: [],
    preferredProtocol: 'usenet',
    usenetDelayMinutes: 0,
    torrentDelayMinutes,
    bypassIfHighestQuality: false,
    bypassIfAboveCustomFormatScore: false,
    minimumCustomFormatScore: 0,
  });
}

async function routesApp(h: Awaited<ReturnType<typeof harness>>) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(releasesRoutes(h.service));
  return app;
}

describe('RSS processing', () => {
  it('grabs only the best approved release per episode set', async () => {
    const h = await tvSetup();
    const decisions = await h.service.processReleases(
      [
        makeRelease('Show.Name.S01E01.720p.HDTV-A', { seeders: 10 }),
        makeRelease('Show.Name.S01E01.1080p.WEB-DL-B', { seeders: 10 }),
        makeRelease('Show.Name.S01E01.1080p.WEB-DL-C', { seeders: 900 }),
        makeRelease('Show.Name.S01E02.1080p.WEB-DL-D'),
        makeRelease('Unknown.Show.S01E01.1080p.WEB-DL-X'),
      ],
      'rss',
    );
    expect(decisions).toHaveLength(5);
    expect(decisions.find((d) => d.title.includes('Unknown'))!.rejections[0]!.reason).toBe('unknownSeries');
    expect(h.downloads.grabs.map((g) => g.request.title).sort()).toEqual(['Show.Name.S01E01.1080p.WEB-DL-C', 'Show.Name.S01E02.1080p.WEB-DL-D']);
    const grab = h.downloads.grabs.find((g) => g.request.title.endsWith('-C'))!;
    expect(grab.tracking).toMatchObject({ mediaType: 'series', seriesId: h.series.id, episodeIds: [h.eps[0]!.id] });
    expect(grab.request.torrentFile).toBeInstanceOf(Uint8Array);
  });

  it('lets a season pack cover the singles it contains', async () => {
    const h = await tvSetup();
    await h.service.processReleases(
      [makeRelease('Show.Name.S01E01.1080p.WEB-DL-A'), makeRelease('Show.Name.S01.1080p.WEB-DL-PACK', { size: 4 * GB })],
      'rss',
    );
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual(['Show.Name.S01.1080p.WEB-DL-PACK']);
  });

  it('silently drops unparseable releases in RSS', async () => {
    const h = await tvSetup();
    const decisions = await h.service.processReleases([makeRelease('zzzz')], 'rss');
    expect(decisions).toEqual([]);
  });

  it('is wired to indexer RSS results via onReleases', async () => {
    const h = await tvSetup();
    h.service.attach();
    await h.indexers.handler!([makeRelease('Show.Name.S01E03.1080p.WEB-DL-GRP')]);
    expect(h.downloads.grabs).toHaveLength(1);
  });

  it('records history and publishes a grabbed event', async () => {
    const recorded: GrabHistoryInput[] = [];
    const h = await tvSetup({ deps: { history: { recordGrab: (g) => void recorded.push(g) } } });
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP')], 'rss');
    expect(recorded).toEqual([expect.objectContaining({ sourceTitle: 'Show.Name.S01E01.1080p.WEB-DL-GRP', downloadId: 'hash1', indexerId: 1 })]);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'release', action: 'grabbed', mediaType: 'series' }));
  });

  it('skips blocklisted releases via the injected hook', async () => {
    const isBlocklisted = vi.fn(async (r: { title: string }) => r.title.endsWith('-BAD'));
    const h = await tvSetup({ deps: { blocklist: { isBlocklisted } } });
    await h.service.processReleases(
      [makeRelease('Show.Name.S01E01.1080p.WEB-DL-BAD', { seeders: 999 }), makeRelease('Show.Name.S01E01.720p.HDTV-OK')],
      'rss',
    );
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual(['Show.Name.S01E01.720p.HDTV-OK']);
  });

  it('rejects releases the injected release filter refuses (tracker freeleech-only)', async () => {
    const releaseFilter = vi.fn((_indexerId: number, r: { downloadVolumeFactor?: number | undefined }) =>
      r.downloadVolumeFactor === 0 ? null : { reason: 'notFreeleech', message: 'not freeleech' },
    );
    const h = await tvSetup({ deps: { releaseFilter } });
    const decisions = await h.service.processReleases(
      [makeRelease('Show.Name.S01E01.1080p.WEB-DL-PAID', { seeders: 999 }), makeRelease('Show.Name.S01E01.720p.HDTV-FL', { downloadVolumeFactor: 0 })],
      'rss',
    );
    expect(releaseFilter).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Show.Name.S01E01.1080p.WEB-DL-PAID' }));
    expect(decisions.find((d) => d.title.endsWith('-PAID'))?.rejections).toContainEqual(expect.objectContaining({ reason: 'notFreeleech', type: 'permanent' }));
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual(['Show.Name.S01E01.720p.HDTV-FL']);
  });

  it('downloads a usenet release as NZB bytes and passes them as `nzb`', async () => {
    const h = await tvSetup();
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP', { protocol: 'usenet' })], 'rss');
    const grab = h.downloads.grabs[0]!;
    expect(grab.request.protocol).toBe('usenet');
    expect(grab.request.nzb).toBeInstanceOf(Uint8Array);
    expect(grab.request.torrentFile).toBeUndefined();
    expect(grab.request.seedConfig).toBeUndefined();
  });

  it('parks a usenet release when no usenet client is available', async () => {
    const h = await tvSetup();
    h.downloads.fail = Object.assign(new Error('No enabled usenet download client is available'), { code: 'NO_CLIENT' });
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP', { protocol: 'usenet' })], 'rss');
    expect(h.service.listPending()).toEqual([expect.objectContaining({ reason: 'downloadClientUnavailable' })]);
  });

  it('parks releases when the download client is unavailable', async () => {
    const h = await tvSetup();
    h.downloads.fail = Object.assign(new Error('No enabled torrent download client is available'), { code: 'NO_CLIENT' });
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP')], 'rss');
    expect(h.service.listPending()).toEqual([expect.objectContaining({ reason: 'downloadClientUnavailable' })]);
  });
});

describe('grab guard', () => {
  it('temporarily rejects with vpnDown and parks the release while the guard says no', async () => {
    let safe = false;
    const h = await tvSetup({ deps: { grabGuard: { isSafeToGrab: async () => safe, reason: 'VPN down' } } });
    const decisions = await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP')], 'rss');
    expect(h.downloads.grabs).toHaveLength(0);
    expect(decisions[0]!.rejections).toContainEqual({ reason: 'vpnDown', message: 'VPN down', type: 'temporary' });
    expect(h.service.listPending()).toEqual([expect.objectContaining({ reason: 'downloadClientUnavailable' })]);
    safe = true;
    await h.service.processReleases([makeRelease('Show.Name.S01E02.1080p.WEB-DL-GRP')], 'rss');
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual(['Show.Name.S01E02.1080p.WEB-DL-GRP']);
  });
});

describe('delay profiles and pending releases', () => {
  it('holds a delayed release, keeps lesser ones as fallback, and grabs the best once elapsed', async () => {
    const h = await tvSetup();
    setDelay(h, 60);
    await h.service.processReleases(
      [
        makeRelease('Show.Name.S01E01.1080p.BluRay.x264-BEST', { ageMinutes: 10 }),
        makeRelease('Show.Name.S01E01.720p.HDTV-LESSER', { ageMinutes: 10 }),
      ],
      'rss',
    );
    expect(h.downloads.grabs).toHaveLength(0);
    const pending = h.service.listPending();
    expect(pending.map((p) => [p.title, p.reason])).toEqual([
      ['Show.Name.S01E01.1080p.BluRay.x264-BEST', 'delay'],
      ['Show.Name.S01E01.720p.HDTV-LESSER', 'fallback'],
    ]);
    expect(pending[0]!.remainingMinutes).toBe(50);

    expect(await h.service.processPending()).toBe('no pending releases due');
    h.advance(51 * MINUTE);
    await h.service.processPending();
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual(['Show.Name.S01E01.1080p.BluRay.x264-BEST']);
    expect(h.service.listPending()).toEqual([]);
  });

  it('deletes a pending release by id', async () => {
    const h = await tvSetup();
    setDelay(h, 60);
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP', { ageMinutes: 1 })], 'rss');
    const [p] = h.service.listPending();
    const app = await routesApp(h);
    expect((await app.inject({ method: 'DELETE', url: `/release/pending/${p!.id}` })).statusCode).toBe(204);
    expect(h.db.select().from(pendingReleases).all()).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/release/pending/${p!.id}` })).statusCode).toBe(404);
  });
});

describe('searching', () => {
  it('interactive search returns approved and rejected decisions with reasons', async () => {
    const h = await tvSetup();
    h.indexers.results = [
      makeRelease('Show.Name.S01E02.1080p.WEB-DL-GRP'),
      makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP'),
      makeRelease('Show.Name.S01E02.480p.WEB-DL-GRP', { size: 300 * 1024 * 1024 }),
    ];
    const app = await routesApp(h);
    const res = await app.inject({ method: 'GET', url: `/release?episodeId=${h.eps[1]!.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ title: string; approved: boolean; rejections: Array<{ reason: string; message: string }> }>;
    expect(body[0]).toMatchObject({ title: 'Show.Name.S01E02.1080p.WEB-DL-GRP', approved: true });
    const wrong = body.find((d) => d.title.includes('S01E01'))!;
    expect(wrong.rejections.map((r) => r.reason)).toContain('wrongEpisode');
    expect(body.find((d) => d.title.includes('480p'))!.rejections[0]!.message).toMatch(/not wanted/);
    expect(h.downloads.grabs).toHaveLength(0);
    expect(h.indexers.searches[0]).toMatchObject({ kind: 'tv', tvdbId: 4242, season: 1, episode: 2 });
  });

  it('grabs a release from the search cache by guid, honouring overrides', async () => {
    const h = await tvSetup();
    h.indexers.results = [makeRelease('Show.Name.S01E02.720p.HDTV-GRP', { guid: 'g1' })];
    await h.service.interactiveSearch({ seriesId: h.series.id, seasonNumber: 1 });
    const app = await routesApp(h);
    const res = await app.inject({ method: 'POST', url: '/release', payload: { guid: 'g1', indexerId: 1, episodeIds: [h.eps[2]!.id] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Show.Name.S01E02.720p.HDTV-GRP', downloadId: 'hash1' });
    expect(h.downloads.grabs[0]!.tracking.episodeIds).toEqual([h.eps[2]!.id]);
    expect((await app.inject({ method: 'POST', url: '/release', payload: { guid: 'nope', indexerId: 1 } })).statusCode).toBe(404);
  });

  it('reports a release gone at the indexer and passes magnet redirects through', async () => {
    const h = await tvSetup();
    h.indexers.results = [
      makeRelease('Show.Name.S01E01.720p.HDTV-GRP', { guid: 'gone', downloadUrl: 'http://indexer.test/gone' }),
      makeRelease('Show.Name.S01E02.720p.HDTV-GRP', { guid: 'mag', downloadUrl: 'http://indexer.test/tomagnet' }),
    ];
    await h.service.interactiveSearch({ seriesId: h.series.id });
    const app = await routesApp(h);
    expect((await app.inject({ method: 'POST', url: '/release', payload: { guid: 'gone', indexerId: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/release', payload: { guid: 'mag', indexerId: 1 } })).statusCode).toBe(200);
    expect(h.downloads.grabs[0]!.request.magnet).toBe('magnet:?xt=urn:btih:abc');
  });

  it('passes seed settings from the indexer to the grab', async () => {
    const h = await tvSetup();
    h.indexers.indexers = [makeIndexer({ downloadClientId: 7, settings: { ...makeIndexer().settings, seedRatio: 2, seedTime: 120 * MINUTE } })];
    await h.service.processReleases([makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP', { downloadUrl: 'magnet:?xt=urn:btih:def' })], 'rss');
    expect(h.downloads.grabs[0]).toMatchObject({ clientId: 7, request: { magnet: 'magnet:?xt=urn:btih:def', seedConfig: { ratioLimit: 2, seedTimeLimitMinutes: 120 } } });
    expect(h.fetchImpl.calls).toEqual([]);
  });

  it('POST /command/search runs a user-invoked search and grabs', async () => {
    const h = await tvSetup();
    h.db.update(schema.series).set({ monitored: false }).where(eq(schema.series.id, h.series.id)).run();
    h.indexers.results = [makeRelease('Show.Name.S01.1080p.WEB-DL-GRP', { size: 4 * GB })];
    const app = await routesApp(h);
    const res = await app.inject({ method: 'POST', url: '/command/search', payload: { seriesId: h.series.id, seasonNumber: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ releases: 1, approved: 1, grabbed: ['Show.Name.S01.1080p.WEB-DL-GRP'] });
    expect(h.indexers.searches[0]).toMatchObject({ kind: 'tv', season: 1 });
  });

  it('registers a manual search resolver for library ids', async () => {
    const h = await tvSetup();
    const movie = h.addMovie({ title: 'Some Movie', imdbId: 'tt1234567', year: 2021 });
    h.service.attach();
    const resolve = h.indexers.resolver as unknown as (r: object) => unknown;
    expect(resolve({ seriesId: h.series.id, seasonNumber: 1 })).toMatchObject({ kind: 'tv', tvdbId: 4242, season: 1 });
    expect(resolve({ movieId: movie.id })).toMatchObject({ kind: 'movie', imdbId: 'tt1234567', year: 2021 });
    expect(resolve({ movieId: 999 })).toBeNull();
  });

  it('builds a movie search and grabs the matching release', async () => {
    const h = await tvSetup();
    const movie = h.addMovie({ title: 'Dune: Part Two', year: 2024, digitalRelease: '2024-04-16' });
    h.indexers.results = [
      makeRelease('Dune.Part.Two.2024.1080p.WEB-DL-GRP', { size: 8 * GB }),
      makeRelease('Dune.2021.1080p.WEB-DL-GRP', { size: 8 * GB }),
    ];
    const summary = await h.service.searchFor({ movieId: movie.id });
    expect(summary.grabbed).toEqual(['Dune.Part.Two.2024.1080p.WEB-DL-GRP']);
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ mediaType: 'movie', movieId: movie.id });
  });

  it('backs off scheduled missing searches per item', async () => {
    const h = await tvSetup();
    h.indexers.results = [];
    expect(await h.service.missingEpisodeSearch()).toBe('missing episodes: searched 3, grabbed 0');
    expect(await h.service.missingEpisodeSearch()).toBe('missing episodes: searched 0, grabbed 0');
    h.advance(25 * 60 * MINUTE);
    expect(await h.service.missingEpisodeSearch()).toBe('missing episodes: searched 3, grabbed 0');
    h.advance(25 * 60 * MINUTE); // second miss → two-day backoff
    expect(await h.service.missingEpisodeSearch()).toBe('missing episodes: searched 0, grabbed 0');
  });
});

describe('push', () => {
  it('processes a pushed release and grabs it', async () => {
    const h = await tvSetup();
    const app = await routesApp(h);
    const res = await app.inject({
      method: 'POST',
      url: '/release/push',
      payload: {
        title: 'Show.Name.S01E03.1080p.WEB-DL-GRP',
        downloadUrl: 'magnet:?xt=urn:btih:push',
        protocol: 'torrent',
        publishDate: new Date(h.now().getTime() - 30 * MINUTE).toISOString(),
        size: GB,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ grabbed: true, pending: false, decision: { approved: true, source: 'releasePush' } });
    expect(h.downloads.grabs[0]!.request.magnet).toBe('magnet:?xt=urn:btih:push');
  });

  it('returns the rejection for a pushed release that does not qualify', async () => {
    const h = await tvSetup();
    const app = await routesApp(h);
    const res = await app.inject({
      method: 'POST',
      url: '/release/push',
      payload: { title: 'Show.Name.S01E03.480p.WEB-DL-GRP', downloadUrl: 'magnet:?x', protocol: 'torrent', publishDate: h.now().toISOString() },
    });
    expect(res.json()).toMatchObject({ grabbed: false, decision: { approved: false, rejections: [{ reason: 'qualityNotWanted' }] } });
  });

  it('validates the push body', async () => {
    const h = await tvSetup();
    const app = await routesApp(h);
    expect((await app.inject({ method: 'POST', url: '/release/push', payload: { title: 'x' } })).statusCode).toBe(400);
  });
});

describe('search-page grabs and indexer downloads', () => {
  it('grabs a matching search result through the decision engine', async () => {
    const h = await tvSetup();
    const outcome = await h.service.grabSearchResult(makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP'), { force: false });
    expect(outcome).toMatchObject({ kind: 'grabbed', matched: true, title: 'Show.Name.S01E01.1080p.WEB-DL-GRP' });
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ mediaType: 'series', seriesId: h.series.id });
  });

  it('refuses an unmatched result without force and grabs it untracked with force', async () => {
    const h = await tvSetup();
    const release = makeRelease('Some.Other.Thing.2024.1080p.WEB-DL-X');
    const refused = await h.service.grabSearchResult(release, { force: false });
    expect(refused.kind).toBe('no-match');
    expect(h.downloads.grabs).toHaveLength(0);

    const forced = await h.service.grabSearchResult(release, { force: true });
    expect(forced).toMatchObject({ kind: 'grabbed', matched: false });
    expect(h.downloads.grabs).toHaveLength(1);
    expect(h.downloads.grabs[0]!.tracking).toEqual({});
    expect(h.downloads.grabs[0]!.request.title).toBe(release.title);
  });

  it('downloads release files through the indexer port when it offers downloadRelease', async () => {
    const h = await tvSetup();
    const calls: string[] = [];
    const port = h.indexers as unknown as { downloadRelease: (id: number, url: string) => Promise<unknown> };
    port.downloadRelease = async (_id, url) => {
      calls.push(url);
      return { kind: 'file', protocol: 'torrent', data: new TextEncoder().encode('d8:announce3:urle') };
    };
    await h.service.processReleases([makeRelease('Show.Name.S01E02.1080p.WEB-DL-GRP', { downloadUrl: 'http://site/dl/2.torrent' })], 'rss');
    expect(calls).toEqual(['http://site/dl/2.torrent']);
    expect(h.fetchImpl.calls).toHaveLength(0);
    expect(h.downloads.grabs[0]!.request.torrentFile).toBeInstanceOf(Uint8Array);
  });
});

describe('"Grab anyway" overrides', () => {
  it('records the overridden rejections with the download and in history; an approved grab records none', async () => {
    const recorded: GrabHistoryInput[] = [];
    const h = await tvSetup({ deps: { history: { recordGrab: (g) => void recorded.push(g) } } });
    h.indexers.results = [
      makeRelease('Show.Name.S01E02.480p.WEB-DL-GRP', { guid: 'low', size: 300 * 1024 * 1024 }),
      makeRelease('Show.Name.S01E02.1080p.WEB-DL-GRP', { guid: 'ok' }),
    ];
    const decisions = await h.service.interactiveSearch({ episodeId: h.eps[1]!.id });
    const low = decisions.find((d) => d.guid === 'low')!;
    expect(low).toMatchObject({ approved: false, downloadAllowed: true });

    await h.service.grab({ guid: 'low', indexerId: 1 });
    const snapshot = h.downloads.grabs[0]!.tracking.grabbedRelease as { grabOverride?: { rejections: string[]; grabbedAt: string; sourceTitle: string } };
    expect(snapshot.grabOverride).toEqual({ rejections: low.rejections.map((r) => r.message), grabbedAt: h.now().toISOString(), sourceTitle: low.title });
    expect(recorded[0]!.overriddenRejections).toEqual(low.rejections.map((r) => r.message));

    await h.service.grab({ guid: 'ok', indexerId: 1 });
    expect((h.downloads.grabs[1]!.tracking.grabbedRelease as Record<string, unknown>)['grabOverride']).toBeUndefined();
    expect(recorded[1]!.overriddenRejections).toBeUndefined();
  });

  it('pauses automatic upgrades of a file kept by choice; interactive search still offers them', async () => {
    const h = await tvSetup();
    libraryService.addMediaFile(h.db, {
      mediaType: 'series',
      seriesId: h.series.id,
      seasonNumber: 1,
      episodeIds: [h.eps[0]!.id],
      relativePath: 'S01E01.mkv',
      path: '/tv/show/S01E01.mkv',
      sizeBytes: GB,
      quality: quality('HDTV-720p'),
      languages: ['en'],
      grabOverride: { rejections: ['Quality not wanted in profile'], grabbedAt: h.now().toISOString(), sourceTitle: 'Show.Name.S01E01.720p.HDTV-GRP' },
    });
    const upgrade = makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP', { guid: 'up' });
    const [rss] = await h.service.processReleases([upgrade], 'rss');
    expect(rss).toMatchObject({ approved: false, rejections: [{ reason: 'keptByChoice', message: KEPT_BY_CHOICE_MESSAGE }] });
    expect(h.downloads.grabs).toHaveLength(0);
    // The cutoff-unmet lists skip it too.
    expect(h.service.isFileCutoffMet()(libraryService.listMediaFiles(h.db, { seriesId: h.series.id })[0]!)).toBe(true);

    h.indexers.results = [upgrade];
    const [interactive] = await h.service.interactiveSearch({ episodeId: h.eps[0]!.id });
    expect(interactive).toMatchObject({ approved: true });
  });
});
