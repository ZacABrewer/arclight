import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { BlocklistListQuery, type BlocklistAddRequestInput, type BlocklistListQueryInput } from '@media-tron/shared';
import { quality, setup, type Fixture } from '../history/test-support.js';
import { blocklistRoutes } from './routes.js';
import { BlocklistError, matchesBlocklistEntry, type BlocklistCandidate } from './service.js';

const MiB = 1024 * 1024;

let f: Fixture;

beforeEach(async () => {
  f = await setup();
});

function seriesEntry(overrides: Partial<BlocklistAddRequestInput> = {}): BlocklistAddRequestInput {
  return {
    mediaType: 'series',
    seriesId: f.seriesId,
    episodeIds: [f.ep.s2e1],
    sourceTitle: 'Show.S02E03.1080p.WEB-DL-GRP',
    quality: quality('WEBDL-1080p'),
    protocol: 'torrent',
    indexer: 'Tracker1',
    torrentInfoHash: 'ABC123',
    message: 'failed',
    ...overrides,
  } as BlocklistAddRequestInput;
}

function movieEntry(overrides: Partial<BlocklistAddRequestInput> = {}): BlocklistAddRequestInput {
  return {
    mediaType: 'movie',
    movieId: f.movieId,
    sourceTitle: 'Movie.2020.1080p.BluRay-GRP',
    quality: quality('Bluray-1080p'),
    protocol: 'usenet',
    indexer: 'B',
    publishedDate: '2025-01-01T12:01:10Z',
    size: 8_001_000_000,
    ...overrides,
  } as BlocklistAddRequestInput;
}

const tvScope = () => ({ seriesId: f.seriesId });
const movieScope = () => ({ movieId: f.movieId });

describe('creating entries', () => {
  it('adds an entry and reads it back', () => {
    const r = f.blocklist.add(seriesEntry({ releaseType: 'singleEpisode', source: 'TorrentFileValidation' }));
    expect(r).toMatchObject({
      mediaType: 'series',
      seriesId: f.seriesId,
      movieId: null,
      episodeIds: [f.ep.s2e1],
      torrentInfoHash: 'abc123',
      indexer: 'Tracker1',
      protocol: 'torrent',
      date: '2025-01-10T12:00:00.000Z',
      publishedDate: null,
      size: null,
      source: 'TorrentFileValidation',
      releaseType: 'singleEpisode',
      customFormats: [],
    });
    expect(f.blocklist.get(r.id)).toEqual(r);
  });

  it('rejects an entry without its parent id and drops hashes on usenet entries', () => {
    expect(() => f.blocklist.add({ ...seriesEntry(), seriesId: undefined } as BlocklistAddRequestInput)).toThrow(BlocklistError);
    const r = f.blocklist.add(movieEntry({ torrentInfoHash: 'zzz', releaseType: 'x' }));
    expect(r.torrentInfoHash).toBeNull();
    expect(r.releaseType).toBeNull();
  });

  it('creates an entry from a tracked download using grabbed data', () => {
    const r = f.blocklist.addFromTracked(
      { title: 'Movie.2021', downloadId: 'DEADBEEF', protocol: 'torrent', sizeBytes: 10, mediaType: 'movie', movieId: f.movieId },
      'Removed by user',
      { PublishedDate: '2025-01-01T00:00:00Z', Indexer: 'Tracker9' },
    );
    expect(r).toMatchObject({ movieId: f.movieId, torrentInfoHash: 'deadbeef', indexer: 'Tracker9', size: 10, message: 'Removed by user', publishedDate: '2025-01-01T00:00:00.000Z' });
    expect(r.quality.quality.name).toBe('Unknown');
    expect(() => f.blocklist.addFromTracked({ title: 'x', downloadId: 'y', protocol: 'usenet' }, 'm')).toThrow(/not linked/);
  });

  it('creates an entry from a pending release', () => {
    const r = f.blocklist.addFromPending(
      { mediaType: 'series', seriesId: f.seriesId, episodeIds: [f.ep.s1e1] },
      { title: 'Zeta.S01E01', protocol: 'torrent', indexerName: 'T', infoHash: 'AA', size: 5, publishDate: '2025-01-02T00:00:00Z' },
      { quality: quality('HDTV-720p'), languages: ['en'] },
    );
    expect(r).toMatchObject({ message: 'Pending release manually blocklisted', torrentInfoHash: 'aa', episodeIds: [f.ep.s1e1], languages: ['en'] });
  });

  it('a failed event without published date or protocol still blocklists (missing -> null)', async () => {
    const [g] = f.history.recordGrab(
      { title: 'Movie.2021.WEB', protocol: 'usenet' },
      { target: { mediaType: 'movie', movieId: f.movieId }, quality: quality('WEBDL-1080p'), languages: [] },
      null,
      'sab',
    );
    await f.history.markFailed(g!.id);
    const [entry] = f.blocklist.forMovie(f.movieId);
    expect(entry).toMatchObject({ protocol: 'usenet', publishedDate: null, size: 0, torrentInfoHash: null, message: 'Manually marked as failed' });
  });
});

