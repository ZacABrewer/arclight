import { describe, expect, it } from 'vitest';
import detailsHtml from '../../fixtures/definitions/1337x-details.html?raw';
import searchHtml from '../../fixtures/definitions/1337x-search.html?raw';
import nyaaRss from '../../fixtures/definitions/nyaa-rss.xml?raw';
import tpbEmpty from '../../fixtures/definitions/tpb-empty.json?raw';
import tpbSearch from '../../fixtures/definitions/tpb-search.json?raw';
import ytsEmpty from '../../fixtures/definitions/yts-empty.json?raw';
import ytsList from '../../fixtures/definitions/yts-list.json?raw';
import { fakeFetch, type FakeReply } from '../testing/fake-fetch.js';
import { IndexerError } from '../types.js';
import { loadDefinitionCatalogue, parseDefinitionYaml } from './catalogue.js';
import { customCategoryId } from './categories.js';
import { createDefinitionIndexer } from './indexer.js';
import { andMatch, buildMagnet, normalizeInfoHash, queryVariables } from './runtime.js';

const NOW = Date.UTC(2024, 2, 10, 12, 0, 0);
const noSleep = async (): Promise<void> => {};
const catalogue = await loadDefinitionCatalogue();
const builtin = (id: string) => {
  const def = catalogue.get(id);
  if (!def) throw new Error(`missing builtin ${id}`);
  return def;
};
const html = (body: string, status = 200): FakeReply => ({ body, status, contentType: 'text/html; charset=utf-8' });
const json = (body: string): FakeReply => ({ body, contentType: 'application/json' });

const CUSTOM = `
id: customsite
name: CustomSite
type: semi-private
links: [https://custom.example/]
settings:
  - {name: freeleech, type: checkbox, label: Freeleech, default: false}
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "Movies"}
    - {id: 2, cat: TV/SD, desc: "TV"}
  modes:
    search: [q]
    tv-search: [q, season, ep]
search:
  paths:
    - path: "browse.php"
      categories: [1]
    - path: "tv/{{ .Keywords }}"
      categories: ["!", 1]
  inputs:
    $raw: "{{ range .Categories }}c{{.}}=1&{{end}}"
    q: "{{ .Keywords }}"
    free: "{{ if .Config.freeleech }}1{{ end }}"
  keywordsfilters:
    - {name: re_replace, args: ["[._]+", " "]}
  rows:
    selector: "table#torrents > tbody > tr:not(.dateheader)"
    after: 1
    dateheaders:
      selector: "td"
      filters: [{name: regexp, args: "Added on (.+)"}]
  fields:
    category: {selector: "td.cat a", attribute: href, filters: [{name: querystring, args: cat}]}
    title: {selector: "td.name", remove: "span.junk"}
    description: {text: "{{ .Result.title }} @ {{ .Config.sitelink }}"}
    details: {selector: "td.name a", attribute: href}
    download: {selector: "a.dl", attribute: href}
    size: {selector: "td.size"}
    seeders: {selector: "td.seed"}
    leechers: {selector: "td.leech"}
    grabs: {selector: "td.done", optional: true, default: "7"}
    downloadvolumefactor:
      case: {"img[alt=Free]": 0, "*": 1}
    uploadvolumefactor: {text: 2}
    minimumseedtime: {text: 3600}
`;

const CUSTOM_PAGE = `<html><body><table id="torrents"><tbody>
<tr class="dateheader"><td colspan="3">Added on 2024-03-05</td></tr>
<tr><td class="cat"><a href="browse.php?cat=1">Movies</a></td><td class="name"><a href="details.php?id=11">Movie.One.2024.1080p</a><span class="junk"> NEW!</span></td><td class="size">1.5 GB</td></tr>
<tr><td class="seed">1,010</td><td class="leech">2</td><td><a class="dl" href="/download.php?id=11&amp;k=abc">dl</a><img alt="Free" src="free.png"></td></tr>
<tr class="dateheader"><td colspan="3">Added on 2024-03-04</td></tr>
<tr><td class="cat"><a href="browse.php?cat=2">TV</a></td><td class="name"><a href="details.php?id=12">Show.S01E02.720p</a></td><td class="size">700 MiB</td></tr>
<tr><td class="seed">5000001</td><td class="leech">0</td><td><a class="dl" href="/download.php?id=12">dl</a></td></tr>
<tr><td class="cat"><a href="browse.php?cat=1">Movies</a></td><td class="name"></td><td class="size">1 GB</td></tr>
<tr><td class="seed">1</td><td class="leech">1</td><td><a class="dl" href="/download.php?id=13">dl</a></td></tr>
</tbody></table></body></html>`;

