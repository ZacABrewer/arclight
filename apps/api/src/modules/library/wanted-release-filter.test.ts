import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { WantedAlbumsQuery, WantedBooksQuery, WantedEpisodesQuery, WantedMoviesQuery, type Movie } from '@arclight/shared';
import * as schema from '../../db/schema.js';
import * as audiobooks from '../audiobooks/service.js';
import * as music from '../music/service.js';
import { bookFixtures, harness, musicFixtures, NOW, quality } from '../releases/test-support.js';
import * as library from './service.js';

// The release filter of the Wanted lists (release-dates.ts): `released` (default) / `unreleased`
// / `all`, and a `releasedAfter` / `releasedBefore` range on the release moment. Rows are
// filtered before paging, so totalRecords and the pages follow the filter. Clock: NOW
// (2026-03-01T12:00Z).

const now = NOW.toISOString();
const ids = (page: { records: Array<{ id: number }> }) => page.records.map((r) => r.id).sort((a, b) => a - b);

async function setup() {
  const h = await harness();
  const series = h.addSeries({ title: 'Show Name' });
  const old = h.addEpisode(series.id, 1, 1, { airDate: '2025-06-01', airDateUtc: '2025-06-01T20:00:00.000Z' });
  const recent = h.addEpisode(series.id, 1, 2, { airDate: '2026-02-25', airDateUtc: '2026-02-25T20:00:00.000Z' });
  const dateOnly = h.addEpisode(series.id, 1, 3, { airDate: '2026-02-28', airDateUtc: null });
  const future = h.addEpisode(series.id, 1, 4, { airDate: '2026-03-08', airDateUtc: '2026-03-08T20:00:00.000Z' });
  const unknown = h.addEpisode(series.id, 1, 5, { airDate: null, airDateUtc: null });
  return { ...h, series, old, recent, dateOnly, future, unknown };
}

describe('Wanted release filter: episodes', () => {
  it('missing: released by default, unreleased = future or unknown air date, all = both', async () => {
    const h = await setup();
    const q = (extra: Record<string, unknown>) => WantedEpisodesQuery.parse({ page: 1, pageSize: 50, ...extra });
    expect(ids(library.listMissingEpisodes(h.db, q({}), now))).toEqual([h.old.id, h.recent.id, h.dateOnly.id]);
    expect(ids(library.listMissingEpisodes(h.db, q({ released: 'released' }), now))).toEqual([h.old.id, h.recent.id, h.dateOnly.id]);
    expect(ids(library.listMissingEpisodes(h.db, q({ released: 'unreleased' }), now))).toEqual([h.future.id, h.unknown.id]);
    expect(library.listMissingEpisodes(h.db, q({ released: 'all' }), now).totalRecords).toBe(5);
  });

  it('date range: inclusive whole UTC days for date-only bounds, undated rows left out', async () => {
    const h = await setup();
    const q = (extra: Record<string, unknown>) => WantedEpisodesQuery.parse({ page: 1, pageSize: 50, released: 'all', ...extra });
    expect(ids(library.listMissingEpisodes(h.db, q({ releasedAfter: '2026-02-25' }), now))).toEqual([h.recent.id, h.dateOnly.id, h.future.id]);
    expect(ids(library.listMissingEpisodes(h.db, q({ releasedBefore: '2026-02-28' }), now))).toEqual([h.old.id, h.recent.id, h.dateOnly.id]);
    expect(ids(library.listMissingEpisodes(h.db, q({ releasedAfter: '2026-02-26', releasedBefore: '2026-02-28' }), now))).toEqual([h.dateOnly.id]);
    // A timestamp bound is exact.
    expect(ids(library.listMissingEpisodes(h.db, q({ releasedAfter: '2026-02-25T21:00:00Z', releasedBefore: '2026-03-01' }), now))).toEqual([h.dateOnly.id]);
    expect(() => WantedEpisodesQuery.parse({ releasedAfter: 'last tuesday' })).toThrow();
    expect(() => WantedEpisodesQuery.parse({ released: 'soon' })).toThrow();
  });

  it('paging and totalRecords follow the filter', async () => {
    const h = await setup();
    const page1 = library.listMissingEpisodes(h.db, WantedEpisodesQuery.parse({ page: 1, pageSize: 2 }), now);
    const page2 = library.listMissingEpisodes(h.db, WantedEpisodesQuery.parse({ page: 2, pageSize: 2 }), now);
    expect(page1.totalRecords).toBe(3);
    expect(page2.totalRecords).toBe(3);
    expect([...ids(page1), ...ids(page2)].sort((a, b) => a - b)).toEqual([h.old.id, h.recent.id, h.dateOnly.id]);
    const upcoming = library.listMissingEpisodes(h.db, WantedEpisodesQuery.parse({ page: 2, pageSize: 1, released: 'unreleased' }), now);
    expect(upcoming).toMatchObject({ totalRecords: 2, page: 2 });
    expect(upcoming.records).toHaveLength(1);
  });

  it('cutoff unmet: released by default; an unaired episode with a file shows under unreleased', async () => {
    const h = await setup();
    for (const ep of [h.old, h.future]) {
      const file = h.db
        .insert(schema.mediaFiles)
        .values({ mediaType: 'series', seriesId: h.series.id, seasonNumber: 1, relativePath: `${ep.id}.mkv`, path: `/tv/${ep.id}.mkv`, dateAdded: now, quality: quality('HDTV-720p'), languages: [] })
        .returning()
        .get();
      h.db.update(schema.episodes).set({ hasFile: true, episodeFileId: file.id }).where(eq(schema.episodes.id, ep.id)).run();
    }
    const unmet = () => false;
    const q = (extra: Record<string, unknown>) => WantedEpisodesQuery.parse({ page: 1, pageSize: 50, ...extra });
    expect(ids(library.listCutoffUnmetEpisodes(h.db, q({}), unmet, now))).toEqual([h.old.id]);
    expect(ids(library.listCutoffUnmetEpisodes(h.db, q({ released: 'unreleased' }), unmet, now))).toEqual([h.future.id]);
    expect(library.listCutoffUnmetEpisodes(h.db, q({ released: 'all' }), unmet, now).totalRecords).toBe(2);
  });
});

