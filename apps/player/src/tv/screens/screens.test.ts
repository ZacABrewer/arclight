import { describe, expect, it, vi } from 'vitest';
import type { PlayableItem, PlayerSearchResponse, PlayerTrack, VideoCard } from '@arclight/shared';
import { newEpisodes, recentAlbums } from './home';
import { searchTiles, SEARCH_MAX } from './search';
import { cycle, languageName, ownsAccount, SUBTITLE_LANGUAGES } from './settings';
import { chapterRows, listenProgress } from './listen';
import { initialOf } from './manage-profiles';
import { titleStep } from '../tiles';
import { cardMeta } from '../actions';

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key);

describe('TV home rows', () => {
  it('Recently Played: one album per tile, newest play first', () => {
    const tr = (albumId: number, title: string) => ({ albumId, albumTitle: title, artistName: 'Band', artworkUrl: null }) as unknown as PlayerTrack;
    expect(recentAlbums([tr(2, 'B'), tr(1, 'A'), tr(2, 'B')]).map((a) => a.id)).toEqual([2, 1]);
  });

  it('New Episodes: one tile per show', () => {
    const c = (id: number, seriesId: number | null) => ({ id, seriesId }) as unknown as VideoCard;
    expect(newEpisodes([c(1, 10), c(2, 10), c(3, 11), c(4, null)]).map((x) => x.id)).toEqual([1, 3, 4]);
  });
});

describe('TV search tiles', () => {
  const r = {
    series: [{ id: 1, title: 'Show', year: 2026, backdropUrl: null, posterUrl: 'p' }],
    movies: [{ id: 2, title: 'Film', year: null, backdropUrl: 'b', posterUrl: null }],
    albums: [{ id: 3, title: 'Record', artistName: 'Band', artworkUrl: null }],
    audiobooks: [{ id: 4, itemKey: 'k', title: 'Book', authors: ['Writer'], artworkUrl: null }],
  } as unknown as PlayerSearchResponse;
  const open = { movie: vi.fn(), series: vi.fn(), album: vi.fn(), book: vi.fn() };

  it('video first, then albums and audiobooks when shown', () => {
    const all = searchTiles(r, { music: true, books: true }, open, t);
    expect(all.map((x) => x.sub)).toEqual(['app.tv.series · 2026', 'app.tv.movie', 'app.tv.album · Band', 'app.tv.audiobook · Writer']);
    expect(searchTiles(r, { music: false, books: false }, open, t)).toHaveLength(2);
    all[3]!.open();
    expect(open.book).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  });

  it('caps the grid', () => {
    const movies = Array.from({ length: 30 }, (_, i) => ({ id: i, title: `M${i}`, year: null, backdropUrl: null, posterUrl: null }));
    const many = { ...r, movies } as unknown as PlayerSearchResponse;
    expect(searchTiles(many, { music: true, books: true }, open, t)).toHaveLength(SEARCH_MAX);
  });
});

describe('TV settings helpers', () => {
  it('cycle wraps, and starts at the first for an unknown value', () => {
    expect(cycle(['a', 'b', 'c'], 'a')).toBe('b');
    expect(cycle(['a', 'b', 'c'], 'c')).toBe('a');
    expect(cycle(['a', 'b'], 'z')).toBe('a');
    expect(cycle(SUBTITLE_LANGUAGES, null)).toBe('en');
  });

  it('language names in the UI language, Off for none', () => {
    expect(languageName(null, 'en', t)).toBe('app.tv.settings.off');
    expect(languageName('de', 'en', t)).toBe('German');
    expect(languageName('es', 'fr', t)).toBe('Espagnol');
  });

  it('"This device" is for the owner profile only (and servers without profiles)', () => {
    expect(ownsAccount({ isOwner: true })).toBe(true);
    expect(ownsAccount({ isOwner: false })).toBe(false);
    expect(ownsAccount(null)).toBe(true);
  });
});

describe('Listen', () => {
  const book = {
    kind: 'audiobook',
    title: 'Book',
    durationMs: 3_000_000,
    chapters: [
      { title: 'One', startMs: 0, durationMs: 1_000_000 },
      { title: 'Two', startMs: 1_000_000, durationMs: 2_000_000 },
    ],
  } as unknown as PlayableItem;

  it('chapter rows seek to the chapter start', () => {
    const seek = vi.fn();
    const rows = chapterRows(book.chapters, 1, seek);
    expect(rows.map((x) => [x.n, x.title, x.current])).toEqual([
      [1, 'One', false],
      [2, 'Two', true],
    ]);
    rows[1]!.play();
    expect(seek).toHaveBeenCalledWith(1_000_000);
  });

  it('progress inside the chapter for books, inside the track for music', () => {
    expect(listenProgress(book, 1_500_000, 3_000_000, 1)).toEqual({ pos: 500_000, dur: 2_000_000, title: 'Two' });
    const track = { kind: 'track', title: 'Song', durationMs: 200_000, chapters: [] } as unknown as PlayableItem;
    expect(listenProgress(track, 10_000, 0, 0)).toEqual({ pos: 10_000, dur: 200_000, title: 'Song' });
  });
});

describe('Manage profiles', () => {
  it('the initial is the first letter, upper case', () => {
    expect(initialOf('  sam')).toBe('S');
    expect(initialOf('')).toBe('?');
  });
});

describe('TV tiles (clipping fixes)', () => {
  it('a long hero title steps down in size', () => {
    expect(titleStep('Dune')).toBe('l');
    expect(titleStep('The Lord of the Rings')).toBe('m');
    expect(titleStep('Everything Everywhere All at Once')).toBe('s');
  });

  it('the dwell strip: the episode, else year · network · badges', () => {
    const c = (x: Partial<VideoCard>) => ({ kind: 'movie', year: null, subtitle: null, badges: [], ...x }) as VideoCard;
    expect(cardMeta(c({ kind: 'episode', subtitle: 'S1:E2 · Pilot' }))).toBe('S1:E2 · Pilot');
    expect(cardMeta(c({ kind: 'series', year: 2019, subtitle: 'HBO', badges: ['4K'] }))).toBe('2019 · HBO · 4K');
    expect(cardMeta(c({}))).toBeNull();
  });
});
