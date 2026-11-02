import { describe, expect, it } from 'vitest';
import { MetadataError, type MbArtist, type MusicBrainzClient } from '@arclight/metadata';
import { createTestDb } from '../../db/test-utils.js';
import { createMetadataCacheStore, withPersistentCache } from './cache.js';

// The persistent MusicBrainz cache: hits skip the client, and an outage serves the stale row.

const artist = { mbid: '0383dadf-2a4e-4d10-a46a-e9e041da8eb3', name: 'Example Band' } as unknown as MbArtist;

function fakeClient(getArtist: () => Promise<MbArtist>): MusicBrainzClient {
  return { providerKey: 'musicbrainz', getArtist } as unknown as MusicBrainzClient;
}

describe('withPersistentCache', () => {
  it('serves hits from the store and refetches after expiry', async () => {
    const db = await createTestDb();
    let now = new Date('2026-01-01T00:00:00Z');
    const store = createMetadataCacheStore(db, () => now);
    let calls = 0;
    const mb = withPersistentCache(fakeClient(async () => (calls++, artist)), store, { artist: 60_000 });
    await mb.getArtist(artist.mbid);
    await mb.getArtist(artist.mbid);
    expect(calls).toBe(1);
    now = new Date('2026-01-01T00:02:00Z');
    await mb.getArtist(artist.mbid);
    expect(calls).toBe(2);
  });

  it('falls back to the expired entry when MusicBrainz is unreachable or throttling', async () => {
    const db = await createTestDb();
    let now = new Date('2026-01-01T00:00:00Z');
    const store = createMetadataCacheStore(db, () => now);
    let fail: MetadataError | undefined;
    const mb = withPersistentCache(
      fakeClient(async () => {
        if (fail) throw fail;
        return artist;
      }),
      store,
      { artist: 60_000 },
    );
    await mb.getArtist(artist.mbid);
    now = new Date('2026-01-05T00:00:00Z');
    fail = new MetadataError('unreachable', 'connect ECONNREFUSED');
    await expect(mb.getArtist(artist.mbid)).resolves.toMatchObject({ name: 'Example Band' });
    fail = new MetadataError('rate-limited', '503');
    await expect(mb.getArtist(artist.mbid, { fresh: true })).resolves.toMatchObject({ name: 'Example Band' });
  });

  it('passes real answers (not found) and misses without a stale row through', async () => {
    const db = await createTestDb();
    const store = createMetadataCacheStore(db);
    const notFound = withPersistentCache(fakeClient(async () => Promise.reject(new MetadataError('not-found', 'gone'))), store);
    await expect(notFound.getArtist(artist.mbid)).rejects.toMatchObject({ code: 'not-found' });
    const down = withPersistentCache(fakeClient(async () => Promise.reject(new MetadataError('unreachable', 'down'))), store);
    await expect(down.getArtist('11111111-2222-3333-4444-555555555555')).rejects.toMatchObject({ code: 'unreachable' });
  });
});
