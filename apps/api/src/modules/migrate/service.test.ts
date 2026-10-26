import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrateArea, MigrateSourceInput, MigrationResult } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { ProfilesService } from '../profiles/service.js';
import { getSection } from '../settings/service.js';
import { MigrateError } from './errors.js';
import { migrateImported, migrateStaging } from './schema.js';
import { MigrateService } from './service.js';
import { makeProwlarrDb, makeRadarrDb, makeSonarrDb } from './test-fixtures.js';

let tmp: string;
let db: Db;
let service: MigrateService;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mt-migrate-'));
  db = await createTestDb({ migrateImported, migrateStaging });
  service = new MigrateService({ db, now: () => new Date('2024-06-01T00:00:00Z') });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sonarrSource(): MigrateSourceInput {
  const dbPath = join(tmp, 'sonarr', 'sonarr.db');
  makeSonarrDb(dbPath);
  mkdirSync(join(tmp, 'tv'), { recursive: true });
  return {
    app: 'sonarr',
    dbPath,
    pathMappings: [
      { from: '/tv', to: join(tmp, 'tv') },
      { from: '/data', to: join(tmp, 'data') },
    ],
  };
}

function radarrSource(legacy = false): MigrateSourceInput {
  const dbPath = join(tmp, 'radarr', 'radarr.db');
  makeRadarrDb(dbPath, { legacy });
  return { app: 'radarr', dbPath, pathMappings: [{ from: '/movies', to: join(tmp, 'movies') }] };
}

function area(result: MigrationResult, name: MigrateArea) {
  const r = result.areas.find((a) => a.area === name);
  if (!r) throw new Error(`no result for ${name}`);
  return r;
}

const staged = (areaName: string) => db.select().from(migrateStaging).all().filter((r) => r.area === areaName);

describe('Sonarr plan', () => {
  it('counts every area without writing anything', async () => {
    const plan = await service.plan(sonarrSource());
    const by = Object.fromEntries(plan.areas.map((a) => [a.area, a]));
    expect(plan.schemaVersion).toBe('214');
    expect(by['series']).toMatchObject({ total: 3, create: 2, unsupported: 1, details: { episodes: 6, files: 2 } });
    expect(by['tags']).toMatchObject({ total: 2, create: 2 });
    expect(by['indexers']).toMatchObject({ total: 3, create: 2, unsupported: 1 });
    expect(by['notifications']).toMatchObject({ total: 3, create: 1, unsupported: 2 });
    expect(by['downloadClients']).toMatchObject({ total: 3, create: 2, unsupported: 1 });
    expect(by['history']).toMatchObject({ total: 3, details: { otherEventsIgnored: 1 } });
    expect(plan.unsupported.map((u) => u.name)).toEqual(expect.arrayContaining(['Old Show (1999)', 'IPT', 'Slack', 'Trakt Watchlist']));
    expect(db.select().from(t.series).all()).toHaveLength(0);
    expect(db.select().from(migrateImported).all()).toHaveLength(0);
  });

  it('warns about unknown custom format specifications and untranslatable naming tokens', async () => {
    const plan = await service.plan(sonarrSource());
    expect(plan.warnings.some((w) => w.area === 'customFormats' && /futuremagic/.test(w.message))).toBe(true);
    expect(plan.warnings.some((w) => w.area === 'naming' && /Series TitleSlug/.test(w.message))).toBe(true);
    expect(plan.warnings.some((w) => w.area === 'qualityProfiles' && /HDTV-480p/.test(w.message))).toBe(true);
  });

  it('reports conflicts with existing data', async () => {
    new ProfilesService({ db }).createQualityProfile({ ...new ProfilesService({ db }).qualityProfileTemplate(), name: 'HD-1080p', cutoff: 1, items: [{ kind: 'quality', qualityId: 1, allowed: true }] });
    const plan = await service.plan(sonarrSource());
    expect(plan.conflicts).toContainEqual(expect.objectContaining({ area: 'qualityProfiles', name: 'HD-1080p', reason: 'quality profile "HD-1080p" exists' }));
  });

  it('refuses a database of another app and a missing file', async () => {
    const src = radarrSource();
    await expect(service.plan({ ...src, app: 'sonarr' })).rejects.toThrow(MigrateError);
    await expect(service.plan({ app: 'sonarr', dbPath: join(tmp, 'nope.db') })).rejects.toThrowError(/not found/);
  });
});