describe('matching rules', () => {
  it('torrent: hash equal ignoring case matches from any indexer (examples 1 & 2)', () => {
    f.blocklist.add(seriesEntry());
    const c: BlocklistCandidate = { title: 'Show.S02E03.1080p.WEB-DL-GRP', protocol: 'torrent', indexer: 'Tracker1', torrentInfoHash: 'abc123' };
    expect(f.blocklist.isBlocklisted(tvScope(), c)).toBe(true);
    expect(f.blocklist.isBlocklisted(tvScope(), { ...c, indexer: 'Tracker2' })).toBe(true);
    expect(f.blocklist.isBlocklisted(tvScope(), { ...c, title: 'Totally different', torrentInfoHash: 'ABC123' })).toBe(true);
    expect(f.blocklist.isBlocklisted(tvScope(), { ...c, torrentInfoHash: 'abc124' })).toBe(false);
  });

  it('torrent without hash: title + same indexer only (example 3)', () => {
    f.blocklist.add(seriesEntry());
    const c: BlocklistCandidate = { title: 'show.s02e03.1080p.web-dl-grp', protocol: 'torrent', indexer: 'TRACKER1' };
    expect(f.blocklist.isBlocklisted(tvScope(), c)).toBe(true);
    expect(f.blocklist.isBlocklisted(tvScope(), { ...c, indexer: 'Tracker2' })).toBe(false);
    // Exact title equality, not substring (deliberate deviation).
    expect(f.blocklist.isBlocklisted(tvScope(), { ...c, title: 'Show.S02E03.1080p' })).toBe(false);
  });

  it('a blank blocklist indexer matches any indexer (example 5)', () => {
    f.blocklist.add(seriesEntry({ indexer: null, torrentInfoHash: null }));
    expect(f.blocklist.isBlocklisted(tvScope(), { title: 'Show.S02E03.1080p.WEB-DL-GRP', protocol: 'torrent', indexer: 'Anything' })).toBe(true);
  });

  it('protocol must agree for title matches', () => {
    f.blocklist.add(seriesEntry({ torrentInfoHash: null }));
    expect(
      f.blocklist.isBlocklisted(tvScope(), { title: 'Show.S02E03.1080p.WEB-DL-GRP', protocol: 'usenet', indexer: 'Tracker1', publishedDate: '2025-01-01T00:00:00Z' }),
    ).toBe(false);
  });

  it('usenet: exact published date matches regardless of indexer', () => {
    f.blocklist.add(movieEntry());
    const c: BlocklistCandidate = { title: 'Movie.2020.1080p.BluRay-GRP', protocol: 'usenet', indexer: 'B', publishedDate: '2025-01-01T12:01:10.000Z', size: 1 };
    expect(f.blocklist.isBlocklisted(movieScope(), c)).toBe(true);
  });

  it('usenet: same NZB reposted on another indexer within 2 min and 2 MiB (example 4)', () => {
    f.blocklist.add(movieEntry({ size: 8_000_000_000 }));
    const c: BlocklistCandidate = { title: 'Movie.2020.1080p.BluRay-GRP', protocol: 'usenet', indexer: 'A', publishedDate: '2025-01-01T12:00:30Z', size: 8_000_000_000 + MiB };
    expect(f.blocklist.isBlocklisted(movieScope(), c)).toBe(true);
    expect(f.blocklist.isBlocklisted(movieScope(), { ...c, size: 8_000_000_000 + 3 * MiB })).toBe(false);
    expect(f.blocklist.isBlocklisted(movieScope(), { ...c, publishedDate: '2025-01-01T11:58:00Z' })).toBe(false);
    // Same indexer with a different publish date is a different post.
    expect(f.blocklist.isBlocklisted(movieScope(), { ...c, indexer: 'B' })).toBe(false);
  });

  it('usenet: rows without size or published date count as within tolerance', () => {
    f.blocklist.add(movieEntry({ size: 0, publishedDate: null }));
    expect(
      f.blocklist.isBlocklisted(movieScope(), { title: 'Movie.2020.1080p.BluRay-GRP', protocol: 'usenet', indexer: 'C', publishedDate: '2030-01-01T00:00:00Z', size: 1 }),
    ).toBe(true);
  });

  it('entries are scoped to their parent (scenario G)', () => {
    f.blocklist.add(seriesEntry());
    const c: BlocklistCandidate = { title: 'Show.S02E03.1080p.WEB-DL-GRP', protocol: 'torrent', torrentInfoHash: 'abc123' };
    expect(f.blocklist.isBlocklisted({ seriesId: f.otherSeriesId }, c)).toBe(false);
    expect(f.blocklist.isBlocklisted({ movieId: f.movieId }, c)).toBe(false);
  });

  it('grab-time hash check and the pure matcher', () => {
    f.blocklist.add(seriesEntry());
    expect(f.blocklist.isHashBlocklisted(tvScope(), 'Abc123')).toBe(true);
    expect(f.blocklist.isHashBlocklisted(tvScope(), '')).toBe(false);
    expect(f.blocklist.isHashBlocklisted({ seriesId: f.otherSeriesId }, 'abc123')).toBe(false);
    expect(
      matchesBlocklistEntry(
        { sourceTitle: 'T', protocol: 'torrent', indexer: null, torrentInfoHash: null, size: null, publishedDate: null },
        { title: 't', protocol: 'torrent', torrentInfoHash: 'abc' },
      ),
    ).toBe(false);
  });

  it('findMatch returns the blocking row', () => {
    const r = f.blocklist.add(seriesEntry());
    expect(f.blocklist.findMatch(tvScope(), { title: 'x', protocol: 'torrent', torrentInfoHash: 'ABC123' })?.id).toBe(r.id);
  });
});

