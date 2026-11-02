import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createLastfmClient, plainBio } from './client.js';

const ARTIST = '33333333-3333-4333-8333-333333333333';
const REC = '55555555-5555-4555-8555-555555555555';
const SIM = '66666666-6666-4666-8666-666666666666';

function makeClient(route: Responder) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createLastfmClient({ apiKey: 'key-1', fetchImpl: fake.fetch, rateLimiter: new RateLimiter({ clock, random: () => 0 }), now: () => new Date(clock.now()), maxRetries: 0 });
  return { client, fake };
}

const route: Responder = (url) => {
  switch (url.searchParams.get('method')) {
    case 'user.gettoptracks':
      return jsonResponse({
        toptracks: {
          track: [
            { name: 'Top One', mbid: REC, duration: '245', artist: { name: 'Example Band', mbid: ARTIST } },
            { name: 'Top Two', mbid: '', duration: '0', artist: { name: 'Other Band', mbid: '' } },
            { name: '', artist: { name: 'Nobody' } },
          ],
        },
      });
    case 'user.getlovedtracks':
      // One loved track: Last.fm sends an object instead of a list.
      return jsonResponse({ lovedtracks: { track: { name: 'Loved', mbid: '', artist: { name: 'Example Band', mbid: ARTIST } } } });
    case 'user.gettopalbums':
      return jsonResponse({ topalbums: { album: [{ name: 'Great Album', mbid: '', playcount: '77', artist: { name: 'Example Band', mbid: ARTIST } }] } });
    case 'artist.getsimilar':
      return jsonResponse({ similarartists: { artist: [{ name: 'Similar Band', mbid: SIM, match: '0.83' }, { name: 'No Id Band', mbid: '', match: '0.5' }] } });
    case 'artist.getinfo':
      return url.searchParams.get('artist') === 'Missing'
        ? jsonResponse({ error: 6, message: 'The artist you supplied could not be found' })
        : jsonResponse({ artist: { name: 'Example Band', mbid: ARTIST, url: 'https://www.last.fm/music/Example+Band', bio: { summary: 'A band &amp; more. <a href="https://www.last.fm/music/x">Read more on Last.fm</a>', content: '<b>Long</b> story.' } } });
    default:
      return jsonResponse({ error: 3, message: 'Invalid Method' });
  }
};

describe('createLastfmClient', () => {
  it('sends the key and json format', async () => {
    const { client, fake } = makeClient(route);
    await client.topTracks({ user: 'listener', period: '7day', limit: 10 });
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get('api_key')).toBe('key-1');
    expect(q.get('format')).toBe('json');
    expect(q.get('period')).toBe('7day');
    expect(q.get('user')).toBe('listener');
  });

  it('maps top and loved tracks', async () => {
    const { client } = makeClient(route);
    expect(await client.topTracks({ user: 'listener' })).toEqual([
      { title: 'Top One', artist: 'Example Band', durationMs: 245_000, recordingMbid: REC, artistMbids: [ARTIST] },
      { title: 'Top Two', artist: 'Other Band' },
    ]);
    expect(await client.lovedTracks({ user: 'listener' })).toEqual([{ title: 'Loved', artist: 'Example Band', artistMbids: [ARTIST] }]);
  });

  it('maps top albums and similar artists', async () => {
    const { client, fake } = makeClient(route);
    expect(await client.topAlbums({ user: 'listener' })).toEqual([{ title: 'Great Album', artist: 'Example Band', artistMbid: ARTIST, playcount: 77 }]);
    expect(await client.similarArtists({ mbid: ARTIST })).toEqual([
      { name: 'Similar Band', mbid: SIM, match: 0.83 },
      { name: 'No Id Band', match: 0.5 },
    ]);
    expect(fake.calls.at(-1)!.url.searchParams.get('mbid')).toBe(ARTIST);
  });

  it('reads a biography as plain text and answers undefined for unknown artists', async () => {
    const { client } = makeClient(route);
    expect(await client.artistBio({ name: 'Example Band' })).toEqual({
      name: 'Example Band',
      mbid: ARTIST,
      summary: 'A band & more.',
      content: 'Long story.',
      url: 'https://www.last.fm/music/Example+Band',
    });
    expect(await client.artistBio({ name: 'Missing' })).toBeUndefined();
  });

  it('maps error codes inside HTTP 200 bodies', async () => {
    const { client } = makeClient(() => jsonResponse({ error: 10, message: 'Invalid API key' }));
    await expect(client.topTracks({ user: 'listener' })).rejects.toMatchObject({ name: 'MetadataError', code: 'unauthorized' });
    const { client: c2 } = makeClient(() => jsonResponse({ error: 6, message: 'User not found' }));
    await expect(c2.lovedTracks({ user: 'nobody' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('strips HTML from bios', () => {
    expect(plainBio('<p>Hi &quot;there&quot;</p> <a href="x">Read more on Last.fm</a>')).toBe('Hi "there"');
    expect(plainBio(undefined)).toBe('');
  });
});
