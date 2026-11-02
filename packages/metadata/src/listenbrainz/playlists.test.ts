import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createListenBrainzClient } from './client.js';

const UA = 'Arclight-test/0.0 ( https://example.invalid/arclight )';
const PLAYLIST = '77777777-7777-4777-8777-777777777777';
const REC = '55555555-5555-4555-8555-555555555555';
const ARTIST = '33333333-3333-4333-8333-333333333333';
const SIM_A = '66666666-6666-4666-8666-666666666666';
const SIM_B = '88888888-8888-4888-8888-888888888888';
const RELEASE = '44444444-4444-4444-8444-444444444444';

function makeClient(route: Responder) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createListenBrainzClient({ userAgent: UA, fetchImpl: fake.fetch, rateLimiter: new RateLimiter({ clock, random: () => 0 }), now: () => new Date(clock.now()), maxRetries: 0 });
  return { client, fake };
}

const jspf = {
  playlist: {
    title: 'Weekly Exploration for example-user',
    identifier: `https://listenbrainz.org/playlist/${PLAYLIST}`,
    annotation: '<p>New music <b>picked</b> for you.</p>',
    creator: 'listenbrainz',
    date: '2026-10-26T00:00:00+00:00',
    extension: { 'https://musicbrainz.org/doc/jspf#playlist': { additional_metadata: { algorithm_metadata: { source_patch: 'weekly-exploration' } } } },
    track: [
      {
        title: 'Example Song',
        creator: 'Example Band',
        album: 'Example Album',
        duration: 201500,
        identifier: [`https://musicbrainz.org/recording/${REC}`],
        extension: {
          'https://musicbrainz.org/doc/jspf#track': {
            artist_identifiers: [`https://musicbrainz.org/artist/${ARTIST}`],
            release_identifier: `https://musicbrainz.org/release/${RELEASE}`,
          },
        },
      },
      { title: 'No Ids', creator: 'Some Artist' },
      { title: '', creator: 'Skipped' },
    ],
  },
};

describe('ListenBrainz playlists', () => {
  it('lists created-for playlists with their patch', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ playlists: [jspf, { playlist: { title: 'Broken', identifier: 'nope' } }], playlist_count: 2 }));
    expect(await client.createdForPlaylists('example-user', { count: 10 })).toEqual([
      { mbid: PLAYLIST, title: 'Weekly Exploration for example-user', date: '2026-10-26T00:00:00+00:00', sourcePatch: 'weekly-exploration' },
    ]);
    expect(fake.calls[0]!.url.pathname).toBe('/1/user/example-user/playlists/createdfor');
    expect(fake.calls[0]!.url.searchParams.get('count')).toBe('10');
    expect(await client.createdForPlaylists('  ')).toEqual([]);
  });

  it('maps a JSPF playlist', async () => {
    const { client, fake } = makeClient(() => jsonResponse(jspf));
    const playlist = await client.getPlaylist(`https://listenbrainz.org/playlist/${PLAYLIST}`);
    expect(fake.calls[0]!.url.pathname).toBe(`/1/playlist/${PLAYLIST}`);
    expect(playlist).toMatchObject({ id: PLAYLIST, title: 'Weekly Exploration for example-user', description: 'New music picked for you.', owner: 'listenbrainz' });
    expect(playlist.tracks).toEqual([
      { title: 'Example Song', artist: 'Example Band', album: 'Example Album', durationMs: 201500, recordingMbid: REC, releaseMbid: RELEASE, artistMbids: [ARTIST] },
      { title: 'No Ids', artist: 'Some Artist' },
    ]);
  });

  it('refuses ids that are not MBIDs', async () => {
    const { client, fake } = makeClient(() => jsonResponse(jspf));
    await expect(client.getPlaylist('weekly')).rejects.toMatchObject({ code: 'not-found' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('ListenBrainz similar artists', () => {
  const row = (mbid: string, name: string, score: number) => ({ artist_mbid: mbid, name, comment: '', type: 'Group', score, reference_mbid: ARTIST });

  it('reads the flat row shape from the labs host, sorted and de-duplicated', async () => {
    const { client, fake } = makeClient(() => jsonResponse([row(SIM_A, 'Band A', 10), row(SIM_B, 'Band B', 40), row(SIM_A, 'Band A', 5), row(ARTIST, 'Self', 99)]));
    expect(await client.similarArtists(ARTIST, { limit: 5 })).toEqual([
      { mbid: SIM_B, name: 'Band B', type: 'Group', score: 40 },
      { mbid: SIM_A, name: 'Band A', type: 'Group', score: 10 },
    ]);
    const u = fake.calls[0]!.url;
    expect(u.hostname).toBe('labs.api.listenbrainz.org');
    expect(u.searchParams.get('artist_mbids')).toBe(ARTIST);
    expect(u.searchParams.get('algorithm')).toMatch(/^session_based/);
  });

  it('reads the older { data } block shape and honours the limit', async () => {
    const { client } = makeClient(() => jsonResponse([{ type: 'dataset', columns: [] }, { data: [row(SIM_A, 'Band A', 3), row(SIM_B, 'Band B', 2)] }]));
    expect((await client.similarArtists(ARTIST, { limit: 1 })).map((a) => a.name)).toEqual(['Band A']);
  });

  it('caches for a day and skips bad ids', async () => {
    const { client, fake } = makeClient(() => jsonResponse([row(SIM_A, 'Band A', 1)]));
    await client.similarArtists(ARTIST);
    await client.similarArtists(ARTIST);
    expect(fake.calls).toHaveLength(1);
    expect(await client.similarArtists('not-an-id')).toEqual([]);
  });
});