describe('HTML search (custom definition)', () => {
  it('parses multi-row releases with dateheaders, case, remove, querystring and result chaining', async () => {
    const ff = fakeFetch(() => html(CUSTOM_PAGE));
    const indexer = createDefinitionIndexer(parseDefinitionYaml(CUSTOM), {}, { fetchImpl: ff.fetch, now: () => NOW, sleep: noSleep, indexerId: 9 });
    const releases = await indexer.search({ kind: 'search', query: 'Movie.One', categories: [2000] });
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]?.url).toBe('https://custom.example/browse.php?c1=1&q=Movie+One');
    expect(releases).toHaveLength(2); // third row has no title -> skipped
    const [a, b] = releases;
    expect(a).toMatchObject({
      title: 'Movie.One.2024.1080p',
      description: 'Movie.One.2024.1080p @ https://custom.example/',
      infoUrl: 'https://custom.example/details.php?id=11',
      downloadUrl: 'https://custom.example/download.php?id=11&k=abc',
      guid: 'https://custom.example/download.php?id=11&k=abc',
      size: 1610612736,
      seeders: 1010,
      leechers: 2,
      peers: 1012,
      grabs: 7,
      categories: [2040, 100001],
      publishDate: '2024-03-05T00:00:00Z',
      downloadVolumeFactor: 0,
      uploadVolumeFactor: 2,
      minimumSeedTime: 3_600_000,
      indexerId: 9,
      indexerName: 'CustomSite',
      protocol: 'torrent',
    });
    expect(a?.magnetUrl).toBeUndefined();
    expect(b).toMatchObject({
      title: 'Show.S01E02.720p',
      size: 734003200,
      seeders: 0, // >= 5,000,000 treated as garbage
      categories: [5030, 100002],
      publishDate: '2024-03-04T00:00:00Z',
      downloadVolumeFactor: 1,
    });
  });

  it('narrows categories per path, honours "!" paths, $raw and checkbox templates', async () => {
    const ff = fakeFetch(() => html('<html></html>'));
    const indexer = createDefinitionIndexer(parseDefinitionYaml(CUSTOM), { freeleech: true }, { fetchImpl: ff.fetch, now: () => NOW, sleep: noSleep });
    await indexer.search({ kind: 'tv', query: 'My Show', season: 1, episode: 2, categories: [5000] });
    expect(ff.calls.map((c) => c.url)).toEqual(['https://custom.example/tv/My%20Show%20S01E02?c2=1&q=My+Show+S01E02&free=1']);
    ff.calls.length = 0;
    await indexer.rss();
    expect(ff.calls.map((c) => c.url)).toEqual(['https://custom.example/browse.php?free=1', 'https://custom.example/tv/?free=1']);
  });

  it('builds query variables for typed searches', () => {
    const tv = queryVariables({ kind: 'tv', query: 'Show', season: 3, episode: 7, imdbId: '133093' });
    expect(tv['Query.Type']).toBe('tvsearch');
    expect(tv['Query.Episode']).toBe('S03E07');
    expect(tv['Query.Keywords']).toBe('Show S03E07');
    expect(tv['Query.IMDBID']).toBe('tt0133093');
    expect(tv['Query.IMDBIDShort']).toBe('133093');
    const daily = queryVariables({ kind: 'tv', query: 'News', airDate: '2024-05-17' });
    expect(daily['Query.Episode']).toBe('2024.05.17');
    const movie = queryVariables({ kind: 'movie', query: 'Film', year: 1999 });
    expect(movie['Query.Keywords']).toBe('Film 1999');
    expect(movie['Query.Type']).toBe('movie');
    expect(queryVariables({ kind: 'rss' })['Query.Keywords']).toBeNull();
  });

  it('reports site errors and HTTP failures as IndexerError', async () => {
    const statuses = [429, 500, 404];
    for (const status of statuses) {
      const indexer = createDefinitionIndexer(parseDefinitionYaml(CUSTOM), {}, { fetchImpl: fakeFetch(() => html('x', status)).fetch });
      const err = await indexer.search({ kind: 'search', query: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).code).toBe(status === 429 ? 'rate-limited' : status === 500 ? 'unreachable' : 'bad-response');
    }
    const challenge = fakeFetch(() => ({ status: 503, body: '<title>Just a moment...</title>', contentType: 'text/html' }));
    const cfIndexer = createDefinitionIndexer(parseDefinitionYaml(CUSTOM), {}, { fetchImpl: async (u, i) => {
      const r = await challenge.fetch(u, i);
      return new Response(await r.text(), { status: 503, headers: { server: 'cloudflare', 'content-type': 'text/html' } });
    } });
    await expect(cfIndexer.search({ kind: 'search', query: 'x' })).rejects.toThrow(/FlareSolverr/);
  });

  it('test() fails on zero results and succeeds otherwise', async () => {
    const empty = createDefinitionIndexer(parseDefinitionYaml(CUSTOM), {}, { fetchImpl: fakeFetch(() => html('<html></html>')).fetch });
    const bad = await empty.test();
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/no results/);
    const full = createDefinitionIndexer(parseDefinitionYaml(CUSTOM), {}, { fetchImpl: fakeFetch(() => html(CUSTOM_PAGE)).fetch, now: () => NOW, sleep: noSleep });
    const good = await full.test();
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.releaseCount).toBe(2);
      expect(good.caps.searching.tvSearch.available).toBe(true);
    }
  });
});

