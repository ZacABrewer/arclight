import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryListQuery, type HistoryListQueryInput, type ServerEvent } from '@media-tron/shared';
import { episodes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { historyRoutes } from './routes.js';
import { dataValue, HistoryError, normalizeData, type GrabbedRelease, type HistoryTarget } from './service.js';
import { quality, setup, type Fixture } from './test-support.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let f: Fixture;

beforeEach(async () => {
  f = await setup();
});

function torrent(overrides: Partial<GrabbedRelease> = {}): GrabbedRelease {
  return {
    title: 'Zeta.Show.S01E01.1080p.WEB-DL-GRP',
    protocol: 'torrent',
    guid: 'guid-1',
    indexerName: 'Tracker1',
    indexerId: 7,
    infoUrl: 'https://tracker1.invalid/details/1',
    downloadUrl: 'https://tracker1.invalid/dl/1.torrent',
    size: 2_000_000_000,
    publishDate: '2025-01-09T12:00:00.000Z',
    infoHash: 'abcdef0123456789',
    indexerFlags: ['freeleech'],
    ...overrides,
  };
}

function tv(...episodeIds: number[]): HistoryTarget {
  return { mediaType: 'series', seriesId: f.seriesId, episodeIds };
}

function movie(id = f.movieId): HistoryTarget {
  return { mediaType: 'movie', movieId: id };
}

function grab(target: HistoryTarget, downloadId: string | null = 'HASH1', release = torrent(), q = quality('WEBDL-1080p')) {
  return f.history.recordGrab(
    release,
    { target, quality: q, languages: ['en'], releaseGroup: 'GRP', customFormatScore: 25, releaseSource: 'rss', releaseType: 'singleEpisode', matchType: 'title' },
    downloadId,
    { name: 'My qBit', implementation: 'qbittorrent' },
  );
}

const query = (input: HistoryListQueryInput = {}) => HistoryListQuery.parse(input);

// ---------------------------------------------------------------------------------------

describe('data map helpers', () => {
  it('normalises keys to camelCase, drops empties and reads case-insensitively', () => {
    const data = normalizeData({ Indexer: 'X', NzbInfoUrl: 'u', Size: 10, Empty: '', Missing: undefined });
    expect(data).toEqual({ indexer: 'X', nzbInfoUrl: 'u', size: '10' });
    expect(dataValue(data, 'Indexer')).toBe('X');
    expect(dataValue(data, 'INDEXER')).toBe('X');
    expect(dataValue(data, 'nzbinfourl')).toBe('u');
    expect(dataValue(data, 'nope')).toBeUndefined();
  });
});

describe('recording events', () => {
  it('records a grab with one row per episode and the spec data keys', () => {
    const rows = grab(tv(f.ep.s1e1, f.ep.s1e2));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.episodeId)).toEqual([f.ep.s1e1, f.ep.s1e2]);
    const [r] = rows;
    expect(r).toMatchObject({
      eventType: 'grabbed',
      mediaType: 'series',
      seriesId: f.seriesId,
      movieId: null,
      sourceTitle: 'Zeta.Show.S01E01.1080p.WEB-DL-GRP',
      downloadId: 'HASH1',
      languages: ['en'],
      customFormatScore: 25,
      date: '2025-01-10T12:00:00.000Z',
    });
    expect(r!.quality.quality.name).toBe('WEBDL-1080p');
    expect(r!.data).toMatchObject({
      indexer: 'Tracker1',
      indexerId: '7',
      nzbInfoUrl: 'https://tracker1.invalid/details/1',
      releaseGroup: 'GRP',
      age: '1',
      ageHours: '24',
      publishedDate: '2025-01-09T12:00:00Z',
      downloadClient: 'qbittorrent',
      downloadClientName: 'My qBit',
      size: '2000000000',
      guid: 'guid-1',
      protocol: 'torrent',
      customFormatScore: '25',
      releaseSource: 'rss',
      indexerFlags: 'freeleech',
      torrentInfoHash: 'abcdef0123456789',
      releaseType: 'singleEpisode',
      seriesMatchType: 'title',
    });
    expect(f.history.get(r!.id)).toEqual(r);
  });

  it('records a movie grab as one row without a torrent hash for usenet', () => {
    const rows = grab(movie(), 'nzo_1', torrent({ protocol: 'usenet', infoHash: undefined as never, title: 'Movie.2021.1080p.BluRay-GRP' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mediaType: 'movie', movieId: f.movieId, seriesId: null, episodeId: null });
    expect(rows[0]!.data.torrentInfoHash).toBeUndefined();
    expect(rows[0]!.data.movieMatchType).toBe('title');
    expect(rows[0]!.data.releaseType).toBeUndefined();
  });

  it('stores a null download id when the client returns none', () => {
    const [row] = grab(movie(), '  ');
    expect(row!.downloadId).toBeNull();
  });

  it('records an import with the scene name, or the dropped file base name', () => {
    const [withScene] = f.history.recordImport({
      target: movie(),
      quality: quality('Bluray-1080p'),
      languages: ['en'],
      sceneName: 'Movie.2021.1080p.BluRay-GRP',
      droppedPath: '/downloads/Movie/movie.mkv',
      importedPath: '/movies/Movie (2021)/Movie (2021).mkv',
      fileId: 12,
      downloadId: 'HASH9',
      downloadClient: 'qbittorrent',
      releaseGroup: 'GRP',
      size: 123,
    });
    expect(withScene).toMatchObject({ eventType: 'downloadFolderImported', sourceTitle: 'Movie.2021.1080p.BluRay-GRP', downloadId: 'HASH9' });
    expect(withScene!.data).toMatchObject({
      fileId: '12',
      droppedPath: '/downloads/Movie/movie.mkv',
      importedPath: '/movies/Movie (2021)/Movie (2021).mkv',
      downloadClient: 'qbittorrent',
      size: '123',
    });

    const [noScene] = f.history.recordImport({
      target: tv(f.ep.s1e3),
      quality: quality('HDTV-720p'),
      languages: [],
      droppedPath: '/downloads/x/Zeta.Show.S01E03.720p.HDTV.mkv',
      importedPath: '/tv/Zeta Show/Season 1/e3.mkv',
    });
    expect(noScene!.sourceTitle).toBe('Zeta.Show.S01E03.720p.HDTV');
    expect(noScene!.downloadId).toBeNull();
  });

  it('fills a missing import download id from a still-downloading grab (spec 1.5.2)', () => {
    grab(tv(f.ep.s1e1), 'A');
    const [row] = f.history.recordImport({
      target: tv(f.ep.s1e1),
      quality: quality('WEBDL-1080p'),
      languages: ['en'],
      droppedPath: '/d/a.mkv',
      importedPath: '/tv/a.mkv',
    });
    expect(row!.downloadId).toBe('A');
    // A is now processed: a second import finds nothing still downloading.
    expect(f.history.findDownloadIdForImport(tv(f.ep.s1e1), quality('WEBDL-1080p'))).toBeNull();
  });

  it('leaves the import download id blank when ambiguous or the quality differs', () => {
    grab(tv(f.ep.s1e1), 'A');
    grab(tv(f.ep.s1e1), 'B');
    expect(f.history.findDownloadIdForImport(tv(f.ep.s1e1), quality('WEBDL-1080p'))).toBeNull();
    expect(f.history.findDownloadIdForImport(tv(f.ep.s1e2), quality('WEBDL-1080p'))).toBeNull();
    grab(movie(), 'M1');
    expect(f.history.findDownloadIdForImport(movie(), quality('WEBDL-720p'))).toBeNull();
    expect(f.history.findDownloadIdForImport(movie(), quality('WEBDL-1080p'))).toBe('M1');
  });

  it('records file deletions and suppresses NoLinkedEpisodes / ManualOverride', () => {
    const base = { target: tv(f.ep.s1e1, f.ep.s1e2), path: '/tv/Zeta Show/Season 1/e1.mkv', quality: quality('WEBDL-1080p'), languages: ['en'] };
    const rows = f.history.recordFileDeleted({ ...base, reason: 'Upgrade', releaseGroup: 'GRP', size: 5, releaseType: 'multiEpisode' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ eventType: 'fileDeleted', sourceTitle: base.path, downloadId: null });
    expect(rows[0]!.data).toEqual({ reason: 'Upgrade', releaseGroup: 'GRP', size: '5', releaseType: 'multiEpisode' });
    expect(f.history.recordFileDeleted({ ...base, reason: 'NoLinkedEpisodes' })).toEqual([]);
    expect(f.history.recordFileDeleted({ ...base, reason: 'ManualOverride' })).toEqual([]);
  });

  it('records a rename with old and new paths', () => {
    const [row] = f.history.recordRenamed({
      target: movie(),
      sourcePath: '/movies/Movie/old.mkv',
      sourceRelativePath: 'old.mkv',
      path: '/movies/Movie/Movie (2021).mkv',
      relativePath: 'Movie (2021).mkv',
      quality: quality('Bluray-1080p'),
      languages: ['en'],
      indexerFlags: ['freeleech', 'internal'],
    });
    expect(row).toMatchObject({ eventType: 'fileRenamed', sourceTitle: '/movies/Movie/old.mkv', downloadId: null });
    expect(row!.data).toEqual({
      sourcePath: '/movies/Movie/old.mkv',
      sourceRelativePath: 'old.mkv',
      path: '/movies/Movie/Movie (2021).mkv',
      relativePath: 'Movie (2021).mkv',
      indexerFlags: 'freeleech,internal',
    });
  });

  it('records ignored downloads and refuses unmatched series downloads', () => {
    const rows = f.history.recordIgnored({
      target: tv(f.ep.s1e1),
      sourceTitle: 'Zeta.Show.S01E01',
      quality: quality('WEBDL-1080p'),
      languages: ['en'],
      downloadId: 'HASH5',
      downloadClient: 'qbittorrent',
      downloadClientName: 'My qBit',
      size: 99,
      indexer: 'Tracker1',
    });
    expect(rows[0]).toMatchObject({ eventType: 'downloadIgnored', downloadId: 'HASH5' });
    expect(rows[0]!.data).toMatchObject({ message: 'Manually ignored', downloadClientName: 'My qBit', indexer: 'Tracker1', size: '99' });
    expect(
      f.history.recordIgnored({ target: tv(), sourceTitle: 'x', quality: quality('SDTV'), languages: [], downloadId: 'Z' }),
    ).toEqual([]);
  });

  it('publishes one history bus event per record call', () => {
    const events: ServerEvent[] = [];
    f.bus.subscribe((e) => events.push(e));
    grab(tv(f.ep.s1e1, f.ep.s1e2));
    f.history.recordFileDeleted({ target: movie(), path: '/x', quality: quality('SDTV'), languages: [], reason: 'NoLinkedEpisodes' });
    expect(events).toEqual([{ type: 'history', action: 'added' }]);
  });
});

