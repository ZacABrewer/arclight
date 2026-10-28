import { describe, expect, it } from 'vitest';
import newznabAudioCapsXml from '../fixtures/newznab-audio-caps.xml?raw';
import torznabCapsXml from '../fixtures/torznab-caps.xml?raw';
import torznabMusicCapsXml from '../fixtures/torznab-music-caps.xml?raw';
import { DEFAULT_AUDIOBOOK_CATEGORIES, DEFAULT_MUSIC_CATEGORIES, domainFromCategories } from './categories.js';
import { parseDefinitionYaml } from './definitions/catalogue.js';
import { createDefinitionIndexer } from './definitions/indexer.js';
import { queryVariables } from './definitions/runtime.js';
import { parseCaps } from './newznab-common/caps.js';
import { buildSearchUrl, categoriesFor, planSearch, type Flavor } from './newznab-common/query.js';
import { parseResponse } from './newznab-common/xml.js';
import { fakeFetch } from './testing/fake-fetch.js';
import { IndexerError, type IndexerCapabilities, type IndexerDefinition, type SearchRequest } from './types.js';

const parse = (body: string) => parseCaps(parseResponse({ status: 200, body, safeUrl: 'x', hadApiKey: true }));
const musicCaps = parse(torznabMusicCapsXml);
const newznabAudioCaps = parse(newznabAudioCapsXml);
const plainCaps = parse(torznabCapsXml);
/** Same as the music caps but without music/book search: forces the `t=search` fallback. */
const noAudioCaps: IndexerCapabilities = {
  ...musicCaps,
  searching: {
    ...musicCaps.searching,
    musicSearch: { available: false, supportedParams: [] },
    bookSearch: { available: false, supportedParams: [] },
  },
};

const def: IndexerDefinition = {
  name: 'Jackett',
  baseUrl: 'http://jackett.example.invalid/api/v2.0/indexers/all/results/torznab',
  apiKey: 'secret',
  categories: [2000, 5000],
  animeCategories: [5070],
  musicCategories: [3000, 3040],
  audiobookCategories: [3030, 100412],
  protocol: 'torrent',
};

function url(req: SearchRequest, caps: IndexerCapabilities = musicCaps, d = def, flavor: Flavor = 'torznab'): URL {
  return new URL(buildSearchUrl(d, planSearch(d, req, caps, flavor), { limit: 100 }));
}

describe('caps: music and book search modes', () => {
  it('reads music-search and book-search from Torznab caps, keeping only params Arclight uses', () => {
    expect(musicCaps.searching.musicSearch).toEqual({
      available: true,
      supportedParams: ['q', 'album', 'artist', 'label', 'year', 'genre'],
    });
    expect(musicCaps.searching.bookSearch).toEqual({ available: true, supportedParams: ['q', 'title', 'author'] });
  });

  it('does not leak audio params into video modes', () => {
    expect(musicCaps.searching.tvSearch.supportedParams).toEqual(['q', 'season', 'ep', 'imdbid', 'tvdbid']);
    expect(musicCaps.searching.movieSearch.supportedParams).toEqual(['q', 'imdbid']);
  });

  it('reads Newznab audio-search as music search', () => {
    expect(newznabAudioCaps.searching.musicSearch).toEqual({ available: true, supportedParams: ['q', 'artist', 'album'] });
    expect(newznabAudioCaps.searching.bookSearch).toEqual({ available: false, supportedParams: [] });
  });

  it('uses music-search when audio-search is advertised as unavailable', () => {
    expect(plainCaps.searching.musicSearch).toEqual({ available: true, supportedParams: ['q', 'artist', 'album'] });
    expect(plainCaps.searching.bookSearch.available).toBe(false);
  });

  it('marks both modes unavailable when the caps omit them', () => {
    const caps = parse('<caps><searching><search available="yes" supportedParams="q"/></searching></caps>');
    expect(caps.searching.musicSearch).toEqual({ available: false, supportedParams: [] });
    expect(caps.searching.bookSearch).toEqual({ available: false, supportedParams: [] });
  });
});

