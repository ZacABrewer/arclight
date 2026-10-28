import { beforeEach, describe, expect, it } from 'vitest';
import type { IndexerCreate, IndexerSettings } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import type { Db } from '../../db/index.js';
import { albumTypeProfiles, artists } from '../music/schema.js';
import { authors } from '../audiobooks/schema.js';
import { updateFeatureSettings } from '../settings/service.js';
import { indexerCapsCache, indexers } from './schema.js';
import {
  definitionCategories,
  domainFromCategories,
  IndexersService,
  selectCategories,
  toSearchRequest,
  type AudioDomains,
} from './service.js';

// Music / audiobook categories, caps and search kinds. Recorded-style XML only, no network.

const CAPS_AUDIO = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Fake" />
  <limits default="100" max="100" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep,tvdbid" />
    <movie-search available="yes" supportedParams="q,imdbid" />
    <music-search available="yes" supportedParams="q,artist,album,year,label" />
    <book-search available="yes" supportedParams="q,author,title" />
  </searching>
  <categories>
    <category id="3000" name="Audio"><subcat id="3010" name="Audio/MP3" /><subcat id="3030" name="Audio/Audiobook" /></category>
  </categories>
</caps>`;

const CAPS_VIDEO = CAPS_AUDIO.replace(/\s*<music-search[^>]*>/, '').replace(/\s*<book-search[^>]*>/, '');

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fake</title>
<item><title>Artist - Album (2001) [FLAC]</title><guid>g1</guid><pubDate>Sat, 24 Oct 2026 12:00:00 GMT</pubDate>
<size>300000000</size><link>http://dl.example.invalid/g1.torrent</link><torznab:attr name="category" value="3040" /></item>
</channel></rss>`;

const T0 = Date.parse('2026-10-25T12:00:00.000Z');

class FakeNet {
  readonly calls: URL[] = [];
  caps = CAPS_AUDIO;
  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(url);
    const body = url.searchParams.get('t') === 'caps' ? this.caps : FEED;
    return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
  };
  searches(): URL[] {
    return this.calls.filter((u) => u.searchParams.get('t') !== 'caps');
  }
}

function input(name: string, settings: Partial<IndexerCreate['settings']> = {}): IndexerCreate {
  return {
    name,
    implementation: 'torznab',
    settings: { baseUrl: `http://${name.toLowerCase()}.test`, apiKey: 'k', categories: [5000, 2000], ...settings },
  };
}

let db: Db;
let net: FakeNet;
let domains: AudioDomains;
let service: IndexersService;

beforeEach(async () => {
  db = await createTestDb();
  net = new FakeNet();
  domains = { music: false, audiobooks: false };
  service = new IndexersService({ db, fetch: net.fetch, now: () => T0, audioDomains: () => domains });
});