describe('failed downloads', () => {
  it('writes failed rows from the grabbed rows, preferring live tracked values, and blocklists', async () => {
    grab(tv(f.ep.s1e1, f.ep.s1e2), 'HASH1');
    f.clock.advance(HOUR);
    const rows = await f.history.failTracked(
      { downloadId: 'HASH1', protocol: 'torrent', downloadClientName: 'Live qBit', sizeBytes: 1_999 },
      { message: 'Disk full', source: 'Media-Tron Failed Download Handling' },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ eventType: 'downloadFailed', downloadId: 'HASH1', sourceTitle: 'Zeta.Show.S01E01.1080p.WEB-DL-GRP' });
    expect(rows[0]!.data).toEqual({
      downloadClient: 'qbittorrent',
      downloadClientName: 'Live qBit',
      message: 'Disk full',
      releaseGroup: 'GRP',
      size: '1999',
      indexer: 'Tracker1',
      source: 'Media-Tron Failed Download Handling',
    });
    const bl = f.blocklist.forSeries(f.seriesId);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatchObject({
      episodeIds: [f.ep.s1e1, f.ep.s1e2],
      torrentInfoHash: 'hash1',
      indexer: 'Tracker1',
      protocol: 'torrent',
      message: 'Disk full',
      size: 2_000_000_000,
      publishedDate: '2025-01-09T12:00:00.000Z',
      indexerFlags: ['freeleech'],
      releaseType: 'singleEpisode',
      source: 'Media-Tron Failed Download Handling',
    });
  });

  it('refuses to fail a tracked download that was never grabbed', async () => {
    await expect(f.history.failTracked({ downloadId: 'nope' })).rejects.toMatchObject({ code: 'NOT_GRABBED' });
  });

  it('marks a grabbed row failed, covering every grabbed row of the download, and calls the hooks', async () => {
    const grabbed = grab(tv(f.ep.s1e1, f.ep.s1e2), 'PACK');
    const order: string[] = [];
    f.history.onDownloadFailed(() => void order.push('redownload'), 100);
    f.history.onDownloadFailed(() => void order.push('early'));
    let hookEvent: unknown;
    f.history.setOnMarkFailed((event) => {
      order.push('markFailedHook');
      hookEvent = event;
    });
    const rows = await f.history.markFailed(grabbed[0]!.id, { skipRedownload: true });
    expect(rows.map((r) => r.episodeId).sort()).toEqual([f.ep.s1e1, f.ep.s1e2].sort());
    expect(rows[0]!.data.message).toBe('Manually marked as failed');
    expect(rows[0]!.data.downloadClientName).toBeUndefined();
    expect(order).toEqual(['early', 'redownload', 'markFailedHook']);
    expect(hookEvent).toMatchObject({ skipRedownload: true, releaseSource: 'rss', downloadId: 'PACK' });
  });

  it('marks a grabbed row without download id failed but rejects other rows without one', async () => {
    const [g] = grab(movie(), null);
    const rows = await f.history.markFailed(g!.id);
    expect(rows).toHaveLength(1);
    const [renamed] = f.history.recordRenamed({ target: movie(), sourcePath: '/a', path: '/b', quality: quality('SDTV'), languages: [] });
    await expect(f.history.markFailed(renamed!.id)).rejects.toThrow(/was not grabbed and has no download ID/);
    await expect(f.history.markFailed(99_999)).rejects.toBeInstanceOf(HistoryError);
  });
});