describe('query mapping: music', () => {
  it('maps artist/album/year/label to t=music with the music categories', () => {
    const u = url({ kind: 'music', artist: 'Boards of Canada', album: 'Geogaddi', year: 2002, label: 'Warp' });
    expect(u.searchParams.get('t')).toBe('music');
    expect(u.searchParams.get('artist')).toBe('Boards of Canada');
    expect(u.searchParams.get('album')).toBe('Geogaddi');
    expect(u.searchParams.get('label')).toBe('Warp');
    expect(u.searchParams.get('year')).toBe('2002');
    expect(u.searchParams.get('q')).toBeNull();
    expect(u.searchParams.get('cat')).toBe('3000,3040');
  });

  it('sends q alongside structured fields when given', () => {
    const u = url({ kind: 'music', query: 'Geogaddi FLAC', artist: 'Boards of Canada' });
    expect(u.searchParams.get('t')).toBe('music');
    expect(u.searchParams.get('q')).toBe('Geogaddi FLAC');
    expect(u.searchParams.get('artist')).toBe('Boards of Canada');
  });

  it('folds unsupported fields into q (Newznab audio-search without label/year)', () => {
    const u = url({ kind: 'music', artist: 'Artist', album: 'Album', year: 1999, label: 'Label' }, newznabAudioCaps, { ...def, protocol: 'usenet' }, 'newznab');
    expect(u.searchParams.get('t')).toBe('music');
    expect(u.searchParams.get('artist')).toBe('Artist');
    expect(u.searchParams.get('label')).toBeNull();
    expect(u.searchParams.get('year')).toBeNull();
  });

  it('puts an artist the mode cannot take into q', () => {
    const caps: IndexerCapabilities = {
      ...musicCaps,
      searching: { ...musicCaps.searching, musicSearch: { available: true, supportedParams: ['q', 'album'] } },
    };
    const u = url({ kind: 'music', artist: 'Artist', album: 'Album' }, caps);
    expect(u.searchParams.get('t')).toBe('music');
    expect(u.searchParams.get('q')).toBe('Artist');
    expect(u.searchParams.get('album')).toBe('Album');
  });

  it('falls back to t=search with q="{artist} {album}" without music search', () => {
    const u = url({ kind: 'music', artist: 'Boards of Canada', album: 'Geogaddi', year: 2002 }, noAudioCaps);
    expect(u.searchParams.get('t')).toBe('search');
    expect(u.searchParams.get('q')).toBe('Boards of Canada Geogaddi');
    expect(u.searchParams.get('artist')).toBeNull();
    expect(u.searchParams.get('cat')).toBe('3000,3040');
  });

  it('falls back to the explicit query when one is given', () => {
    const u = url({ kind: 'music', query: 'Geogaddi', artist: 'Boards of Canada' }, noAudioCaps);
    expect(u.searchParams.get('q')).toBe('Geogaddi');
  });

  it('rejects a music search with nothing to search for', () => {
    expect(() => planSearch(def, { kind: 'music', year: 2002 }, noAudioCaps, 'torznab')).toThrow(IndexerError);
    expect(() => planSearch(def, { kind: 'music', artist: '  ' }, musicCaps, 'torznab')).toThrow(/music/);
  });
});

describe('query mapping: book', () => {
  it('maps author/title to t=book with the audiobook categories', () => {
    const u = url({ kind: 'book', author: 'Ursula K. Le Guin', title: 'The Dispossessed' });
    expect(u.searchParams.get('t')).toBe('book');
    expect(u.searchParams.get('author')).toBe('Ursula K. Le Guin');
    expect(u.searchParams.get('title')).toBe('The Dispossessed');
    expect(u.searchParams.get('cat')).toBe('3030,100412');
  });

  it('falls back to t=search with q="{author} {title}" without book search', () => {
    const u = url({ kind: 'book', author: 'Ursula K. Le Guin', title: 'The Dispossessed' }, noAudioCaps);
    expect(u.searchParams.get('t')).toBe('search');
    expect(u.searchParams.get('q')).toBe('Ursula K. Le Guin The Dispossessed');
    expect(u.searchParams.get('cat')).toBe('3030,100412');
  });

  it('uses free text through book search when only a query is given', () => {
    const u = url({ kind: 'book', query: 'B00ABC1234' });
    expect(u.searchParams.get('t')).toBe('book');
    expect(u.searchParams.get('q')).toBe('B00ABC1234');
  });
});

describe('categoriesFor by request kind', () => {
  it('picks the list that follows the kind', () => {
    expect(categoriesFor(def, 'music')).toEqual([3000, 3040]);
    expect(categoriesFor(def, 'book')).toEqual([3030, 100412]);
    expect(categoriesFor(def, 'movie')).toEqual([2000]);
    expect(categoriesFor(def, 'tv')).toEqual([5000, 5070]);
  });

  it('defaults the audio lists when the definition has none', () => {
    const bare: IndexerDefinition = { name: 'x', baseUrl: 'http://x.invalid', categories: [2000], protocol: 'torrent' };
    expect(categoriesFor(bare, 'music')).toEqual([...DEFAULT_MUSIC_CATEGORIES]);
    expect(categoriesFor(bare, 'book')).toEqual([...DEFAULT_AUDIOBOOK_CATEGORIES]);
    // RSS / free text add audio lists only when the definition carries them.
    expect(categoriesFor(bare, 'rss')).toEqual([2000]);
  });

  it('RSS uses the union of every configured list', () => {
    expect(categoriesFor(def, 'rss')).toEqual([2000, 5000, 5070, 3000, 3040, 3030, 100412]);
    const u = url({ kind: 'rss' });
    expect(u.searchParams.get('cat')).toBe('2000,5000,5070,3000,3040,3030,100412');
  });
});