describe('settings: music and audiobook categories', () => {
  it('defaults both lists on create', () => {
    const created = service.create(input('Alpha'));
    expect(created.settings.musicCategories).toEqual([3000, 3010, 3040]);
    expect(created.settings.audiobookCategories).toEqual([3030]);
  });

  it('keeps explicit lists, de-duplicated', () => {
    const created = service.create(input('Alpha', { musicCategories: [3040, 3040, 3010], audiobookCategories: [] }));
    expect(created.settings.musicCategories).toEqual([3040, 3010]);
    expect(created.settings.audiobookCategories).toEqual([]);
  });

  it('accepts an indexer whose only categories are music', () => {
    const created = service.create(input('Music', { categories: [], musicCategories: [3040], audiobookCategories: [] }));
    expect(created.settings.categories).toEqual([]);
  });

  it('rejects an indexer with no category in any list', () => {
    expect(() =>
      service.create(input('None', { categories: [], animeCategories: [], musicCategories: [], audiobookCategories: [] })),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('reads settings saved before music support with the defaults', () => {
    const legacy = { baseUrl: 'http://old.test', apiPath: '/api', categories: [5000], animeCategories: [] } as IndexerSettings;
    const row = db
      .insert(indexers)
      .values({
        name: 'Old',
        implementation: 'torznab',
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 25,
        tags: [],
        settings: legacy,
        addedAt: new Date(T0).toISOString(),
      })
      .returning()
      .get();
    const read = service.get(row.id);
    expect(read.settings).toMatchObject({ categories: [5000], musicCategories: [3000, 3010, 3040], audiobookCategories: [3030] });
    expect(service.list()[0]?.settings.audiobookCategories).toEqual([3030]);

    // An unrelated update stores the defaults; a later update without the lists keeps the saved ones.
    service.update(row.id, { priority: 10 });
    const stored = db.select().from(indexers).all()[0]?.settings;
    expect(stored?.musicCategories).toEqual([3000, 3010, 3040]);
    service.update(row.id, { settings: { musicCategories: [3040] } });
    service.update(row.id, { settings: { categories: [5000, 5040] } });
    expect(service.get(row.id).settings).toMatchObject({ categories: [5000, 5040], musicCategories: [3040], audiobookCategories: [3030] });
  });

  it('templates carry the default audio lists', () => {
    const torznab = service.templates().find((t) => t.implementation === 'torznab');
    expect(torznab?.template.settings).toMatchObject({ musicCategories: [3000, 3010, 3040], audiobookCategories: [3030] });
  });
});

describe('category selection by kind', () => {
  const row = {
    name: 'X',
    implementation: 'torznab' as const,
    settings: {
      baseUrl: 'http://x.test',
      apiPath: '/api',
      categories: [2000, 5000],
      animeCategories: [5070],
      musicCategories: [3040],
      audiobookCategories: [3030],
    },
  };
  const off: AudioDomains = { music: false, audiobooks: false };
  const on: AudioDomains = { music: true, audiobooks: true };

  it('typed searches use their own list whatever the domains', () => {
    expect(selectCategories(row, { kind: 'music', domains: off })).toEqual([3040]);
    expect(selectCategories(row, { kind: 'book', domains: off })).toEqual([3030]);
    expect(selectCategories(row, { kind: 'movie', domains: on })).toEqual([2000]);
    expect(selectCategories(row, { kind: 'tv', domains: on })).toEqual([5000, 5070]);
  });

  it('RSS is the union of the enabled domains', () => {
    expect(selectCategories(row, { kind: 'rss', domains: off })).toEqual([2000, 5000, 5070]);
    expect(selectCategories(row, { kind: 'rss', domains: { music: true, audiobooks: false } })).toEqual([2000, 5000, 5070, 3040]);
    expect(selectCategories(row, { kind: 'rss', domains: { music: false, audiobooks: true } })).toEqual([2000, 5000, 5070, 3030]);
    expect(selectCategories(row, { kind: 'rss', domains: on })).toEqual([2000, 5000, 5070, 3040, 3030]);
  });

  it('a category override replaces every list', () => {
    expect(selectCategories(row, { kind: 'music', domains: off, override: [3010] })).toEqual([3010]);
    expect(selectCategories(row, { kind: 'rss', domains: on, override: [3010] })).toEqual([3010]);
  });

  it('legacy settings fall back to the default audio lists', () => {
    const legacy = { ...row, settings: { ...row.settings, musicCategories: undefined, audiobookCategories: undefined } };
    expect(selectCategories(legacy, { kind: 'music', domains: off })).toEqual([3000, 3010, 3040]);
    expect(selectCategories(legacy, { kind: 'book', domains: off })).toEqual([3030]);
  });

  it('definition indexers pick categories the same way', () => {
    expect(definitionCategories(row, 'music', off)).toEqual([3040]);
    expect(definitionCategories(row, 'book', off)).toEqual([3030]);
    expect(definitionCategories(row, 'movie', on)).toEqual([2000, 5000]);
    expect(definitionCategories(row, 'search', { music: true, audiobooks: false })).toEqual([2000, 5000, 3040]);
    expect(definitionCategories({ settings: { ...row.settings, musicCategories: [] } }, 'music', off)).toBeUndefined();
  });
});

describe('search kinds through the service', () => {
  it('runs a music search as t=music with the music categories', async () => {
    service.create(input('Alpha', { musicCategories: [3040] }));
    const releases = await service.search({ kind: 'music', artist: 'Artist', album: 'Album', year: 2001 }, { mode: 'automatic' });
    expect(releases.map((r) => r.title)).toEqual(['Artist - Album (2001) [FLAC]']);
    const [url] = net.searches();
    expect(url?.searchParams.get('t')).toBe('music');
    expect(url?.searchParams.get('artist')).toBe('Artist');
    expect(url?.searchParams.get('album')).toBe('Album');
    expect(url?.searchParams.get('year')).toBe('2001');
    expect(url?.searchParams.get('cat')).toBe('3040');
  });

  it('runs a book search as t=book with the audiobook categories', async () => {
    service.create(input('Alpha'));
    await service.search({ kind: 'book', author: 'Author', title: 'Title' }, { mode: 'interactive' });
    const [url] = net.searches();
    expect(url?.searchParams.get('t')).toBe('book');
    expect(url?.searchParams.get('author')).toBe('Author');
    expect(url?.searchParams.get('cat')).toBe('3030');
  });

  it('falls back to t=search with "{artist} {album}" when the indexer lacks music search', async () => {
    net.caps = CAPS_VIDEO;
    service.create(input('Alpha'));
    await service.search({ kind: 'music', artist: 'Artist', album: 'Album' }, { mode: 'automatic' });
    const [url] = net.searches();
    expect(url?.searchParams.get('t')).toBe('search');
    expect(url?.searchParams.get('q')).toBe('Artist Album');
    expect(url?.searchParams.get('cat')).toBe('3000,3010,3040');
  });

  it('treats caps cached before music support as lacking music search', async () => {
    const id = service.create(input('Alpha')).id;
    await service.getCaps(id);
    const cached = db.select().from(indexerCapsCache).all()[0]!;
    const { musicSearch: _m, bookSearch: _b, ...searching } = cached.caps.searching;
    db.update(indexerCapsCache).set({ caps: { ...cached.caps, searching } }).run();
    await service.search({ kind: 'music', artist: 'Artist', album: 'Album' }, { mode: 'automatic' });
    expect(net.searches()[0]?.searchParams.get('t')).toBe('search');
  });

  it('exposes music and book search in the stored caps', async () => {
    const id = service.create(input('Alpha')).id;
    const caps = await service.getCaps(id);
    expect(caps.searching.musicSearch).toEqual({ available: true, supportedParams: ['q', 'artist', 'album', 'year', 'label'] });
    expect(caps.searching.bookSearch).toEqual({ available: true, supportedParams: ['q', 'author', 'title'] });
  });

  it('manual search accepts the music and book kinds', async () => {
    service.create(input('Alpha'));
    await service.manualSearch({ type: 'music', artist: 'Artist', album: 'Album' });
    await service.manualSearch({ author: 'Author', title: 'Title' });
    const [music, book] = net.searches();
    expect(music?.searchParams.get('t')).toBe('music');
    expect(book?.searchParams.get('t')).toBe('book');
  });

  it('manual search by album id needs the resolver', async () => {
    service.create(input('Alpha'));
    await expect(service.manualSearch({ albumId: 4 })).rejects.toMatchObject({ code: 'VALIDATION' });
    service.setManualSearchResolver((req) => (req.albumId === 4 ? { kind: 'music', artist: 'A', album: 'B' } : null));
    await service.manualSearch({ albumId: 4 });
    expect(net.searches()[0]?.searchParams.get('album')).toBe('B');
  });
});

describe('toSearchRequest', () => {
  it('infers music and book from their fields', () => {
    expect(toSearchRequest({ artist: 'A', album: 'B', year: 2001 })).toEqual({ kind: 'music', artist: 'A', album: 'B', year: 2001 });
    expect(toSearchRequest({ author: 'A', title: 'T' })).toEqual({ kind: 'book', author: 'A', title: 'T' });
    expect(toSearchRequest({ type: 'music', query: 'free text' })).toEqual({ kind: 'music', query: 'free text' });
    expect(toSearchRequest({ type: 'music', label: 'Warp' })).toBeNull();
    expect(toSearchRequest({ type: 'book' })).toBeNull();
  });
});

describe('RSS category union', () => {
  it('adds music and audiobook categories only for enabled domains', async () => {
    service.create(input('Alpha', { musicCategories: [3040], audiobookCategories: [3030] }));
    await service.rss();
    domains = { music: true, audiobooks: false };
    await service.rss();
    domains = { music: true, audiobooks: true };
    await service.rss();
    expect(net.searches().map((u) => u.searchParams.get('cat'))).toEqual(['5000,2000', '5000,2000,3040', '5000,2000,3040,3030']);
  });
});

describe('audio domains from the database', () => {
  let real: IndexersService;
  beforeEach(() => {
    real = new IndexersService({ db, fetch: net.fetch, now: () => T0 });
  });

  function addArtist(monitored: boolean): void {
    const profile = db
      .insert(albumTypeProfiles)
      .values({ name: `P${Math.random()}`, primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'] })
      .returning()
      .get();
    db.insert(artists)
      .values({
        mbArtistId: `mb-${Math.random()}`,
        name: 'Artist',
        sortName: 'Artist',
        cleanName: 'artist',
        genres: [],
        images: [],
        links: [],
        aliases: [],
        path: `/music/artist-${Math.random()}`,
        rootFolderPath: '/music',
        qualityProfileId: 1,
        albumTypeProfileId: profile.id,
        monitored,
        tags: [],
        added: new Date(T0).toISOString(),
      })
      .run();
  }

  it('is off while the feature flags are off', () => {
    addArtist(true);
    expect(real.audioDomains()).toEqual({ music: false, audiobooks: false });
  });

  it('enables music only with the flag and a monitored artist', () => {
    updateFeatureSettings(db, { music: true, audiobooks: false });
    expect(real.audioDomains().music).toBe(false);
    addArtist(false);
    expect(real.audioDomains().music).toBe(false);
    addArtist(true);
    expect(real.audioDomains().music).toBe(true);
  });

  function addAuthor(monitored: boolean): void {
    db.insert(authors)
      .values({
        asin: null,
        name: 'Author',
        sortName: 'Author',
        cleanName: 'author',
        images: [],
        genres: [],
        aliases: [],
        path: `/audiobooks/author-${Math.random()}`,
        rootFolderPath: '/audiobooks',
        qualityProfileId: 1,
        monitored,
        languages: [],
        tags: [],
        added: new Date(T0).toISOString(),
      })
      .run();
  }

  it('enables audiobooks only with the flag and a monitored author', () => {
    addAuthor(true);
    expect(real.audioDomains().audiobooks).toBe(false);
    updateFeatureSettings(db, { music: false, audiobooks: true });
    db.delete(authors).run();
    expect(real.audioDomains().audiobooks).toBe(false);
    addAuthor(false);
    expect(real.audioDomains().audiobooks).toBe(false);
    addAuthor(true);
    expect(real.audioDomains()).toEqual({ music: false, audiobooks: true });
  });
});

describe('domainFromCategories', () => {
  it('is re-exported for the releases module', () => {
    expect(domainFromCategories([3030])).toBe('audiobook');
    expect(domainFromCategories([3000, 3040])).toBe('music');
    expect(domainFromCategories([3020])).toBe('auto');
    expect(domainFromCategories([5040])).toBe('series');
    expect(domainFromCategories([2040])).toBe('movie');
  });
});