describe('builtin definitions against fixtures', () => {
  it('1337x: HTML rows, size with removed span, fuzzy dates, magnet from details page', async () => {
    const ff = fakeFetch((url) => (url.pathname.startsWith('/torrent/') ? html(detailsHtml) : html(searchHtml)));
    const indexer = createDefinitionIndexer(builtin('1337x'), {}, { fetchImpl: ff.fetch, now: () => NOW, sleep: noSleep });
    const releases = await indexer.search({ kind: 'search', query: 'some movie' });
    expect(ff.calls[0]?.url).toBe('https://1337x.to/sort-search/some%20movie/time/desc/1/');
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({
      title: 'Some.Movie.2023.1080p.WEB.H264-GRP',
      infoUrl: 'https://1337x.to/torrent/5550001/Some-Movie-2023-1080p-WEB-H264/',
      size: Math.trunc(2.1 * 1024 ** 3),
      seeders: 1204,
      leechers: 87,
      categories: [2040, 100042],
      publishDate: '2024-03-05T00:00:00Z',
    });
    expect(releases[1]?.categories).toEqual([5040, 100041]);
    expect(releases[1]?.publishDate).toBe('2024-03-10T12:00:00Z'); // "3am" is unparseable -> retrieval time
    const dl = await indexer.download(releases[0]?.downloadUrl ?? '');
    expect(dl).toEqual({ kind: 'magnet', magnetUrl: 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Some.Movie' });
  });

  it('The Pirate Bay: JSON array rows, synthesised magnets, noResultsMessage', async () => {
    const ff = fakeFetch((url) => json(url.searchParams.get('q') === 'nothing' ? tpbEmpty : tpbSearch));
    const indexer = createDefinitionIndexer(builtin('thepiratebay'), {}, { fetchImpl: ff.fetch, now: () => NOW, sleep: noSleep });
    const releases = await indexer.search({ kind: 'search', query: 'ubuntu', categories: [2000] });
    expect(ff.calls[0]?.url).toContain('https://apibay.org/q.php?q=ubuntu&cat=');
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({
      title: 'Ubuntu 24.04 LTS Desktop amd64',
      infoUrl: 'https://thepiratebay.org/description.php?id=6000001',
      infoHash: '0123456789abcdef0123456789abcdef01234567',
      size: 6114656256,
      seeders: 345,
      leechers: 12,
      files: 1,
      categories: [4000, 100300],
      publishDate: '2024-04-24T23:06:40Z',
    });
    expect(releases[0]?.magnetUrl).toMatch(/^magnet:\?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Ubuntu%2024.04/);
    expect(releases[0]?.downloadUrl).toBe(releases[0]?.magnetUrl);
    expect(releases[1]?.imdbId).toBe('tt1234567');
    expect(await indexer.search({ kind: 'search', query: 'nothing' })).toEqual([]);
    ff.calls.length = 0;
    await indexer.rss();
    expect(ff.calls[0]?.url).toBe('https://apibay.org/precompiled/data_top100_recent.json');
  });

  it('YTS: nested torrents with rows.attribute + multiple and ".." selectors', async () => {
    const ff = fakeFetch((url) => json(url.searchParams.get('query_term') === 'none' ? ytsEmpty : ytsList));
    const indexer = createDefinitionIndexer(builtin('yts'), {}, { fetchImpl: ff.fetch, now: () => NOW, sleep: noSleep });
    const releases = await indexer.search({ kind: 'movie', query: 'The Matrix', year: 1999 });
    expect(ff.calls[0]?.url).toBe('https://yts.mx/api/v2/list_movies.json?query_term=The+Matrix&limit=50&sort_by=date_added');
    expect(releases.map((r) => r.title)).toEqual([
      'The Matrix (1999) [720p] [bluray] [x264] [YTS]',
      'The Matrix (1999) [2160p] [web] [x265] [YTS]',
      'The Matrix Reloaded (2003) [1080p] [bluray] [x264] [YTS]',
    ]);
    expect(releases[1]).toMatchObject({
      infoUrl: 'https://yts.mx/movies/the-matrix-1999',
      imdbId: 'tt0133093',
      year: 1999,
      size: 5583457484,
      seeders: 300,
      infoHash: '4444555566667777888899990000aaaabbbbcccc',
      genres: ['Action', 'Sci-Fi'],
      publishDate: '2021-01-01T00:00:00Z',
    });
    expect(releases[1]?.categories).toEqual(expect.arrayContaining([2045, 2000, customCategoryId('2160p')]));
    expect(releases[0]?.downloadUrl).toBe('https://yts.mx/torrent/download/AAAABBBBCCCCDDDDEEEEFFFF0000111122223333');
    expect(releases[0]?.magnetUrl).toContain('urn:btih:aaaabbbbccccddddeeeeffff0000111122223333');
    expect(await indexer.search({ kind: 'search', query: 'none' })).toEqual([]);
    ff.calls.length = 0;
    await indexer.search({ kind: 'movie', imdbId: 'tt0133093' });
    expect(ff.calls[0]?.url).toContain('query_term=tt0133093');
  });

  it('Nyaa: RSS/XML rows with namespaced elements and select settings', async () => {
    const ff = fakeFetch(() => ({ body: nyaaRss, contentType: 'application/rss+xml' }));
    const indexer = createDefinitionIndexer(builtin('nyaa'), { filter: '2' }, { fetchImpl: ff.fetch, now: () => NOW, sleep: noSleep });
    const releases = await indexer.search({ kind: 'tv', query: 'Frieren', season: 1, episode: 1 });
    expect(ff.calls[0]?.url).toBe('https://nyaa.si/?page=rss&q=Frieren&c=0_0&f=2');
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({
      title: '[SubGroup] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv',
      downloadUrl: 'https://nyaa.si/download/1700001.torrent',
      infoUrl: 'https://nyaa.si/view/1700001',
      size: Math.trunc(1.4 * 1024 ** 3),
      seeders: 1500,
      leechers: 20,
      grabs: 40000,
      infoHash: 'aaaabbbbccccddddeeeeffff0000111122223333',
      publishDate: '2023-09-29T17:30:12Z',
      description: 'Anime - English-translated',
    });
    expect(releases[0]?.categories).toContain(5070);
    expect(releases[1]?.title).toBe('[Raws] Frieren - 02 (BD 1920x1080 HEVC FLAC)');
  });
});

describe('download (S11)', () => {
  const DL = `
id: dlsite
name: DlSite
type: public
links: [https://dl.example/]
settings: []
caps:
  categorymappings: [{id: 1, cat: Movies}]
  modes: {search: [q]}
search:
  path: browse
  rows: {selector: tr}
  fields: {title: {selector: td}}
download:
  selectors:
    - selector: "a.fake"
      attribute: href
    - selector: "a.real"
      attribute: href
`;
  const TORRENT = 'd8:announce17:http://t.example/4:infod4:name3:abcee';

  it('tries selectors in order, rejecting non-torrent candidates', async () => {
    const ff = fakeFetch((url) => {
      if (url.pathname === '/details/1') return html('<a class="fake" href="/fake.torrent">x</a><a class="real" href="/real.torrent">y</a>');
      if (url.pathname === '/fake.torrent') return html('<html>login</html>');
      return { body: TORRENT, contentType: 'application/x-bittorrent' };
    });
    const indexer = createDefinitionIndexer(DL, {}, { fetchImpl: ff.fetch });
    const result = await indexer.download('https://dl.example/details/1');
    expect(result.kind).toBe('torrent');
    if (result.kind === 'torrent') {
      expect(new TextDecoder().decode(result.data)).toBe(TORRENT);
      expect(result.url).toBe('https://dl.example/real.torrent');
    }
  });

  it('follows a redirect to a magnet and rejects HTML bodies without a download block', async () => {
    const plain = parseDefinitionYaml(DL.replace(/download:[\s\S]*$/, ''));
    const redirect = createDefinitionIndexer(plain, {}, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'magnet:?xt=urn:btih:abc' } }),
    });
    expect(await redirect.download('https://dl.example/dl/1')).toEqual({ kind: 'magnet', magnetUrl: 'magnet:?xt=urn:btih:abc' });
    const htmlSite = createDefinitionIndexer(plain, {}, { fetchImpl: fakeFetch(() => html('<html>expired</html>')).fetch });
    await expect(htmlSite.download('https://dl.example/dl/1')).rejects.toThrow(/html content/);
    const missing = createDefinitionIndexer(plain, {}, { fetchImpl: fakeFetch(() => html('gone', 404)).fetch });
    await expect(missing.download('https://dl.example/dl/1')).rejects.toThrow(/unavailable/);
    expect(await missing.download('magnet:?xt=urn:btih:xyz')).toEqual({ kind: 'magnet', magnetUrl: 'magnet:?xt=urn:btih:xyz' });
  });

  it('builds a magnet from an infohash block and uses before requests', async () => {
    const def = DL.replace(
      /download:[\s\S]*$/,
      `download:
  before:
    path: "ajax/token.php"
    method: post
    inputs: {id: "{{ .DownloadUri.Query.id }}"}
  infohash:
    usebeforeresponse: true
    hash: {selector: "td.hash"}
    title: {selector: "h1"}
`,
    );
    const ff = fakeFetch(() => html('<h1>Great Title</h1><table><tr><td class="hash">ABCDEF0123456789ABCDEF0123456789ABCDEF01</td></tr></table>'));
    const indexer = createDefinitionIndexer(def, {}, { fetchImpl: ff.fetch });
    const result = await indexer.download('https://dl.example/details.php?id=77');
    expect(ff.calls[0]?.url).toBe('https://dl.example/ajax/token.php');
    expect(ff.calls[0]?.init?.method).toBe('POST');
    expect(String(ff.calls[0]?.init?.body)).toBe('id=77');
    expect(result.kind).toBe('magnet');
    if (result.kind === 'magnet') {
      expect(result.magnetUrl).toMatch(/^magnet:\?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Great%20Title&tr=/);
    }
  });
});

