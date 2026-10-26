/**
 * Builtin definitions against response shapes captured from the live sites on 2026-10-26
 * (fetched through the VPN-routed arclight container, then trimmed). These pin the parsing
 * of what the sites really return today; the hand-written fixtures in runtime.test.ts cover
 * the engine features.
 */
import { describe, expect, it } from 'vitest';
import eztvLive from '../../fixtures/definitions/eztv-live.json?raw';
import tgxDetails from '../../fixtures/definitions/torrentgalaxy-details.html?raw';
import tgxSearch from '../../fixtures/definitions/torrentgalaxy-search.html?raw';
import ytsLive from '../../fixtures/definitions/yts-gg-live.json?raw';
import { fakeFetch, type FakeReply } from '../testing/fake-fetch.js';
import { loadDefinitionCatalogue } from './catalogue.js';
import { customCategoryId } from './categories.js';
import { createDefinitionIndexer } from './indexer.js';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const noSleep = async (): Promise<void> => {};
const catalogue = await loadDefinitionCatalogue();
const builtin = (id: string) => {
  const def = catalogue.get(id);
  if (!def) throw new Error(`missing builtin ${id}`);
  return def;
};
const html = (body: string): FakeReply => ({ body, contentType: 'text/html; charset=utf-8' });
const json = (body: string): FakeReply => ({ body, contentType: 'application/json' });
const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, now: () => NOW, sleep: noSleep });

