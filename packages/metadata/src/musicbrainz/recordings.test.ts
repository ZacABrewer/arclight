import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createMusicBrainzClient } from './client.js';

const UA = 'Arclight-test/0.0 ( https://example.invalid/arclight )';
const REC = '55555555-5555-4555-8555-555555555555';
const ARTIST = '33333333-3333-4333-8333-333333333333';
const RELEASE = '44444444-4444-4444-8444-444444444444';
const RG = '11111111-1111-4111-8111-111111111111';

const recording = {
  id: REC.toUpperCase(),
  title: 'Example Song',
  length: 201500,
  'first-release-date': '2024-03-01',
  'artist-credit': [{ name: 'Example Band', joinphrase: '', artist: { id: ARTIST, name: 'Example Band' } }],
  isrcs: ['usabc2400001'],
  releases: [
    {
      id: RELEASE,
      title: 'Example Album',
      status: 'Official',
      date: '2024-03-01',
      country: 'XW',
      'release-group': { id: RG, title: 'Example Album', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2024-03-01' },
    },
  ],
};

function makeClient(route: Responder) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createMusicBrainzClient({ userAgent: UA, fetchImpl: fake.fetch, rateLimiter: new RateLimiter({ clock, random: () => 0 }), now: () => new Date(clock.now()) });
  return { client, fake };
}

describe('MusicBrainz recordings', () => {
  it('looks a recording up with its releases', async () => {
    const { client, fake } = makeClient(() => jsonResponse(recording));
    const rec = await client.getRecording(REC);
    expect(fake.calls[0]!.url.pathname).toBe(`/ws/2/recording/${REC}`);
    expect(fake.calls[0]!.url.searchParams.get('inc')).toBe('releases+release-groups+artist-credits+isrcs');
    expect(rec).toEqual({
      mbid: REC,
      title: 'Example Song',
      durationMs: 201500,
      firstReleaseDate: '2024-03-01',
      artistCredits: [expect.objectContaining({ artistMbid: ARTIST, name: 'Example Band' })],
      isrcs: ['USABC2400001'],
      releases: [
        {
          mbid: RELEASE,
          title: 'Example Album',
          status: 'Official',
          date: '2024-03-01',
          country: 'XW',
          releaseGroup: { mbid: RG, title: 'Example Album', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '2024-03-01', year: 2024 },
        },
      ],
    });
  });

  it('finds recordings by ISRC and treats unknown codes as none', async () => {
    const { client, fake } = makeClient((url) => (url.pathname.endsWith('/USABC2400001') ? jsonResponse({ isrc: 'USABC2400001', recordings: [recording] }) : jsonResponse({ error: 'Not Found' }, 404)));
    expect((await client.recordingsByIsrc('us-abc-24-00001')).map((r) => r.mbid)).toEqual([REC]);
    expect(await client.recordingsByIsrc('GBAAA2400009')).toEqual([]);
    expect(await client.recordingsByIsrc('bad')).toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it('builds a fielded search query', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ count: 1, offset: 0, recordings: [{ ...recording, score: 97 }] }));
    const page = await client.searchRecordings({ title: 'Example "Song"', artist: 'Example Band', release: 'Example Album' }, { limit: 5 });
    expect(page.results[0]).toMatchObject({ mbid: REC, score: 97 });
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get('query')).toBe('recording:"Example \\"Song\\"" AND artist:"Example Band" AND release:"Example Album"');
    expect(q.get('limit')).toBe('5');
    expect(await client.searchRecordings({ title: '  ' })).toEqual({ count: 0, offset: 0, results: [] });
  });
});
