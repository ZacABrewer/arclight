import { describe, expect, it } from 'vitest';
import { MetadataError, isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import {
  MB_IDS,
  createInstantClock,
  createManualClock,
  mbFixtures,
  musicBrainzRoute,
  throttledResponse,
} from '../music-test-support.js';
import {
  buildMusicBrainzUserAgent,
  createMusicBrainzClient,
  escapeLucene,
  type MusicBrainzClientOptions,
} from './client.js';

const UA = 'Arclight-test/0.0 ( https://example.invalid/arclight )';

function makeClient(
  route: Parameters<typeof createFakeFetch>[0] = musicBrainzRoute,
  extra: Partial<MusicBrainzClientOptions> = {},
) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  const client = createMusicBrainzClient({
    userAgent: UA,
    fetchImpl: fake.fetch,
    rateLimiter: limiter,
    now: () => new Date(clock.now()),
    ...extra,
  });
  return { client, fake, clock, limiter };
}

describe('createMusicBrainzClient construction', () => {
  it('refuses to construct without a User-Agent', () => {
    expect(() => createMusicBrainzClient({ userAgent: '' })).toThrow(/User-Agent/);
    expect(() => createMusicBrainzClient({ userAgent: '   ' })).toThrow(/User-Agent/);
    expect(() =>
      createMusicBrainzClient(undefined as unknown as MusicBrainzClientOptions),
    ).toThrow(/User-Agent/);
  });

  it('sends the User-Agent, Accept header and fmt=json', async () => {
    const { client, fake } = makeClient();
    await client.getArtist(MB_IDS.artist);
    const call = fake.calls[0];
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(UA);
    expect(headers.Accept).toBe('application/json');
    expect(call?.url.origin).toBe('https://musicbrainz.org');
    expect(call?.url.pathname).toBe(`/ws/2/artist/${MB_IDS.artist}`);
    expect(call?.url.searchParams.get('fmt')).toBe('json');
    expect(call?.url.searchParams.get('inc')).toBe('aliases+genres+url-rels');
  });

  it('builds a User-Agent string', () => {
    expect(
      buildMusicBrainzUserAgent({ app: 'Arclight', version: '0.4.0', contact: 'https://example.org/x' }),
    ).toBe('Arclight/0.4.0 ( https://example.org/x )');
  });

  it('locks the public host at 1 req/s even when a higher rate is asked for', () => {
    const { client, limiter } = makeClient(musicBrainzRoute, { requestsPerSecond: 10 });
    expect(client.providerKey).toBe('musicbrainz');
    expect(limiter.limitOf('musicbrainz').requestsPerSecond).toBe(1);
  });

  it('lets a custom mirror use its configured rate on its own bucket', async () => {
    const { client, limiter, fake } = makeClient(musicBrainzRoute, {
      baseUrl: 'http://mirror.local:5000/ws/2',
      requestsPerSecond: 10,
    });
    expect(client.providerKey).toBe('musicbrainz@mirror.local:5000');
    expect(limiter.limitOf(client.providerKey).requestsPerSecond).toBe(10);
    await client.getArtist(MB_IDS.artist);
    expect(fake.calls[0]?.url.toString()).toMatch(
      /^http:\/\/mirror\.local:5000\/ws\/2\/artist\/a74b1b7f/,
    );
  });
});