describe('listing and removal', () => {
  const q = (input: BlocklistListQueryInput = {}) => BlocklistListQuery.parse(input);

  beforeEach(() => {
    f.blocklist.add(seriesEntry({ sourceTitle: 'b', indexer: 'Zed' }));
    f.clock.advance(1000);
    f.blocklist.add(movieEntry({ sourceTitle: 'a', indexer: 'alpha' }));
    f.clock.advance(1000);
    f.blocklist.add(seriesEntry({ seriesId: f.otherSeriesId, episodeIds: [], sourceTitle: 'c', protocol: 'usenet', torrentInfoHash: null, indexer: 'Mid' }));
  });

  it('pages and sorts', () => {
    const titles = (input: BlocklistListQueryInput) => f.blocklist.list(q(input)).records.map((r) => r.sourceTitle);
    expect(titles({})).toEqual(['c', 'a', 'b']);
    expect(titles({ sortKey: 'sourceTitle', sortDirection: 'asc' })).toEqual(['a', 'b', 'c']);
    expect(titles({ sortKey: 'indexer', sortDirection: 'asc' })).toEqual(['a', 'c', 'b']);
    expect(titles({ sortKey: 'title', sortDirection: 'asc' })).toEqual(['c', 'a', 'b']);
    const p2 = f.blocklist.list(q({ pageSize: 2, page: 2 }));
    expect(p2.totalRecords).toBe(3);
    expect(p2.records).toHaveLength(1);
  });

  it('filters by parent ids, protocol and media type', () => {
    const total = (input: BlocklistListQueryInput) => f.blocklist.list(q(input)).totalRecords;
    expect(total({ seriesId: String(f.seriesId) })).toBe(1);
    expect(total({ seriesId: `${f.seriesId},${f.otherSeriesId}` })).toBe(2);
    expect(total({ movieId: String(f.movieId) })).toBe(1);
    expect(total({ protocol: 'usenet' })).toBe(2);
    expect(total({ protocol: 'torrent,usenet' })).toBe(3);
    expect(total({ mediaType: 'series' })).toBe(2);
  });

  it('removes one, many, a parent, orphans and everything', () => {
    const [first, second, third] = f.blocklist.list(q({ sortDirection: 'asc' })).records;
    f.blocklist.remove(first!.id);
    expect(() => f.blocklist.remove(first!.id)).toThrow(BlocklistError);
    expect(f.blocklist.bulkRemove([second!.id, 12345])).toBe(1);
    expect(f.blocklist.deleteForParent('series', f.otherSeriesId)).toBe(1);
    expect(third).toBeDefined();
    f.blocklist.add(movieEntry({ movieId: 9_999 }));
    f.blocklist.add(movieEntry());
    expect(f.blocklist.cleanup()).toBe(1);
    expect(f.blocklist.clear()).toBe(1);
    expect(f.blocklist.list(q()).totalRecords).toBe(0);
  });
});