describe('helpers', () => {
  it('normalises info hashes and builds magnets', () => {
    expect(normalizeInfoHash('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(normalizeInfoHash('VPVPVPVPVPVPVPVPVPVPVPVPVPVPVPVP')).toMatch(/^[0-9a-f]{40}$/);
    expect(normalizeInfoHash('nothex')).toBeUndefined();
    expect(buildMagnet('abc', 'A B', ['udp://t:1'])).toBe('magnet:?xt=urn:btih:abc&dn=A%20B&tr=udp%3A%2F%2Ft%3A1');
  });

  it('andmatch requires two terms (or the single term)', () => {
    expect(andMatch('the big show', { title: 'Big.Show.S01E01' })).toBe(true);
    expect(andMatch('the big show', { title: 'Big.Bang' })).toBe(false);
    expect(andMatch('ubuntu', { title: 'Ubuntu 24.04' })).toBe(true);
    expect(andMatch('a of', { title: 'x' })).toBe(true);
  });

  it('EZTV keyword search is post-filtered with andmatch', async () => {
    const body = JSON.stringify({
      torrents_count: 2,
      torrents: [
        { title: 'Big Show S01E01 1080p WEB', torrent_url: 'https://e/1.torrent', hash: 'a'.repeat(40), size_bytes: '1000', date_released_unix: 1709000000, seeds: 5, peers: 1, imdb_id: '1234567', episode_url: 'https://e/ep/1' },
        { title: 'Other Thing S02E03 480p', torrent_url: 'https://e/2.torrent', hash: 'b'.repeat(40), size_bytes: '2000', date_released_unix: 1709000000, seeds: 1, peers: 0, imdb_id: '7654321', episode_url: 'https://e/ep/2' },
      ],
    });
    const indexer = createDefinitionIndexer(builtin('eztv'), {}, { fetchImpl: fakeFetch(() => json(body)).fetch, now: () => NOW, sleep: noSleep });
    const releases = await indexer.search({ kind: 'search', query: 'big show' });
    expect(releases.map((r) => r.title)).toEqual(['Big Show S01E01 1080p WEB']);
    expect(releases[0]?.categories).toEqual(expect.arrayContaining([5000, 5040]));
    expect((await indexer.rss()).length).toBe(2);
  });
});