describe('look-ups', () => {
  it('finds rows by download id newest first and filters by type', () => {
    grab(tv(f.ep.s1e1), 'D1');
    f.clock.advance(HOUR);
    f.history.recordImport({ target: tv(f.ep.s1e1), quality: quality('WEBDL-1080p'), languages: [], droppedPath: '/d/a.mkv', importedPath: '/t/a.mkv', downloadId: 'D1' });
    const all = f.history.findByDownloadId('D1');
    expect(all.map((r) => r.eventType)).toEqual(['downloadFolderImported', 'grabbed']);
    expect(f.history.findByDownloadId('D1', 'grabbed')).toHaveLength(1);
    expect(f.history.mostRecentForDownloadId('D1')!.eventType).toBe('downloadFolderImported');
    expect(f.history.findByDownloadId('none')).toEqual([]);
  });

  it('returns the most recent row for an episode or movie with id tie-break', () => {
    expect(f.history.mostRecentForEpisode(f.ep.s1e1)).toBeNull();
    grab(tv(f.ep.s1e1), 'X');
    const second = grab(tv(f.ep.s1e1), 'Y'); // same instant
    expect(f.history.mostRecentForEpisode(f.ep.s1e1)!.id).toBe(second[0]!.id);
    grab(movie(), 'M');
    f.clock.advance(1000);
    f.history.recordRenamed({ target: movie(), sourcePath: '/a', path: '/b', quality: quality('SDTV'), languages: [] });
    expect(f.history.mostRecentForMovie(f.movieId)!.eventType).toBe('fileRenamed');
    expect(f.history.mostRecentForMovie(f.movieId, 'grabbed')!.downloadId).toBe('M');
    expect(f.history.forItem({ movieId: f.movieId })).toHaveLength(2);
  });

  it('wasGrabbed matches on torrent hash regardless of indexer, via download id or data', () => {
    grab(tv(f.ep.s1e1), 'ABCDEF0123456789');
    expect(f.history.wasGrabbed({ torrentInfoHash: 'abcdef0123456789' })).not.toBeNull();
    grab(movie(), 'other-id', torrent({ infoHash: 'FFEE' }));
    expect(f.history.wasGrabbed({ torrentInfoHash: 'ffee' })?.movieId).toBe(f.movieId);
    expect(f.history.wasGrabbed({ torrentInfoHash: '0000' })).toBeNull();
    expect(f.history.wasGrabbed({})).toBeNull();
  });

  it('wasGrabbed matches guid + indexer (case-insensitive) within the day window', () => {
    grab(tv(f.ep.s1e1), 'H', torrent({ guid: 'g-42', indexerName: 'Tracker1', infoHash: undefined as never }));
    expect(f.history.wasGrabbed({ guid: 'g-42', indexer: 'tracker1' })).not.toBeNull();
    expect(f.history.wasGrabbed({ guid: 'g-42', indexer: 'Tracker2' })).toBeNull();
    expect(f.history.wasGrabbed({ guid: 'g-43', indexer: 'Tracker1' })).toBeNull();
    f.clock.advance(3 * DAY);
    expect(f.history.wasGrabbed({ guid: 'g-42', indexer: 'Tracker1' }, { withinDays: 7 })).not.toBeNull();
    expect(f.history.wasGrabbed({ guid: 'g-42', indexer: 'Tracker1' }, { withinDays: 2 })).toBeNull();
    expect(f.history.wasGrabbed({ guid: 'g-42' }, { seriesId: f.otherSeriesId })).toBeNull();
  });

  it('grabImportPair pairs the newest grab with an import of the same download id', () => {
    expect(f.history.grabImportPair({ episodeId: f.ep.s1e1 })).toBeNull();
    grab(tv(f.ep.s1e1), 'D1');
    expect(f.history.grabImportPair({ episodeId: f.ep.s1e1 })).toBeNull();
    f.history.recordImport({ target: tv(f.ep.s1e1), quality: quality('WEBDL-720p'), languages: [], droppedPath: '/d/a.mkv', importedPath: '/t/a.mkv', downloadId: 'D1' });
    const pair = f.history.grabImportPair({ episodeId: f.ep.s1e1 });
    expect(pair?.grabbed.quality.quality.name).toBe('WEBDL-1080p');
    expect(pair?.imported.quality.quality.name).toBe('WEBDL-720p');
  });

  it('lists series history by season and event type, and movie history', () => {
    grab(tv(f.ep.s1e1, f.ep.s2e1), 'P');
    f.history.recordRenamed({ target: tv(f.ep.s2e2), sourcePath: '/a', path: '/b', quality: quality('SDTV'), languages: [] });
    grab(movie(), 'M');
    expect(f.history.forSeries(f.seriesId)).toHaveLength(3);
    expect(f.history.forSeries(f.seriesId, { seasonNumber: 2 }).map((r) => r.episodeId).sort()).toEqual([f.ep.s2e1, f.ep.s2e2].sort());
    expect(f.history.forSeries(f.seriesId, { seasonNumber: 2, eventType: 'grabbed' })).toHaveLength(1);
    const withEmbeds = f.history.forSeries(f.seriesId, { seasonNumber: 1, includeSeries: true, includeEpisode: true });
    expect(withEmbeds[0]!.series).toMatchObject({ id: f.seriesId, title: 'Zeta Show' });
    expect(withEmbeds[0]!.episode).toMatchObject({ seasonNumber: 1, episodeNumber: 1 });
    expect(f.history.forMovie(f.movieId, { includeMovie: true })[0]!.movie).toMatchObject({ title: 'Movie' });
  });

  it('since() returns rows at or after a date, oldest first', () => {
    grab(movie(), 'A');
    f.clock.advance(HOUR);
    const cut = f.clock.now().toISOString();
    grab(movie(), 'B');
    f.clock.advance(HOUR);
    f.history.recordRenamed({ target: movie(), sourcePath: '/a', path: '/b', quality: quality('SDTV'), languages: [] });
    expect(f.history.since(cut).map((r) => r.downloadId ?? r.eventType)).toEqual(['B', 'fileRenamed']);
    expect(f.history.since(cut, 'grabbed')).toHaveLength(1);
    expect(() => f.history.since('garbage')).toThrow(HistoryError);
  });
});

