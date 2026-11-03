// DATA-04: release titles come from indexers, feeds and download clients, so every parse
// entry point must stay fast on hostile input. Separator runs are what made the old series
// regexes backtrack cubically; this feeds runs of every separator unit into every exported
// parse function, at the length cap and far beyond it.
import { describe, expect, it } from 'vitest';
import * as P from './index.js';
import { MAX_TITLE_LENGTH, clampPath, clampTitle } from './normalize.js';

const ENTRY_POINTS: Array<[string, (s: string) => unknown]> = [
  ['parseRelease', (s) => P.parseRelease(s)],
  ['parseRelease(movie)', (s) => P.parseRelease(s, 'movie')],
  ['parseRelease(series)', (s) => P.parseRelease(s, 'series')],
  ['parsePath', (s) => P.parsePath(s)],
  ['parsePath(nested)', (s) => P.parsePath(`/media/${s}/${s}.mkv`)],
  ['parseMusicRelease', (s) => P.parseMusicRelease(s)],
  ['parseAudioPath', (s) => P.parseAudioPath(`/music/${s}/${s}.flac`)],
  ['parseAudioPath(audiobook)', (s) => P.parseAudioPath(`/books/${s}/${s}.m4b`, 'audiobook')],
  ['parseAudiobookRelease', (s) => P.parseAudiobookRelease(s)],
  ['parseAudiobookPath', (s) => P.parseAudiobookPath(s)],
  ['parseEbookRelease', (s) => P.parseEbookRelease(s)],
  ['parseComicRelease', (s) => P.parseComicRelease(s)],
  ['parseEbookPath', (s) => P.parseEbookPath(`/books/${s}/${s}.epub`)],
  ['parseComicPath', (s) => P.parseComicPath(`/comics/${s}/${s}.cbz`)],
  ['bookTitleKey', (s) => P.bookTitleKey(s)],
  ['parseSeries', (s) => P.parseSeries(s)],
  ['parseSeasonTitle', (s) => P.parseSeasonTitle(s)],
  ['splitSeasonTitle', (s) => P.splitSeasonTitle(s)],
  ['parseSeriesTitleInfo', (s) => P.parseSeriesTitleInfo(s)],
  ['parseMovie', (s) => P.parseMovie(s)],
  ['parseQuality', (s) => P.parseQuality(s)],
  ['parseRevision', (s) => P.parseRevision(s)],
  ['parseLanguages', (s) => P.parseLanguages(s)],
  ['parseReleaseGroup', (s) => P.parseReleaseGroup(s)],
  ['parseReleaseHash', (s) => P.parseReleaseHash(s)],
  ['isHashedRelease', (s) => P.isHashedRelease(s)],
  ['parseAudioQuality', (s) => P.parseAudioQuality(s)],
  ['readAudioFacts', (s) => P.readAudioFacts(s)],
  ['normalizeTitle', (s) => P.normalizeTitle(s)],
  ['cleanTitle', (s) => P.cleanTitle(s)],
  ['normalizeImdbId', (s) => P.normalizeImdbId(s)],
];

const UNITS = ['-', '- ', '-_', '-.', '. ', ' ', '.', '_', ' - ', '-- ', '[', ']', '[]', '(', ' (', '()', '\t', 'a ', 'a.', '1 ', 'S1', 'E1', '/', '\\', ', '];
const PREFIXES = ['T', 'Artist - '];
const SUFFIXES = ['', 'x', 'Complete Series', ' (2001)'];

/** Fastest of two runs, so a GC pause or a first-call compile does not count as slowness. */
function timed(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('parser ReDoS guard (DATA-04)', () => {
  it('the series patterns from the audit finish quickly on long separator runs', () => {
    for (const run of ['-'.repeat(4000), '- '.repeat(2000), '-_'.repeat(2000), '-.'.repeat(2000)]) {
      for (const tail of ['', 'x', 'Series 1', 'Complete Series']) {
        const title = `Title ${run}${tail}`;
        expect([title.slice(0, 12), timed(() => P.parseRelease(title)) < 50]).toEqual([title.slice(0, 12), true]);
      }
    }
  });

  it('the regexes themselves are fast at the cap, not only thanks to it', () => {
    // At 512 characters the old series patterns alone took tens of milliseconds.
    for (const unit of ['-', '- ', '-_', '-.']) {
      const title = `T${unit.repeat(Math.ceil((MAX_TITLE_LENGTH - 16) / unit.length))}Complete Series`;
      expect([unit, timed(() => P.parseRelease(title)) < 10]).toEqual([unit, true]);
    }
  });

  it('every entry point stays under 50 ms on separator-unit runs (fuzz)', { timeout: 120_000 }, () => {
    const slow: string[] = [];
    for (const [name, fn] of ENTRY_POINTS) {
      fn('Warm.Up.S01E01.1080p.WEB-DL-GRP');
      for (const unit of UNITS) {
        for (const length of [MAX_TITLE_LENGTH, 4000]) {
          const run = unit.repeat(Math.ceil(length / unit.length));
          for (const prefix of PREFIXES) {
            for (const suffix of SUFFIXES) {
              const input = prefix + run + suffix;
              const ms = timed(() => fn(input));
              if (ms >= 50) slow.push(`${name} ${JSON.stringify(prefix)}+${JSON.stringify(unit)}x${length}+${JSON.stringify(suffix)}: ${ms.toFixed(0)} ms`);
            }
          }
        }
      }
    }
    expect(slow).toEqual([]);
  });

  it('keeps the British "- Series N" and "Complete Series" forms', () => {
    expect(P.parseRelease('Title - Series 1 (1970)').series).toMatchObject({ title: 'Title', seasons: [1], fullSeason: true });
    expect(P.parseRelease('Title.-.Series.2.DVDRip').series).toMatchObject({ title: 'Title', seasons: [2] });
    expect(P.parseRelease('Title - The Complete Series (2010-2015)').series).toMatchObject({ title: 'Title', isCompleteSeries: true });
    expect(P.parseRelease('Title.COMPLETE.SERIES.1080p').series).toMatchObject({ title: 'Title', isCompleteSeries: true });
  });
});

describe('title length cap (DATA-04)', () => {
  it('cuts titles and path segments to the cap', () => {
    expect(clampTitle('a'.repeat(600))).toHaveLength(MAX_TITLE_LENGTH);
    expect(clampTitle('short')).toBe('short');
    const path = `/media/${'x'.repeat(700)}/file.mkv`;
    expect(clampPath(path)).toBe(`/media/${'x'.repeat(MAX_TITLE_LENGTH)}/file.mkv`);
    expect(clampPath('/a/b/c.mkv')).toBe('/a/b/c.mkv');
  });

  it('parses a title padded past the cap from its first 512 characters', () => {
    const r = P.parseRelease(`Show.S01E02.1080p.WEB-DL.${'x'.repeat(5000)}`);
    expect(r.releaseTitle.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(r.series).toMatchObject({ title: 'Show', seasons: [1], episodes: [2] });
  });
});