describe('domainFromCategories', () => {
  it.each([
    [[], 'auto'],
    [[5000, 5040], 'series'],
    [[2000, 2040], 'movie'],
    [[2040, 5040], 'auto'],
    [[3030], 'audiobook'],
    [[3000, 3030], 'audiobook'],
    [[3000], 'music'],
    [[3010], 'music'],
    [[3000, 3040], 'music'],
    [[3050, 3060], 'music'],
    [[3020], 'auto'],
    [[3000, 3020], 'auto'],
    [[3010, 3030], 'auto'],
    [[3040, 100410], 'auto'],
    [[3010, 5040], 'auto'],
    [[7020], 'auto'],
  ] as const)('%j -> %s', (cats, expected) => {
    expect(domainFromCategories(cats)).toBe(expected);
  });
});

const MUSIC_SITE = `
id: musicsite
name: MusicSite
type: public
links: [https://music.example.invalid/]
caps:
  categorymappings:
    - {id: 10, cat: Audio/MP3, desc: "MP3"}
    - {id: 11, cat: Audio/Lossless, desc: "FLAC"}
    - {id: 12, cat: Audio/Audiobook, desc: "Audiobooks"}
  modes:
    search: [q]
    music-search: [q, artist, album, year, track]
    book-search: [q, author, title, publisher]
search:
  paths:
    - path: "browse"
  inputs:
    $raw: "{{ range .Categories }}c={{.}}&{{end}}"
    q: "{{ .Keywords }}"
    artist: "{{ .Query.Artist }}"
    author: "{{ .Query.Author }}"
  rows:
    selector: "tr.row"
  fields:
    title: {selector: "td.name"}
    download: {selector: "a.dl", attribute: href}
    size: {selector: "td.size"}
`;

describe('definition indexers', () => {
  const indexer = (fetchImpl?: typeof fetch) =>
    createDefinitionIndexer(parseDefinitionYaml(MUSIC_SITE), {}, { ...(fetchImpl ? { fetchImpl } : {}), sleep: async () => {} });

  it('expose music and book search from their YAML caps', async () => {
    const caps = await indexer().caps();
    expect(caps.searching.musicSearch).toEqual({ available: true, supportedParams: ['q', 'artist', 'album', 'year'] });
    expect(caps.searching.bookSearch).toEqual({ available: true, supportedParams: ['q', 'author', 'title'] });
    expect(caps.searching.tvSearch.available).toBe(false);
  });

  it('builds music and book query variables with a keyword fallback', () => {
    const music = queryVariables({ kind: 'music', artist: 'Artist', album: 'Album', year: 2001, label: 'Label' });
    expect(music['Query.Type']).toBe('music');
    expect(music['Query.Artist']).toBe('Artist');
    expect(music['Query.Album']).toBe('Album');
    expect(music['Query.Label']).toBe('Label');
    expect(music['Query.Year']).toBe('2001');
    expect(music['Query.Q']).toBe('Artist Album');
    expect(music['Query.Keywords']).toBe('Artist Album 2001');
    expect(queryVariables({ kind: 'music', query: 'Exact', artist: 'Artist' })['Query.Q']).toBe('Exact');
    const book = queryVariables({ kind: 'book', author: 'Author', title: 'Title' });
    expect(book['Query.Type']).toBe('book');
    expect(book['Query.Author']).toBe('Author');
    expect(book['Query.Title']).toBe('Title');
    expect(book['Query.Keywords']).toBe('Author Title');
  });

  it('runs a music search through the site search path with mapped categories', async () => {
    const ff = fakeFetch(() => ({ body: '<html><table></table></html>', contentType: 'text/html' }));
    await indexer(ff.fetch).search({ kind: 'music', artist: 'Artist', album: 'Album', categories: [3040] });
    expect(ff.calls.map((c) => c.url)).toEqual(['https://music.example.invalid/browse?c=11&q=Artist+Album&artist=Artist']);
    ff.calls.length = 0;
    await indexer(ff.fetch).search({ kind: 'book', author: 'Author', title: 'Title', categories: [3030] });
    expect(ff.calls.map((c) => c.url)).toEqual(['https://music.example.invalid/browse?c=12&q=Author+Title&author=Author']);
  });
});