describe('paged list', () => {
  beforeEach(() => {
    grab(tv(f.ep.s1e1), 'T1', torrent({ title: 'b-title' }), quality('HDTV-720p'));
    f.clock.advance(HOUR);
    grab(movie(), 'M1', torrent({ title: 'a-title' }), quality('Bluray-2160p'));
    f.clock.advance(HOUR);
    grab({ mediaType: 'series', seriesId: f.otherSeriesId, episodeIds: [] }, 'O1', torrent({ title: 'c-title' }), quality('SDTV'));
    f.clock.advance(HOUR);
    f.history.recordImport({
      target: movie(f.otherMovieId),
      quality: quality('WEBDL-1080p'),
      languages: ['fr'],
      droppedPath: '/d/d-title.mkv',
      importedPath: '/m/x.mkv',
      downloadId: 'M2',
    });
  });

  it('defaults to date descending with paging', () => {
    const page1 = f.history.list(query({ pageSize: 3 }));
    expect(page1.totalRecords).toBe(4);
    expect(page1.records.map((r) => r.sourceTitle)).toEqual(['d-title', 'c-title', 'a-title']);
    const page2 = f.history.list(query({ pageSize: 3, page: 2 }));
    expect(page2.records.map((r) => r.sourceTitle)).toEqual(['b-title']);
  });

  it('sorts by source title, parent title and quality', () => {
    const titles = (q: HistoryListQueryInput) => f.history.list(query(q)).records.map((r) => r.sourceTitle);
    expect(titles({ sortKey: 'sourceTitle', sortDirection: 'asc' })).toEqual(['a-title', 'b-title', 'c-title', 'd-title']);
    // Parent sort titles: alpha show (c), beta movie (d), movie (a), zeta show (b).
    expect(titles({ sortKey: 'title', sortDirection: 'asc' })).toEqual(['c-title', 'd-title', 'a-title', 'b-title']);
    expect(titles({ sortKey: 'quality', sortDirection: 'desc' })).toEqual(['a-title', 'd-title', 'b-title', 'c-title']);
  });

  it('filters by event type, parent ids, download id, quality and language', () => {
    const count = (q: HistoryListQueryInput) => f.history.list(query(q)).totalRecords;
    expect(count({ eventType: 'grabbed' })).toBe(3);
    expect(count({ eventType: 'grabbed,downloadFolderImported' })).toBe(4);
    expect(count({ seriesId: `${f.seriesId},${f.otherSeriesId}` })).toBe(2);
    expect(count({ movieId: String(f.movieId) })).toBe(1);
    expect(count({ episodeId: f.ep.s1e1 })).toBe(1);
    expect(count({ downloadId: 'M2' })).toBe(1);
    expect(count({ mediaType: 'movie' })).toBe(2);
    expect(count({ quality: '3,19' })).toBe(1); // WEBDL-1080p only (id 3); 19 unused
    expect(count({ language: 'fr' })).toBe(1);
    expect(count({ language: 'de' })).toBe(0);
  });

  it('embeds parent and episode summaries on request', () => {
    const page = f.history.list(query({ includeSeries: true, includeEpisode: true, includeMovie: true }));
    const tvRow = page.records.find((r) => r.downloadId === 'T1')!;
    expect(tvRow.series?.title).toBe('Zeta Show');
    expect(tvRow.episode?.episodeNumber).toBe(1);
    expect(page.records.find((r) => r.downloadId === 'M1')!.movie?.title).toBe('Movie');
    expect(f.history.list(query()).records[0]!.movie).toBeUndefined();
  });
});

