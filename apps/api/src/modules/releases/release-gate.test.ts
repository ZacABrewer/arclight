import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../db/schema.js';
import { DEFAULT_RELEASE_SETTINGS, type ReleaseSettings } from './deps.js';
import { bookFixtures, harness, musicFixtures, NOW, quality } from './test-support.js';

// Searches never look for items that are not released yet (release-dates.ts): automatic and
// user-started searches skip them and say how many they skipped; interactive search still runs.
// The harness clock is NOW (2026-03-01T12:00Z).

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function gateHarness(settings: Partial<ReleaseSettings> = {}) {
  const h = await harness({ deps: { settings: { getReleaseSettings: () => ({ ...DEFAULT_RELEASE_SETTINGS, ...settings }) } } });
  const series = h.addSeries({ title: 'Show Name', tvdbId: 4242 });
  const aired = [1, 2].map((n) => h.addEpisode(series.id, 1, n));
  const unaired = h.addEpisode(series.id, 1, 3, { airDate: '2026-03-08', airDateUtc: '2026-03-08T20:00:00.000Z' });
  return { ...h, series, aired, unaired };
}

describe('searches skip unreleased items', () => {
  it('automatic episode search: unaired episodes are left out and counted', async () => {
    const h = await gateHarness();
    const summary = await h.service.searchFor({ seriesId: h.series.id, episodeIds: [h.aired[0]!.id, h.unaired.id] });
    expect(summary.skippedUnreleased).toBe(1);
    expect(h.indexers.searches).toEqual([expect.objectContaining({ season: 1, episode: 1 })]);

    h.indexers.searches = [];
    const none = await h.service.searchFor({ seriesId: h.series.id, episodeIds: [h.unaired.id] }, { userInvoked: true });
    expect(none).toEqual({ releases: 0, approved: 0, grabbed: [], pending: 0, skippedUnreleased: 1 });
    expect(h.indexers.searches).toEqual([]);
  });

  it('series / season search: asks for the aired episodes only, a season whose aired episodes are all asked for as a pack', async () => {
    const h = await gateHarness();
    const summary = await h.service.searchFor({ seriesId: h.series.id }, { userInvoked: true });
    expect(summary.skippedUnreleased).toBe(1);
    expect(h.indexers.searches).toEqual([expect.objectContaining({ kind: 'tv', season: 1 })]);
    expect(h.indexers.searches[0]).not.toHaveProperty('episode');
  });

  it('movie search: an unavailable movie is skipped, user-started or not; interactive search still runs', async () => {
    const h = await gateHarness();
    const future = h.addMovie({ title: 'Later', status: 'inCinemas', minimumAvailability: 'released', inCinemas: '2026-02-01', digitalRelease: '2026-05-01' });
    expect(await h.service.searchFor({ movieId: future.id }, { userInvoked: true })).toMatchObject({ releases: 0, skippedUnreleased: 1 });
    expect(await h.service.searchFor({ movieId: future.id })).toMatchObject({ skippedUnreleased: 1 });
    expect(h.indexers.searches).toEqual([]);
    await h.service.interactiveSearch({ movieId: future.id });
    expect(h.indexers.searches).toHaveLength(1);
    // The same movie with minimum availability "in cinemas" is out.
    const cinema = h.addMovie({ title: 'Now Showing', status: 'inCinemas', minimumAvailability: 'inCinemas', inCinemas: '2026-02-01' });
    expect((await h.service.searchFor({ movieId: cinema.id }, { userInvoked: true })).skippedUnreleased).toBeUndefined();
    expect(h.indexers.searches).toHaveLength(2);
  });

  it('searchUnreleased lets user-started searches through; automatic ones still skip', async () => {
    const h = await gateHarness({ searchUnreleased: true });
    const future = h.addMovie({ title: 'Later', status: 'announced', minimumAvailability: 'released', inCinemas: '2026-09-01', digitalRelease: null });
    expect((await h.service.searchFor({ movieId: future.id }, { userInvoked: true })).skippedUnreleased).toBeUndefined();
    expect(h.indexers.searches).toHaveLength(1);
    expect(await h.service.searchFor({ movieId: future.id })).toMatchObject({ skippedUnreleased: 1 });
    expect(h.indexers.searches).toHaveLength(1);
  });

  it('releaseGraceHours: the missing search waits that long after the air time; user searches do not', async () => {
    const h = await gateHarness({ releaseGraceHours: 6 });
    const fresh = h.addEpisode(h.series.id, 1, 4, { airDate: '2026-03-01', airDateUtc: iso(NOW.getTime() - 2 * HOUR) });
    h.indexers.results = [];
    await h.service.missingEpisodeSearch();
    const asked = () => h.indexers.searches.map((r) => (r as { episode?: number }).episode).filter((n) => n !== undefined);
    expect(asked()).not.toContain(4);
    expect(await h.service.searchFor({ seriesId: h.series.id, episodeIds: [fresh.id] })).toMatchObject({ skippedUnreleased: 1 });
    expect((await h.service.searchFor({ seriesId: h.series.id, episodeIds: [fresh.id] }, { userInvoked: true })).skippedUnreleased).toBeUndefined();
    h.indexers.searches = [];
    h.advance(5 * HOUR);
    await h.service.missingEpisodeSearch();
    expect(asked()).toContain(4);
  });

  it('cutoff unmet search leaves out items that are not released, even with a file', async () => {
    const h = await gateHarness();
    const withLowFile = (episodeId: number, n: number) => {
      const file = h.db
        .insert(schema.mediaFiles)
        .values({ mediaType: 'series', seriesId: h.series.id, seasonNumber: 1, relativePath: `e${n}.mkv`, path: `/tv/e${n}.mkv`, dateAdded: NOW.toISOString(), quality: quality('HDTV-720p'), languages: ['English'] })
        .returning()
        .get();
      h.db.update(schema.episodes).set({ hasFile: true, episodeFileId: file.id }).where(eq(schema.episodes.id, episodeId)).run();
    };
    withLowFile(h.aired[0]!.id, 1);
    withLowFile(h.unaired.id, 3);
    h.indexers.results = [];
    expect(await h.service.cutoffUnmetSearch()).toMatch(/searched 1 episodes/);
    expect(h.indexers.searches).toEqual([expect.objectContaining({ season: 1, episode: 1 })]);
  });

  it('albums and books: picked ones that are not out yet are skipped; the missing jobs leave them out', async () => {
    const h = await harness();
    const m = musicFixtures(h.db, h.profiles);
    const artist = m.addArtist({ name: 'Radiohead' });
    const out = m.addAlbum(artist.id, 'OK Computer', 1997, { tracks: 12, minutes: 53 });
    const soon = m.addAlbum(artist.id, 'Next One', 2026, { tracks: 10, minutes: 50, releaseDate: '2026-06-01' });
    const undated = m.addAlbum(artist.id, 'Some Day', 2026, { tracks: 10, minutes: 50, releaseDate: null });
    expect(await h.service.searchFor({ albumIds: [soon.id] }, { userInvoked: true })).toMatchObject({ releases: 0, skippedUnreleased: 1 });
    expect(await h.service.searchFor({ artistId: artist.id, albumIds: [out.id, soon.id, undated.id] }, { userInvoked: true })).toMatchObject({ skippedUnreleased: 2 });
    expect(await h.service.missingAlbumSearch()).toBe('missing albums: searched 1, grabbed 0');

    const b = bookFixtures(h.db, h.profiles);
    const author = b.addAuthor({ name: 'Andy Weir', sortName: 'Weir, Andy' });
    b.addBook(author.id, 'The Martian');
    const later = b.addBook(author.id, 'Next Book', { releaseDate: '2026-09-01', year: 2026 });
    b.addBook(author.id, 'Undated', { releaseDate: null, year: null });
    expect(await h.service.searchFor({ bookIds: [later.id] }, { userInvoked: true })).toMatchObject({ releases: 0, skippedUnreleased: 1 });
    expect(await h.service.missingBookSearch()).toBe('missing books: searched 1, grabbed 0');
  });
});
