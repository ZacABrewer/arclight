import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permission as P, QUALITIES, RequestsSettings } from '@arclight/shared';
import { movies, qualityProfiles } from '../../db/schema.js';
import { libraryService } from '../library/index.js';
import { setSection } from '../settings/service.js';
import { movieAvailability } from './status.js';
import { addUser, setup, type Harness } from './test-support.js';

// Requests' 4K track maps to the multi-version slot "4K": a 4K request adds that slot next to
// the normal copy instead of switching the item's profile.

const MATRIX = { tmdbId: 603, title: 'The Matrix', year: 1999 };

async function harness() {
  const h = await setup();
  h.tmdb.addMovie(MATRIX);
  const uhd = h.db.insert(qualityProfiles).values({ name: 'UHD', cutoff: 1, items: [], formatItems: [], languages: [] }).returning().get();
  setSection(
    h.db,
    'requests',
    RequestsSettings.parse({
      ...h.services.requests.settings(),
      movie4k: { enabled: true, rootFolderPath: null, qualityProfileId: uhd.id, tags: [] },
    }),
  );
  return { ...h, uhdProfileId: uhd.id };
}

async function request(h: Harness, permissions: number, is4k: boolean) {
  const u = addUser(h.db, { permissions });
  const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603, ...(is4k ? { is4k: true } : {}) });
  if (out.kind !== 'created') throw new Error(out.message);
  return out.request;
}

const movieRow = (h: Harness) => h.db.select().from(movies).where(eq(movies.tmdbId, 603)).get()!;

describe('4K requests and version slots', () => {
  it('a 4K request for a new title adds it with a 4K version slot', async () => {
    const h = await harness();
    const req = await request(h, P.REQUEST_4K | P.AUTO_APPROVE_4K, true);
    expect(req.status).toBe('approved');
    expect(movieRow(h).versions).toEqual([{ tag: '4K', qualityProfileId: h.uhdProfileId, enabled: true }]);
  });

  it('a 4K request on a title already in the library adds a 4K slot beside a Standard one', async () => {
    const h = await harness();
    await request(h, P.REQUEST | P.AUTO_APPROVE_MOVIE, false);
    const before = movieRow(h);
    expect(before.versions).toBeNull();
    await request(h, P.REQUEST_4K | P.AUTO_APPROVE_4K, true);
    const after = movieRow(h);
    expect(after.qualityProfileId).toBe(before.qualityProfileId);
    expect(after.versions).toEqual([
      { tag: 'Standard', qualityProfileId: before.qualityProfileId, enabled: true },
      { tag: '4K', qualityProfileId: h.uhdProfileId, enabled: true },
    ]);
  });

  it('a file in the 4K slot makes the 4K track available', async () => {
    const h = await harness();
    await request(h, P.REQUEST_4K | P.AUTO_APPROVE_4K, true);
    const movie = movieRow(h);
    libraryService.addMediaFile(h.db, {
      mediaType: 'movie',
      movieId: movie.id,
      relativePath: 'm.mkv',
      path: '/media/movies/m.mkv',
      sizeBytes: 1,
      // Tagged 4K even though the quality says 1080p: the slot decides the track.
      quality: { quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: ['series', 'movie'] }, revision: { version: 1, real: 0, isRepack: false } },
      languages: ['en'],
      versionTag: '4K',
    });
    expect(movieAvailability(h.db, [603]).get(603)!.status4k).toBe('available');
  });
});