describe('Sonarr apply', () => {
  it('imports the library with remapped paths, episodes, files and file links', async () => {
    const result = await service.apply(sonarrSource());
    expect(area(result, 'series')).toMatchObject({ created: 2, skipped: 1, failed: 0 });
    const series = db.select().from(t.series).all();
    const bb = series.find((s) => s.tmdbId === 1396)!;
    expect(bb).toMatchObject({
      title: 'Breaking Bad',
      tvdbId: 81189,
      imdbId: 'tt0903747',
      year: 2008,
      status: 'ended',
      path: join(tmp, 'tv', 'Breaking Bad'),
      rootFolderPath: join(tmp, 'tv'),
      monitored: true,
      seriesType: 'standard',
      network: 'AMC',
      originalLanguage: 'en',
      ratings: { tvdb: { votes: 10, value: 9.5 } },
      added: '2020-01-01T10:00:00.000Z',
      lastRefreshed: null,
    });
    expect(bb.images).toEqual([{ coverType: 'poster', url: 'https://artworks.thetvdb.com/p.jpg', remoteUrl: 'https://artworks.thetvdb.com/p.jpg' }]);
    const anime = series.find((s) => s.tmdbId === 999)!;
    expect(anime).toMatchObject({ seriesType: 'anime', seasonFolder: false, monitored: false, monitorNewItems: 'none' });

    const eps = db.select().from(t.episodes).where(eq(t.episodes.seriesId, bb.id)).all();
    expect(eps).toHaveLength(4);
    const files = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.seriesId, bb.id)).all();
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file).toMatchObject({
      path: join(tmp, 'tv', 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv'),
      sizeBytes: 3_000_000_000,
      languages: ['en'],
      releaseGroup: 'NTb',
      seasonNumber: 1,
      dateAdded: '2021-02-03T04:05:06.000Z',
    });
    expect(file.quality.quality.name).toBe('WEBDL-1080p');
    expect(file.quality.revision).toMatchObject({ version: 2, isRepack: true });
    expect(file.mediaInfo).toMatchObject({ videoCodec: 'h264', resolution: '1920x1080', runtimeSeconds: 2830, audioLanguages: ['eng', 'spa'] });
    const linked = eps.filter((e) => e.episodeFileId === file.id).map((e) => e.episodeNumber).sort();
    expect(linked).toEqual([1, 2]);
    expect(eps.find((e) => e.episodeNumber === 3)).toMatchObject({ hasFile: false, monitored: true });
    expect(eps.find((e) => e.seasonNumber === 0)).toMatchObject({ monitored: false });
    const seasons = db.select().from(t.seasons).where(eq(t.seasons.seriesId, bb.id)).all();
    expect(seasons.map((s) => [s.seasonNumber, s.monitored])).toEqual([
      [0, false],
      [1, true],
    ]);
    const animeFile = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.seriesId, anime.id)).get()!;
    expect(animeFile.quality.quality.name).toBe('Remux-1080p');
    expect(animeFile.languages).toEqual(['ja']);
  });

  it('maps tags and quality profiles onto the series and keeps custom format scores', async () => {
    await service.apply(sonarrSource());
    const tags = db.select().from(t.tags).all();
    expect(tags.map((x) => x.label).sort()).toEqual(['4k', 'anime']);
    const fourK = tags.find((x) => x.label === '4k')!;
    const profile = db.select().from(t.qualityProfiles).where(eq(t.qualityProfiles.name, 'HD-1080p')).get()!;
    const bb = db.select().from(t.series).where(eq(t.series.tmdbId, 1396)).get()!;
    expect(bb.tags).toEqual([fourK.id]);
    expect(bb.qualityProfileId).toBe(profile.id);
    expect(profile.cutoff).toBe(1000);
    expect(profile.items).toEqual([
      { kind: 'quality', qualityId: 1, allowed: false },
      { kind: 'group', id: 1000, name: 'WEB 1080p', qualityIds: [3, 16], allowed: true },
      { kind: 'quality', qualityId: 7, allowed: true },
    ]);
    const x265 = db.select().from(t.customFormats).where(eq(t.customFormats.name, 'x265')).get()!;
    const weird = db.select().from(t.customFormats).where(eq(t.customFormats.name, 'Weird')).get()!;
    expect(profile.formatItems).toEqual([
      { formatId: x265.id, score: 100 },
      { formatId: weird.id, score: -10 },
    ]);
    // The unknown spec was skipped; the translatable one survived.
    expect(weird.specifications).toEqual([{ implementation: 'source', name: 'WEB', negate: false, required: false, fields: { source: 'web' } }]);
    expect(weird.includeWhenRenaming).toBe(true);
  });

  it('is idempotent: a second run creates nothing and the plan shows everything as imported', async () => {
    const src = sonarrSource();
    const first = await service.apply(src);
    const counts = () => ({
      series: db.select().from(t.series).all().length,
      episodes: db.select().from(t.episodes).all().length,
      files: db.select().from(t.mediaFiles).all().length,
      profiles: db.select().from(t.qualityProfiles).all().length,
      formats: db.select().from(t.customFormats).all().length,
      indexers: db.select().from(t.indexers).all().length,
      history: db.select().from(t.history).all().length,
      blocklist: db.select().from(t.blocklist).all().length,
      staging: db.select().from(migrateStaging).all().length,
    });
    const before = counts();
    const second = await service.apply(src);
    expect(counts()).toEqual(before);
    expect(second.areas.reduce((n, a) => n + a.created + a.updated + a.failed, 0)).toBe(0);
    expect(first.areas.reduce((n, a) => n + a.created, 0)).toBeGreaterThan(10);
    const plan = await service.plan(src);
    const series = plan.areas.find((a) => a.area === 'series')!;
    expect(series).toMatchObject({ create: 0, alreadyImported: 2 });
  });

  it('imports infrastructure through the owning services', async () => {
    const result = await service.apply(sonarrSource());
    expect(area(result, 'indexers')).toMatchObject({ created: 2, skipped: 1 });
    const indexers = db.select().from(t.indexers).all();
    const jackett = indexers.find((i) => i.name === 'Jackett 1337x')!;
    const qbit = db.select().from(t.downloadClients).where(eq(t.downloadClients.name, 'qBit')).get()!;
    expect(jackett).toMatchObject({ implementation: 'torznab', enableRss: false, priority: 50, downloadClientId: qbit.id });
    expect(jackett.settings).toMatchObject({ apiKey: 'jk', minimumSeeders: 5, seedRatio: 1.5, seedTime: 3_600_000, categories: [5000] });
    expect(qbit.settings).toMatchObject({ host: 'qbit', username: 'admin', password: 'secret', category: 'tv-sonarr', recentPriority: 'first', initialState: 'pause', contentLayout: 'subfolder' });
    const sab = db.select().from(t.downloadClients).where(eq(t.downloadClients.name, 'SAB')).get()!;
    expect(sab).toMatchObject({ implementation: 'sabnzbd', protocol: 'usenet' });
    const delay = db.select().from(t.delayProfiles).all();
    expect(delay).toHaveLength(2);
    expect(delay.find((d) => d.tags.length === 0)).toMatchObject({ preferredProtocol: 'torrent', usenetDelayMinutes: 60, bypassIfHighestQuality: true });
    const release = db.select().from(t.releaseProfiles).get()!;
    expect(release).toMatchObject({ name: 'No CAM', ignored: ['cam', 'telesync'], indexerId: jackett.id });
    const notif = db.select().from(t.notifications).all();
    expect(notif.map((n) => n.name)).toEqual(['Discord']);
    expect(notif[0]).toMatchObject({ implementation: 'discord', onGrab: true, onDownload: true, onSeriesDelete: true, onFileDelete: true, onRename: false });
    const list = db.select().from(t.importLists).get()!;
    expect(list).toMatchObject({ name: 'IMDb List', implementation: 'imdbList', rootFolderPath: join(tmp, 'tv'), mediaType: 'series' });
    expect(result.warnings.some((w) => w.area === 'delayProfiles' && /disables torrent/.test(w.message))).toBe(true);
  });

  it('remaps root folders and remote path mappings and stages unsupported download clients', async () => {
    await service.apply(sonarrSource());
    expect(db.select().from(t.rootFolders).all()).toEqual([{ id: 1, path: join(tmp, 'tv'), mediaType: 'series' }]);
    const mapping = db.select().from(t.remotePathMappings).get()!;
    expect(mapping.host).toBe('qbit');
    expect(mapping.remotePath).toBe('/downloads/');
    expect(mapping.localPath.replace(/[\\/]+$/, '')).toBe(join(tmp, 'data', 'downloads'));
    const bh = staged('downloadClients.unsupported');
    expect(bh).toHaveLength(1);
    expect(bh[0]!.payload).toMatchObject({ upstreamImplementation: 'TorrentBlackhole', directory: '/bh' });
  });

  it('carries over naming and media management settings', async () => {
    await service.apply(sonarrSource());
    const naming = getSection(db, 'naming');
    expect(naming).toMatchObject({ renameEpisodes: true, multiEpisodeStyle: 'range', colonReplacement: 'dash', seasonFolderFormat: 'Season {season:00}', seriesFolderFormat: '{Series TitleYear}' });
    expect(naming.standardEpisodeFormat).toBe('{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}');
    expect(naming.movieFormat).toBe('{Movie Title} ({Release Year}) {Quality Full}');
    const mm = getSection(db, 'mediaManagement');
    expect(mm).toMatchObject({ recycleBinPath: join(tmp, 'data', 'recycle'), recycleBinCleanupDays: 14, useHardlinks: false, episodeTitleRequired: 'bulkSeasonReleases', extraFileExtensions: ['srt', 'nfo'] });
  });

  it('links grab/import history and the blocklist to the imported episodes', async () => {
    const result = await service.apply(sonarrSource());
    expect(area(result, 'history')).toMatchObject({ created: 2, skipped: 1 });
    const bb = db.select().from(t.series).where(eq(t.series.tmdbId, 1396)).get()!;
    const pilot = db.select().from(t.episodes).where(eq(t.episodes.seriesId, bb.id)).all().find((e) => e.seasonNumber === 1 && e.episodeNumber === 1)!;
    const history = db.select().from(t.history).all();
    expect(history.map((h) => h.eventType).sort()).toEqual(['downloadFolderImported', 'grabbed']);
    expect(history.find((h) => h.eventType === 'grabbed')).toMatchObject({ seriesId: bb.id, episodeId: pilot.id, downloadId: 'HASH1', date: '2021-02-03T03:00:00.000Z', data: { indexer: 'NZBgeek', downloadClient: 'qBit' } });
    const ep3 = db.select().from(t.episodes).where(eq(t.episodes.seriesId, bb.id)).all().find((e) => e.episodeNumber === 3)!;
    const block = db.select().from(t.blocklist).get()!;
    expect(block).toMatchObject({ seriesId: bb.id, episodeIds: [ep3.id], protocol: 'torrent', torrentInfoHash: 'abcdef', indexerFlags: ['freeleech', 'scene'], releaseType: 'single' });
  });

  it('dry run reports results but writes nothing', async () => {
    const result = await service.apply(sonarrSource(), { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(area(result, 'series').created).toBe(2);
    expect(area(result, 'history').created).toBe(2);
    expect(db.select().from(t.series).all()).toHaveLength(0);
    expect(db.select().from(t.tags).all()).toHaveLength(0);
    expect(db.select().from(migrateImported).all()).toHaveLength(0);
    expect(db.select().from(migrateStaging).all()).toHaveLength(0);
  });

  it('imports only the selected areas', async () => {
    const result = await service.apply(sonarrSource(), { areas: ['tags', 'customFormats'] });
    expect(result.areas.map((a) => a.area)).toEqual(['tags', 'customFormats']);
    expect(db.select().from(t.customFormats).all()).toHaveLength(2);
    expect(db.select().from(t.series).all()).toHaveLength(0);
  });

  it('resolves references to areas imported in an earlier run', async () => {
    const src = sonarrSource();
    await service.apply(src, { areas: ['tags', 'rootFolders', 'customFormats', 'qualityProfiles'] });
    await service.apply(src, { areas: ['series'] });
    const profile = db.select().from(t.qualityProfiles).where(eq(t.qualityProfiles.name, 'HD-1080p')).get()!;
    expect(db.select().from(t.series).where(eq(t.series.tmdbId, 1396)).get()!.qualityProfileId).toBe(profile.id);
  });
});

