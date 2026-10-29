import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createListenBrainzClient } from './client.js';

const UA = 'Arclight-test/0.0 ( https://example.invalid/arclight )';
const RG_1 = '11111111-1111-4111-8111-111111111111';
const RG_2 = '22222222-2222-4222-8222-222222222222';
const ARTIST = '33333333-3333-4333-8333-333333333333';
const RELEASE = '44444444-4444-4444-8444-444444444444';

const fresh = {
  payload: {
    releases: [
      {
        release_group_mbid: RG_1,
        release_name: 'First Album',
        release_mbid: RELEASE,
        release_date: '2026-10-20',
        artist_credit_name: 'Some Artist',
        artist_mbids: [ARTIST.toUpperCase(), 'not-an-mbid'],
        release_group_primary_type: 'Album',
        release_group_secondary_type: null,
        caa_id: 42,
        caa_release_mbid: RELEASE,
      },
      // No release group: skipped.
      { release_name: 'Orphan', artist_credit_name: 'Nobody' },
    ],
  },
};

const top = {
  payload: {
    release_groups: [{ release_group_mbid: RG_2, release_group_name: 'Popular Record', artist_name: 'Band', artist_mbids: [ARTIST], listen_count: 1234 }],
  },
};

function makeClient(route: Responder) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createListenBrainzClient({
    userAgent: UA,
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock, random: () => 0 }),
    now: () => new Date(clock.now()),
    maxRetries: 0,
  });
  return { client, fake };
}

const route: Responder = (url) => {
  if (url.pathname === '/1/explore/fresh-releases') return jsonResponse(fresh);
  if (url.pathname === '/1/stats/sitewide/release-groups') return jsonResponse(top);
  return jsonResponse({ error: 'not found' }, 404);
};

describe('createListenBrainzClient', () => {
  it('requires a User-Agent and sends it', async () => {
    expect(() => createListenBrainzClient({ userAgent: ' ' })).toThrow(/User-Agent/);
    const { client, fake } = makeClient(route);
    await client.freshReleases();
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(UA);
    expect(fake.calls[0]?.url.origin).toBe('https://api.listenbrainz.org');
  });

  it('maps fresh releases and drops entries without a release group', async () => {
    const { client, fake } = makeClient(route);
    const releases = await client.freshReleases({ days: 14 });
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get('days')).toBe('14');
    expect(q.get('sort')).toBe('release_date');
    expect(releases).toEqual([
      {
        releaseGroupMbid: RG_1,
        title: 'First Album',
        artistName: 'Some Artist',
        artistMbids: [ARTIST],
        primaryType: 'Album',
        releaseDate: '2026-10-20',
        caaId: 42,
        caaReleaseMbid: RELEASE,
      },
    ]);
  });

  it('maps the sitewide release-group statistics', async () => {
    const { client, fake } = makeClient(route);
    const groups = await client.sitewideReleaseGroups({ range: 'week', count: 40 });
    expect(fake.calls[0]!.url.searchParams.get('count')).toBe('40');
    expect(groups).toEqual([{ releaseGroupMbid: RG_2, title: 'Popular Record', artistName: 'Band', artistMbids: [ARTIST], listenCount: 1234 }]);
  });

  it('reads 204 No Content (statistics being computed) as an empty list', async () => {
    const { client } = makeClient(() => new Response(null, { status: 204 }));
    expect(await client.sitewideReleaseGroups()).toEqual([]);
  });

  it('caches answers in memory', async () => {
    const { client, fake } = makeClient(route);
    await client.freshReleases();
    await client.freshReleases();
    expect(fake.calls).toHaveLength(1);
  });

  it('maps upstream failures to MetadataError', async () => {
    const { client } = makeClient(() => jsonResponse({ error: 'boom' }, 500));
    await expect(client.freshReleases()).rejects.toMatchObject({ name: 'MetadataError', code: 'bad-response' });
  });
});