describe('routes', () => {
  async function app() {
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(blocklistRoutes(f.blocklist), { prefix: '/api/v1' });
    return a;
  }

  it('lists, filters per parent and deletes', async () => {
    const a = await app();
    const s = f.blocklist.add(seriesEntry());
    const m = f.blocklist.add(movieEntry());
    const extra = f.blocklist.add(movieEntry({ sourceTitle: 'other' }));

    const page = await a.inject({ method: 'GET', url: '/api/v1/blocklist?protocol=torrent' });
    expect(page.statusCode).toBe(200);
    expect(page.json().totalRecords).toBe(1);
    const bySeries = await a.inject({ method: 'GET', url: `/api/v1/blocklist/series?seriesId=${f.seriesId}` });
    expect(bySeries.json().map((r: { id: number }) => r.id)).toEqual([s.id]);
    const byMovie = await a.inject({ method: 'GET', url: `/api/v1/blocklist/movie?movieId=${f.movieId}` });
    expect(byMovie.json()).toHaveLength(2);

    const del = await a.inject({ method: 'DELETE', url: `/api/v1/blocklist/${s.id}` });
    expect(del.statusCode).toBe(204);
    expect((await a.inject({ method: 'DELETE', url: `/api/v1/blocklist/${s.id}` })).statusCode).toBe(404);

    const bulk = await a.inject({ method: 'DELETE', url: '/api/v1/blocklist/bulk', payload: { ids: [m.id, extra.id] } });
    expect(bulk.json()).toEqual({ deleted: 2 });
  });

  it('adds via POST and clears', async () => {
    const a = await app();
    const created = await a.inject({ method: 'POST', url: '/api/v1/blocklist', payload: movieEntry() });
    expect(created.statusCode).toBe(201);
    const bad = await a.inject({ method: 'POST', url: '/api/v1/blocklist', payload: { ...movieEntry(), movieId: undefined } });
    expect(bad.statusCode).toBe(400);
    const cleared = await a.inject({ method: 'POST', url: '/api/v1/blocklist/clear' });
    expect(cleared.json()).toEqual({ deleted: 1 });
  });
});