describe('conflict policies', () => {
  function seedExisting() {
    const profiles = new ProfilesService({ db });
    const existing = profiles.createQualityProfile({ ...profiles.qualityProfileTemplate(), name: 'HD-1080p', upgradeAllowed: false, cutoff: 1, items: [{ kind: 'quality', qualityId: 1, allowed: true }] });
    db.insert(t.rootFolders).values({ path: join(tmp, 'tv'), mediaType: 'series' }).run();
    const series = db
      .insert(t.series)
      .values({
        tmdbId: 1396,
        title: 'Breaking Bad',
        sortTitle: 'breaking bad',
        cleanTitle: 'breakingbad',
        year: 2008,
        status: 'ended',
        genres: [],
        images: [],
        ratings: {},
        originalLanguage: 'en',
        path: join(tmp, 'tv', 'BB'),
        rootFolderPath: join(tmp, 'tv'),
        qualityProfileId: existing.id,
        monitored: false,
        tags: [],
        added: '2019-01-01T00:00:00.000Z',
      })
      .returning()
      .get();
    db.insert(t.episodes).values({ seriesId: series.id, seasonNumber: 1, episodeNumber: 1, title: 'Mine', monitored: false }).run();
    return { existing, series };
  }

  it('skip keeps existing rows untouched and maps references onto them', async () => {
    const { existing, series } = seedExisting();
    const result = await service.apply(sonarrSource(), { conflictPolicy: 'skip' });
    expect(area(result, 'qualityProfiles')).toMatchObject({ created: 1, skipped: 1 });
    expect(area(result, 'series')).toMatchObject({ created: 1, skipped: 2 });
    expect(db.select().from(t.qualityProfiles).where(eq(t.qualityProfiles.id, existing.id)).get()).toMatchObject({ upgradeAllowed: false, cutoff: 1 });
    const kept = db.select().from(t.series).where(eq(t.series.id, series.id)).get()!;
    expect(kept).toMatchObject({ path: join(tmp, 'tv', 'BB'), monitored: false });
    expect(db.select().from(t.episodes).where(eq(t.episodes.seriesId, series.id)).all()).toHaveLength(1);
    // The skipped profile still serves as the target of references (the anime series uses profile 2 "Any").
    expect(db.select().from(t.rootFolders).all()).toHaveLength(1);
  });

  it('overwrite updates the colliding rows and adds what is missing, never deleting', async () => {
    const { existing, series } = seedExisting();
    const result = await service.apply(sonarrSource(), { conflictPolicy: 'overwrite' });
    expect(area(result, 'qualityProfiles')).toMatchObject({ created: 1, updated: 1 });
    expect(area(result, 'series')).toMatchObject({ created: 1, updated: 1 });
    expect(db.select().from(t.qualityProfiles).where(eq(t.qualityProfiles.id, existing.id)).get()).toMatchObject({ upgradeAllowed: true, cutoff: 1000 });
    const updated = db.select().from(t.series).where(eq(t.series.id, series.id)).get()!;
    expect(updated).toMatchObject({ path: join(tmp, 'tv', 'Breaking Bad'), monitored: true, qualityProfileId: existing.id });
    const eps = db.select().from(t.episodes).where(eq(t.episodes.seriesId, series.id)).all();
    expect(eps).toHaveLength(4);
    expect(eps.find((e) => e.seasonNumber === 1 && e.episodeNumber === 1)).toMatchObject({ title: 'Mine', monitored: true, hasFile: true });
    expect(db.select().from(t.series).all()).toHaveLength(2);
  });
});