describe('live response shapes (2026-10-26)', () => {
  it('builtin markers: the three re-verified definitions are tested and keep their mirrors', () => {
    for (const id of ['yts', 'eztv', 'torrentgalaxy']) expect(builtin(id).tested).toBe(true);
    expect(builtin('yts').links.slice(0, 3)).toEqual(['https://yts.gg/', 'https://movies-api.accel.li/', 'https://yts.mx/']);
    expect(builtin('torrentgalaxy').links[0]).toBe('https://torrentgalaxy.one/');
  });

  it('YTS (yts.gg): data.movies[].torrents[] still parses, one release per torrent', async () => {
    const ff = fakeFetch(() => json(ytsLive));
    const indexer = createDefinitionIndexer(builtin('yts'), {}, opts(ff.fetch));
    const releases = await indexer.search({ kind: 'search', query: 'matrix' });
    expect(ff.calls[0]?.url).toBe('https://yts.gg/api/v2/list_movies.json?query_term=matrix&limit=50&sort_by=date_added');
    expect(releases).toHaveLength(7);
    expect(releases[0]).toMatchObject({
      title: 'Matrix: Generation (2024) [720p] [web] [x264] [YTS]',
      infoUrl: 'https://yts.gg/movies/matrix-generation-2024',
      downloadUrl: 'https://yts.gg/torrent/download/937C8886C8FD31240898B0DE40DE9E104A926F7E',
      infoHash: '937c8886c8fd31240898b0de40de9e104a926f7e',
      imdbId: 'tt30849138',
      year: 2024,
      size: 511568773,
      seeders: 5,
      leechers: 5,
      publishDate: '2024-01-22T21:45:44Z',
    });
    expect(releases[0]?.categories).toEqual(expect.arrayContaining([2040, 2000, customCategoryId('720p')]));
    expect(releases.every((r) => r.size > 0 && r.downloadUrl.startsWith('https://yts.gg/torrent/download/'))).toBe(true);
    expect(releases.filter((r) => r.title.startsWith('The Matrix Resurrections (2021)'))).toHaveLength(5);
  });

  it('EZTV (eztvx.to): magnet_url is the download link; no torrent_url/episode_url in the API any more', async () => {
    const ff = fakeFetch(() => json(eztvLive));
    const indexer = createDefinitionIndexer(builtin('eztv'), {}, opts(ff.fetch));
    const releases = await indexer.rss();
    expect(ff.calls[0]?.url).toBe('https://eztvx.to/api/get-torrents?limit=100&page=1');
    expect(releases.map((r) => r.title)).toEqual([
      'This City Is Ours S02E07 XviD-AFG EZTV',
      'This City Is Ours S02E07 1080p HEVC x265-MeGusta EZTV',
      'This City Is Ours S02E07 720p HEVC x265-MeGusta EZTV',
    ]);
    expect(releases[0]).toMatchObject({
      infoHash: '8d13fc34a82f7f74e90ce901b6d8715356f79b3c',
      size: 354930800,
      seeders: 0,
      leechers: 0,
      imdbId: 'tt31438328',
      publishDate: new Date(1792995973 * 1000).toISOString().replace('.000Z', 'Z'),
    });
    expect(releases[0]?.downloadUrl).toMatch(/^magnet:\?xt=urn:btih:8d13fc34a82f7f74e90ce901b6d8715356f79b3c&/);
    expect(releases[0]?.magnetUrl).toBe(releases[0]?.downloadUrl);
    expect(releases[0]?.categories).toEqual(expect.arrayContaining([5000, 5030]));
    expect(releases[1]?.categories).toEqual(expect.arrayContaining([5000, 5040]));
    expect(await indexer.download(releases[1]?.downloadUrl ?? '')).toEqual({ kind: 'magnet', magnetUrl: releases[1]?.downloadUrl });

    ff.calls.length = 0;
    await indexer.search({ kind: 'tv', imdbId: 'tt0944947' });
    expect(ff.calls[0]?.url).toContain('imdb_id=0944947');
  });

  it('TorrentGalaxy (torrentgalaxy.one): get-posts rows, category names, magnet from the details page', async () => {
    const ff = fakeFetch((url) => (url.pathname.startsWith('/post-detail/') ? html(tgxDetails) : html(tgxSearch)));
    const indexer = createDefinitionIndexer(builtin('torrentgalaxy'), {}, opts(ff.fetch));
    const releases = await indexer.search({ kind: 'search', query: 'ubuntu' });
    expect(ff.calls[0]?.url).toBe('https://torrentgalaxy.one/get-posts/?keywords=ubuntu');
    expect(releases.map((r) => r.title)).toEqual([
      'ubuntu-24.04.1-desktop-amd64.iso',
      'Ubuntu Linux Bible 11E by David Clinton epub Nonfiction',
      'Celtics City S01E08 Chapter VIII Ubuntu 720p AMZN WEB DL DDP5 1 H 264 RAWR EZTV',
    ]);
    expect(releases[0]).toMatchObject({
      infoUrl: 'https://torrentgalaxy.one/post-detail/8a6ee9/ubuntu-24-04-1-desktop-amd64-iso/',
      downloadUrl: 'https://torrentgalaxy.one/post-detail/8a6ee9/ubuntu-24-04-1-desktop-amd64-iso/',
      size: Math.trunc(5.8 * 1024 ** 3),
      seeders: 51,
      leechers: 12,
      grabs: 1,
    });
    expect(releases[0]?.categories).toEqual(expect.arrayContaining([4000]));
    expect(releases[1]?.categories).toEqual(expect.arrayContaining([8000]));
    expect(releases[2]?.categories).toEqual(expect.arrayContaining([5000]));
    expect(releases[2]?.imdbId).toBe('tt34555174');
    // "6 months" -> a date about half a year before NOW.
    const age = NOW - Date.parse(releases[0]?.publishDate ?? '');
    expect(age).toBeGreaterThan(150 * 86_400_000);
    expect(age).toBeLessThan(200 * 86_400_000);

    const dl = await indexer.download(releases[0]?.downloadUrl ?? '');
    expect(dl.kind).toBe('magnet');
    expect(dl.kind === 'magnet' ? dl.magnetUrl : '').toMatch(/^magnet:\?xt=urn:btih:4A3F5E08BCEF825718EDA30637230585E3330599&dn=ubuntu-24\.04\.1-desktop-amd64\.iso&tr=/);
  });
});