describe('cleanup', () => {
  it('keeps everything by default but removes orphans', () => {
    grab(tv(f.ep.s1e1, f.ep.s1e2), 'A');
    grab({ mediaType: 'movie', movieId: 9_999 }, 'GONE');
    f.db.delete(episodes).where(eq(episodes.id, f.ep.s1e2)).run();
    f.clock.advance(1000 * DAY);
    expect(f.history.cleanup()).toEqual({ orphaned: 2, expired: 0 });
    expect(f.history.list(query()).totalRecords).toBe(1);
  });

  it('applies a configured retention period', () => {
    grab(movie(), 'OLD');
    f.clock.advance(40 * DAY);
    grab(movie(), 'NEW');
    f.history.retentionDays = 30;
    expect(f.history.cleanup().expired).toBe(1);
    expect(f.history.forMovie(f.movieId).map((r) => r.downloadId)).toEqual(['NEW']);
  });

  it('deletes all rows of a deleted parent', () => {
    grab(tv(f.ep.s1e1), 'A');
    grab(movie(), 'B');
    expect(f.history.deleteForParent('series', f.seriesId)).toBe(1);
    expect(f.history.list(query()).totalRecords).toBe(1);
  });
});

describe('routes', () => {
  async function app() {
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(historyRoutes(f.history), { prefix: '/api/v1' });
    return a;
  }

  it('serves the paged list, since, series and movie views', async () => {
    const a = await app();
    grab(tv(f.ep.s1e1), 'A');
    grab(movie(), 'B');
    const page = await a.inject({ method: 'GET', url: '/api/v1/history?pageSize=1&eventType=grabbed&includeSeries=true' });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ page: 1, pageSize: 1, totalRecords: 2, sortKey: 'date', sortDirection: 'desc' });

    const since = await a.inject({ method: 'GET', url: `/api/v1/history/since?date=${encodeURIComponent('2025-01-01T00:00:00Z')}&eventType=grabbed` });
    expect(since.json()).toHaveLength(2);
    const bad = await a.inject({ method: 'GET', url: '/api/v1/history/since?date=yesterday' });
    expect(bad.statusCode).toBe(400);

    const ser = await a.inject({ method: 'GET', url: `/api/v1/history/series?seriesId=${f.seriesId}&seasonNumber=1&includeEpisode=true` });
    expect(ser.json()[0].episode.episodeNumber).toBe(1);
    const mov = await a.inject({ method: 'GET', url: `/api/v1/history/movie?movieId=${f.movieId}` });
    expect(mov.json()[0].downloadId).toBe('B');
  });

  it('POST /history/failed/:id marks failed and maps errors', async () => {
    const a = await app();
    const [g] = grab(movie(), 'B');
    const ok = await a.inject({ method: 'POST', url: `/api/v1/history/failed/${g!.id}`, payload: { message: 'bad file' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()[0]).toMatchObject({ eventType: 'downloadFailed', data: { message: 'bad file', source: 'api' } });
    expect(f.blocklist.forMovie(f.movieId)).toHaveLength(1);

    const missing = await a.inject({ method: 'POST', url: '/api/v1/history/failed/9999' });
    expect(missing.statusCode).toBe(404);
    const [r] = f.history.recordRenamed({ target: movie(), sourcePath: '/a', path: '/b', quality: quality('SDTV'), languages: [] });
    const invalid = await a.inject({ method: 'POST', url: `/api/v1/history/failed/${r!.id}` });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/not grabbed/);
  });
});