describe('Radarr', () => {
  it('imports movies from MovieMetadata with their file and stages collections', async () => {
    const result = await service.apply(radarrSource());
    expect(area(result, 'movies')).toMatchObject({ created: 1, skipped: 1 });
    const movie = db.select().from(t.movies).get()!;
    expect(movie).toMatchObject({
      tmdbId: 603,
      imdbId: 'tt0133093',
      title: 'The Matrix',
      year: 1999,
      status: 'released',
      studio: 'Warner Bros.',
      inCinemas: '1999-03-30',
      minimumAvailability: 'inCinemas',
      path: join(tmp, 'movies', 'The Matrix (1999)'),
      collection: { tmdbId: 2344, title: 'The Matrix Collection' },
      ratings: { imdb: { votes: 100, value: 8.7 }, tmdb: { votes: 50, value: 8.2 } },
      hasFile: true,
    });
    const file = db.select().from(t.mediaFiles).get()!;
    expect(movie.movieFileId).toBe(file.id);
    expect(file).toMatchObject({ mediaType: 'movie', movieId: movie.id, edition: "Director's Cut", languages: ['en', 'hi'], releaseGroup: 'FGT' });
    expect(file.quality.quality.name).toBe('Remux-1080p');
    expect(staged('library.collections')).toHaveLength(1);
    expect(db.select().from(t.history).get()).toMatchObject({ mediaType: 'movie', movieId: movie.id, eventType: 'grabbed' });
    expect(getSection(db, 'naming')).toMatchObject({ renameMovies: true, colonReplacement: 'smart', movieFormat: '{Movie Title} ({Release Year}) {edition-{Edition Tags}} {Quality Full}' });
    const profile = db.select().from(t.qualityProfiles).where(eq(t.qualityProfiles.name, 'HD-1080p')).get()!;
    expect(profile.languages).toEqual(['en']);
  });

  it('tolerates the pre-MovieMetadata schema', async () => {
    const result = await service.apply(radarrSource(true), { areas: ['qualityProfiles', 'movies'] });
    expect(area(result, 'movies')).toMatchObject({ created: 1, failed: 0 });
    // MovieFileId is 0 in that schema; the file is found through MovieFiles.MovieId.
    expect(db.select().from(t.movies).get()).toMatchObject({ tmdbId: 603, title: 'The Matrix', hasFile: true });
  });
});