describe('MusicBrainz artists', () => {
  it('searches artists with an escaped Lucene query', async () => {
    const { client, fake } = makeClient();
    const page = await client.searchArtists('AC/DC: live!', { limit: 5 });
    const url = fake.calls[0]?.url;
    expect(url?.pathname).toBe('/ws/2/artist');
    expect(url?.searchParams.get('query')).toBe('AC\\/DC\\: live\\!');
    expect(url?.searchParams.get('limit')).toBe('5');
    expect(page.count).toBe(29);
    expect(page.results).toHaveLength(5);
    expect(page.results[0]).toMatchObject({
      mbid: MB_IDS.artist,
      name: 'Radiohead',
      sortName: 'Radiohead',
      type: 'Group',
      country: 'GB',
      score: 100,
      status: 'continuing',
    });
    expect(page.results[1]?.disambiguation).toBe('pre‐Radiohead group, until 1991');
  });

  it('skips the request for an empty query', async () => {
    const { client, fake } = makeClient();
    expect(await client.searchArtists('  ')).toEqual({ count: 0, offset: 0, results: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it('maps an artist with genres, aliases and links', async () => {
    const { client } = makeClient();
    const artist = await client.getArtist(MB_IDS.artist);
    expect(artist).toMatchObject({
      mbid: MB_IDS.artist,
      name: 'Radiohead',
      sortName: 'Radiohead',
      type: 'Group',
      country: 'GB',
      area: 'United Kingdom',
      beginDate: '1991',
      status: 'continuing',
    });
    expect(artist.disambiguation).toBeUndefined();
    expect(artist.genres[0]).toBe('alternative rock');
    expect(artist.aliases).toContainEqual(
      expect.objectContaining({ name: 'Radiohead', locale: 'en', primary: true, type: 'Artist name' }),
    );
    expect(artist.links).toContainEqual({ type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q44190' });
    expect(artist.links.find((l) => l.type === 'official homepage')).toBeDefined();
  });

  it('marks an artist whose life span ended', async () => {
    const ended = { ...mbFixtures.artist, 'life-span': { begin: '1985', end: '2001', ended: true } };
    const { client } = makeClient(() => jsonResponse(ended));
    const artist = await client.getArtist(MB_IDS.artist);
    expect(artist.status).toBe('ended');
    expect(artist.endDate).toBe('2001');
  });
});

describe('MusicBrainz release groups and releases', () => {
  it('pages release-group browse by 100 until the count is reached', async () => {
    const { client, fake } = makeClient();
    const groups = await client.browseReleaseGroups(MB_IDS.artist);
    const urls = fake.calls.map((c) => c.url);
    expect(urls).toHaveLength(2);
    expect(urls.map((u) => u.searchParams.get('offset'))).toEqual(['0', '100']);
    for (const u of urls) {
      expect(u.pathname).toBe('/ws/2/release-group');
      expect(u.searchParams.get('artist')).toBe(MB_IDS.artist);
      expect(u.searchParams.get('type')).toBe('album|ep|single');
      expect(u.searchParams.get('limit')).toBe('100');
    }
    expect(groups).toHaveLength(140);
    // Oldest first.
    expect(groups[0]?.firstReleaseDate).toBe('1992');
    const okc = groups.find((g) => g.mbid === MB_IDS.releaseGroup);
    expect(okc).toMatchObject({
      title: 'OK Computer',
      primaryType: 'Album',
      secondaryTypes: [],
      firstReleaseDate: '1997-05-21',
      year: 1997,
      artistCredits: [],
    });
    expect(groups.some((g) => g.secondaryTypes.includes('Live'))).toBe(true);
  });

  it('stops paging on an empty page even if the count says more', async () => {
    let calls = 0;
    const { client } = makeClient((url) => {
      calls += 1;
      const offset = Number(url.searchParams.get('offset'));
      return jsonResponse({
        'release-group-count': 500,
        'release-group-offset': offset,
        'release-groups': offset === 0 ? mbFixtures.releaseGroupsPage1['release-groups'].slice(0, 3) : [],
      });
    });
    const groups = await client.browseReleaseGroups(MB_IDS.artist, { types: ['album'] });
    expect(groups).toHaveLength(3);
    expect(calls).toBe(2);
  });

  it('browses releases of a release group with media', async () => {
    const { client, fake } = makeClient();
    const releases = await client.browseReleases(MB_IDS.releaseGroup);
    const url = fake.calls[0]?.url;
    expect(url?.searchParams.get('release-group')).toBe(MB_IDS.releaseGroup);
    expect(url?.searchParams.get('inc')).toBe('media');
    expect(fake.calls).toHaveLength(1);
    expect(releases).toHaveLength(39);
    const us = releases.find((r) => r.mbid === MB_IDS.release);
    expect(us).toMatchObject({
      releaseGroupMbid: MB_IDS.releaseGroup,
      title: 'OK Computer',
      status: 'Official',
      country: 'US',
      date: '1997-07-01',
      year: 1997,
      formats: ['CD'],
      mediumCount: 1,
      trackCount: 12,
      media: [{ position: 1, format: 'CD', trackCount: 12 }],
    });
    const deluxe = releases.find((r) => r.mbid === MB_IDS.release2disc);
    expect(deluxe).toMatchObject({ formats: ['CD', 'CD'], mediumCount: 2, trackCount: 23 });
  });

  it('maps a release with tracks, durations in ms and labels', async () => {
    const { client, fake } = makeClient();
    const release = await client.getRelease(MB_IDS.release);
    expect(fake.calls[0]?.url.searchParams.get('inc')).toBe('recordings+artist-credits+media+labels');
    expect(release).toMatchObject({
      mbid: MB_IDS.release,
      title: 'OK Computer',
      country: 'US',
      mediumCount: 1,
      trackCount: 12,
      durationMs: 3207156,
    });
    expect(release.artistCredits).toEqual([
      { artistMbid: MB_IDS.artist, name: 'Radiohead', creditedName: 'Radiohead', joinPhrase: '' },
    ]);
    expect(release.labels[0]).toMatchObject({ name: 'Capitol Records', catalogNumber: 'CDP 7243 8 55229 2 5' });
    const tracks = release.media[0]?.tracks ?? [];
    expect(tracks).toHaveLength(12);
    expect(tracks[0]).toMatchObject({
      title: 'Airbag',
      number: '1',
      position: 1,
      mediumNumber: 1,
      absoluteNumber: 1,
      durationMs: 284400,
      recordingMbid: '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7',
    });
    expect(tracks[1]?.durationMs).toBe(383493);
  });

  it('numbers tracks across discs', async () => {
    const { client } = makeClient();
    const release = await client.getRelease(MB_IDS.release2disc);
    expect(release.media.map((m) => [m.position, m.format, m.trackCount])).toEqual([
      [1, 'CD', 12],
      [2, 'CD', 11],
    ]);
    const disc2 = release.media[1]?.tracks ?? [];
    expect(disc2[0]).toMatchObject({ title: 'I Promise', mediumNumber: 2, position: 1, absoluteNumber: 13 });
    expect(disc2.at(-1)?.absoluteNumber).toBe(23);
    expect(release.labels).toEqual([
      expect.objectContaining({ name: 'XL Recordings', catalogNumber: 'XLCD868' }),
    ]);
    expect(release.barcode).toBe('634904086824');
  });

  it('searches release groups by artist and title with quoted phrases', async () => {
    const { client, fake } = makeClient();
    const page = await client.searchReleaseGroups({ artist: 'Radiohead', title: 'OK "Computer"' });
    expect(fake.calls[0]?.url.searchParams.get('query')).toBe(
      'releasegroup:"OK \\"Computer\\"" AND artist:"Radiohead"',
    );
    expect(page.results[0]).toMatchObject({
      mbid: MB_IDS.releaseGroup,
      title: 'OK Computer',
      primaryType: 'Album',
      score: 100,
    });
    expect(page.results[0]?.artistCredits[0]?.artistMbid).toBe(MB_IDS.artist);
  });
});

describe('MusicBrainz caching', () => {
  it('caches responses and expires them after the TTL', async () => {
    const clock = createInstantClock(0);
    const fake = createFakeFetch(musicBrainzRoute);
    let now = 0;
    const client = createMusicBrainzClient({
      userAgent: UA,
      fetchImpl: fake.fetch,
      rateLimiter: new RateLimiter({ clock }),
      now: () => new Date(now),
      cacheTtls: { artist: 1000 },
    });
    await client.getArtist(MB_IDS.artist);
    await client.getArtist(MB_IDS.artist);
    expect(fake.calls).toHaveLength(1);
    now += 5000;
    await client.getArtist(MB_IDS.artist);
    expect(fake.calls).toHaveLength(2);
    client.clearCache();
    await client.getArtist(MB_IDS.artist);
    expect(fake.calls).toHaveLength(3);
  });

  it('shares one request between identical concurrent calls', async () => {
    const { client, fake } = makeClient();
    await Promise.all([client.getArtist(MB_IDS.artist), client.getArtist(MB_IDS.artist)]);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('MusicBrainz rate limiting', () => {
  it('spaces calls one second apart on the public host', async () => {
    const { client, clock, fake } = makeClient(musicBrainzRoute, { cacheTtls: { release: 0 } });
    await client.getRelease(MB_IDS.release);
    await client.getRelease(MB_IDS.release);
    await client.getRelease(MB_IDS.release);
    expect(fake.calls).toHaveLength(3);
    expect(clock.elapsed()).toBe(2000);
  });

  it('serves an interactive lookup before queued background browsing', async () => {
    const clock = createManualClock(0);
    const fake = createFakeFetch(musicBrainzRoute);
    const client = createMusicBrainzClient({
      userAgent: UA,
      fetchImpl: fake.fetch,
      rateLimiter: new RateLimiter({ clock }),
      now: () => new Date(clock.now()),
    });
    const background = client.browseReleaseGroups(MB_IDS.artist, { priority: 'background' });
    const background2 = client.browseReleases(MB_IDS.releaseGroup, { priority: 'background' });
    const interactive = client.searchArtists('radiohead', { priority: 'interactive' });
    await clock.advance(10_000);
    await Promise.all([background, background2, interactive]);
    expect(fake.calls.map((c) => `${c.url.pathname}?${c.url.searchParams.get('offset') ?? ''}`)).toEqual([
      '/ws/2/release-group?0',
      '/ws/2/artist?0',
      '/ws/2/release?0',
      '/ws/2/release-group?100',
    ]);
  });

  it('retries a 503 after Retry-After and then succeeds', async () => {
    let attempts = 0;
    const { client, clock } = makeClient((url) => {
      attempts += 1;
      return attempts === 1 ? throttledResponse(3) : musicBrainzRoute(url);
    });
    const artist = await client.getArtist(MB_IDS.artist);
    expect(artist.name).toBe('Radiohead');
    expect(attempts).toBe(2);
    expect(clock.elapsed()).toBe(3000);
  });
});

describe('MusicBrainz errors', () => {
  it('maps 404 to not-found', async () => {
    const { client } = makeClient();
    const err = await client.getArtist(MB_IDS.missing).catch((e: unknown) => e);
    expect(isMetadataError(err, 'not-found')).toBe(true);
    expect((err as MetadataError).httpStatus).toBe(404);
  });

  it('rejects malformed MBIDs without a request', async () => {
    const { client, fake } = makeClient();
    await expect(client.getRelease('not-an-mbid')).rejects.toMatchObject({ code: 'not-found' });
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a persistent 503 to rate-limited after the retries', async () => {
    const { client, fake } = makeClient(() => throttledResponse(), { maxRetries: 2 });
    const err = await client.getArtist(MB_IDS.artist).catch((e: unknown) => e);
    expect(isMetadataError(err, 'rate-limited')).toBe(true);
    expect((err as MetadataError).httpStatus).toBe(503);
    expect((err as MetadataError).message).toMatch(/busy/);
    expect(fake.calls).toHaveLength(3);
  });

  it('maps other HTTP errors and malformed bodies to bad-response', async () => {
    const { client } = makeClient(() =>
      jsonResponse({ error: 'Invalid mbid.', help: 'see docs' }, 400),
    );
    await expect(client.getArtist(MB_IDS.artist)).rejects.toMatchObject({
      code: 'bad-response',
      httpStatus: 400,
      message: expect.stringMatching(/Invalid mbid/),
    });
    const { client: bad } = makeClient(() => jsonResponse({ unexpected: true }));
    await expect(bad.getRelease(MB_IDS.release)).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('maps network failures to unreachable', async () => {
    const { client } = makeClient(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client.getArtist(MB_IDS.artist)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('passes an abort through', async () => {
    const { client } = makeClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.getArtist(MB_IDS.artist, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('escapeLucene', () => {
  it('escapes query syntax', () => {
    expect(escapeLucene('a+b (c) "d" e:f g/h')).toBe('a\\+b \\(c\\) \\"d\\" e\\:f g\\/h');
    expect(escapeLucene('Simon && Garfunkel')).toBe('Simon \\&& Garfunkel');
  });
});