describe('Wanted release filter: movies', () => {
  it('uses the date that satisfies the minimum availability', async () => {
    const h = await harness();
    // Digital release passed: out under "released".
    const home = h.addMovie({ title: 'Home', minimumAvailability: 'released', inCinemas: '2025-10-01', digitalRelease: '2026-01-15' });
    // In cinemas now, home release later: out only under "inCinemas".
    const cinemaOnly = h.addMovie({ title: 'Cinema', status: 'inCinemas', minimumAvailability: 'released', inCinemas: '2026-02-10', digitalRelease: '2026-05-01' });
    const cinemaOk = h.addMovie({ title: 'Cinema Ok', status: 'inCinemas', minimumAvailability: 'inCinemas', inCinemas: '2026-02-10', digitalRelease: '2026-05-01' });
    // No dates at all, status announced: unknown, so unreleased.
    const tba = h.addMovie({ title: 'Tba', status: 'announced', minimumAvailability: 'released', inCinemas: null, digitalRelease: null });
    // Announced counts as out whatever the dates.
    const announced = h.addMovie({ title: 'Announced', status: 'announced', minimumAvailability: 'announced', inCinemas: '2026-12-01', digitalRelease: null });
    const q = (extra: Record<string, unknown>) => WantedMoviesQuery.parse({ page: 1, pageSize: 50, ...extra });
    const list = (extra: Record<string, unknown>) => ids(library.listMissingMovies(h.db, q(extra), now));
    expect(list({})).toEqual([home.id, cinemaOk.id, announced.id]);
    expect(list({ released: 'unreleased' })).toEqual([cinemaOnly.id, tba.id]);
    // Range on the release date: cinemaOnly's is its digital release (May), cinemaOk's its cinema date.
    expect(list({ released: 'all', releasedAfter: '2026-02-01', releasedBefore: '2026-02-28' })).toEqual([cinemaOk.id]);
    expect(list({ released: 'all', releasedAfter: '2026-04-01' })).toEqual([cinemaOnly.id, announced.id]);
    const page = library.listMissingMovies(h.db, q({ released: 'all', pageSize: 2 }), now) as { totalRecords: number; records: Movie[] };
    expect(page.totalRecords).toBe(5);
    expect(page.records).toHaveLength(2);
  });
});

describe('Wanted release filter: albums and books', () => {
  it('albums: the release date (partial dates count from the start of their period)', async () => {
    const h = await harness();
    const m = musicFixtures(h.db, h.profiles);
    const artist = m.addArtist({ name: 'Radiohead' });
    const out = m.addAlbum(artist.id, 'OK Computer', 1997, { tracks: 12, minutes: 53 });
    const yearOnly = m.addAlbum(artist.id, 'This Year', 2026, { tracks: 10, minutes: 50, releaseDate: '2026' });
    const soon = m.addAlbum(artist.id, 'Next One', 2026, { tracks: 10, minutes: 50, releaseDate: '2026-06-01' });
    const undated = m.addAlbum(artist.id, 'Some Day', 2026, { tracks: 10, minutes: 50, releaseDate: null });
    const q = (extra: Record<string, unknown>) => WantedAlbumsQuery.parse({ page: 1, pageSize: 50, ...extra });
    const list = (extra: Record<string, unknown>) => ids(music.listMissingAlbums(h.db, q(extra), NOW));
    expect(list({})).toEqual([out.id, yearOnly.id]);
    expect(list({ released: 'unreleased' })).toEqual([soon.id, undated.id]);
    expect(list({ released: 'all', releasedAfter: '2026-01-01' })).toEqual([yearOnly.id, soon.id]);
    expect(music.listMissingAlbums(h.db, q({ released: 'all', pageSize: 3, page: 2 }), NOW)).toMatchObject({ totalRecords: 4, records: [expect.anything()] });
  });

  it('books: the release / publish date', async () => {
    const h = await harness();
    const b = bookFixtures(h.db, h.profiles);
    const author = b.addAuthor({ name: 'Andy Weir', sortName: 'Weir, Andy' });
    const out = b.addBook(author.id, 'The Martian');
    const later = b.addBook(author.id, 'Next Book', { releaseDate: '2026-09-01', year: 2026 });
    const undated = b.addBook(author.id, 'Undated', { releaseDate: null, year: null });
    const q = (extra: Record<string, unknown>) => WantedBooksQuery.parse({ page: 1, pageSize: 50, ...extra });
    const list = (extra: Record<string, unknown>) => ids(audiobooks.listMissingBooks(h.db, q(extra), NOW));
    expect(list({})).toEqual([out.id]);
    expect(list({ released: 'unreleased' })).toEqual([later.id, undated.id]);
    expect(list({ released: 'all', releasedBefore: '2020-01-01' })).toEqual([out.id]);
    expect(audiobooks.listMissingBooks(h.db, q({ released: 'all' }), NOW).totalRecords).toBe(3);
  });
});