describe('Prowlarr', () => {
  it('maps Cardigann to Arclight definitions, imports Torznab/Newznab directly, proxies the rest and imports proxies', async () => {
    const dbPath = join(tmp, 'prowlarr', 'prowlarr.db');
    const configPath = join(tmp, 'prowlarr', 'config.xml');
    makeProwlarrDb(dbPath, configPath);
    const plan = await service.plan({ app: 'prowlarr', dbPath, configPath });
    expect(plan.areas.find((a) => a.area === 'applications')).toMatchObject({ mode: 'report', total: 1, create: 0 });
    expect(plan.areas.find((a) => a.area === 'indexers')).toMatchObject({ details: { definitions: 1, proxied: 1 } });
    const result = await service.apply({ app: 'prowlarr', dbPath, configPath });
    expect(area(result, 'indexers')).toMatchObject({ created: 3 });
    expect(area(result, 'indexerProxies')).toMatchObject({ created: 1 });
    expect(area(result, 'applications')).toMatchObject({ created: 0, skipped: 1 });
    const rows = db.select().from(t.indexers).all();
    const leet = rows.find((r) => r.name === '1337x')!;
    expect(leet).toMatchObject({ implementation: 'definition' });
    // Prowlarr stores the select as the option's index (2 = third option).
    expect(leet.settings).toMatchObject({ definitionId: '1337x', baseUrl: 'https://1337x.to/', fields: { sort: 'size' } });
    const privateTag = db.select().from(t.tags).get()!;
    expect(leet.tags).toEqual([privateTag.id]);
    expect(rows.find((r) => r.name === 'My Newznab')).toMatchObject({ implementation: 'newznab', priority: 5 });
    const nzbIndex = rows.find((r) => r.name === 'NZBIndex')!;
    expect(nzbIndex).toMatchObject({ implementation: 'newznab', enableRss: false });
    expect(nzbIndex.settings).toMatchObject({ baseUrl: 'http://localhost:9696/3', apiPath: '/api', apiKey: 'prowlarr-key' });
    const proxy = db.select().from(t.indexerProxies).get()!;
    expect(proxy).toMatchObject({ name: 'Flare', type: 'flaresolverr', host: 'http://flaresolverr', port: 8191, requestTimeout: 60, tags: [privateTag.id] });
    expect(result.warnings.some((w) => /NZBIndex.*must keep running/.test(w.message))).toBe(true);
  });
});

describe('background job status', () => {
  it('runs the queued import inline without a scheduler and reports progress and log', async () => {
    const src = sonarrSource();
    const status = service.start({ source: src, areas: ['tags', 'series'] });
    expect(status.state).toBe('running');
    expect(() => service.start({ source: src })).toThrowError(/already running/);
    await new Promise((r) => setTimeout(r, 50));
    const done = service.status();
    expect(done.state).toBe('completed');
    expect(done.result?.areas.map((a) => a.area)).toEqual(['tags', 'series']);
    expect(done.log.some((l) => /Import finished/.test(l.message))).toBe(true);
    expect(done.log.length).toBeGreaterThan(2);
  });

  it('records a failed run when the source is unreadable', async () => {
    const bad = join(tmp, 'bad.db');
    writeFileSync(bad, 'this is not sqlite');
    service.start({ source: { app: 'sonarr', dbPath: bad } });
    await new Promise((r) => setTimeout(r, 20));
    expect(service.status()).toMatchObject({ state: 'failed' });
    expect(service.status().error).toMatch(/cannot open/);
  });
});
