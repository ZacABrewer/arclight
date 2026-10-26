import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCase, type FixtureCase } from './fixture-check.js';
import { normalizeImdbId, normalizeTitle, parsePath, parseRelease, parseSeasonTitle } from './index.js';

// Per-file minimum pass rates (whole percent, rounded down from what the parser achieves).
// Raising a number is fine; lowering one needs a reason in the commit message.
const THRESHOLDS: Record<string, number> = {
  'group/anime-subgroup.json': 100,
  'group/radarr-group.json': 100,
  'group/sonarr-group.json': 100,
  'language/iso-codes.json': 100,
  'language/radarr-language.json': 100,
  'language/sonarr-language.json': 100,
  'movies/alternative-titles.json': 100,
  'movies/anime-version.json': 100,
  'movies/crap.json': 100,
  'movies/edition.json': 100,
  'movies/external-ids.json': 100,
  'movies/hardcoded-subs.json': 100,
  'movies/hashed.json': 100,
  'movies/language-in-title.json': 100,
  'movies/normalize-imdb-id.json': 100,
  'movies/normalize-title.json': 100,
  'movies/roman-numerals.json': 100,
  'movies/scene-check.json': 100,
  'movies/slug.json': 100,
  'movies/title-year.json': 100,
  'path/path.json': 100,
  'quality/anime-version.json': 100,
  'quality/radarr-quality.json': 99,
  'quality/revision.json': 100,
  'quality/sonarr-quality.json': 100,
  'scene/sonarr-scene-check.json': 100,
  'series/anime.json': 100,
  'series/crap.json': 100,
  'series/daily.json': 100,
  'series/full-season.json': 100,
  'series/hashed.json': 100,
  'series/mini-series.json': 100,
  'series/misc.json': 100,
  'series/multi-episode.json': 100,
  'series/normalize-title.json': 100,
  'series/single-episode.json': 99,
  'series/special.json': 100,
  'series/title-info.json': 100,
  'series/unicode.json': 100,
};

const root = join(fileURLToPath(import.meta.url), '..', '..', 'fixtures');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : [],
  );
}

describe('fixture pass rates', () => {
  const files = walk(root).map((f) => relative(root, f).replace(/\\/g, '/'));

  it('has a threshold for every fixture file', () => {
    expect(files.filter((f) => !(f in THRESHOLDS))).toEqual([]);
  });

  for (const rel of files) {
    it(`${rel} ≥ ${THRESHOLDS[rel] ?? 100}%`, () => {
      const data = JSON.parse(readFileSync(join(root, rel), 'utf8')) as { cases: FixtureCase[] };
      const failures: string[] = [];
      for (const c of data.cases) {
        const r = checkCase(rel, c);
        if (!r.ok) failures.push(`${c.input}: ${r.problems.join('; ')}`);
      }
      const pct = ((data.cases.length - failures.length) / data.cases.length) * 100;
      expect(pct, failures.slice(0, 10).join('\n')).toBeGreaterThanOrEqual(THRESHOLDS[rel] ?? 100);
    });
  }
});

describe('series parsing', () => {
  it('prefers the earliest strong marker over numbers in the episode title', () => {
    const s = parseRelease('Series Title - S02E21 - 18-5-4 720p', 'series').series!;
    expect(s.title).toBe('Series Title');
    expect(s.seasons).toEqual([2]);
    expect(s.episodes).toEqual([21]);
    expect(s.absoluteEpisodes).toEqual([]);
  });

  it('expands a two-number episode range and lists longer runs', () => {
    expect(parseRelease('Show.S03E01-06.720p', 'series').series!.episodes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseRelease('Show - S26E96-97-98-99-100 - Name', 'series').series!.episodes).toEqual([96, 97, 98, 99, 100]);
  });

  it('does not read a resolution as season x episode', () => {
    const s = parseRelease('[Group] Show Title - 07 (1280x720 x264 AAC)', 'series').series!;
    expect(s.absoluteEpisodes).toEqual([7]);
    expect(s.seasons).toEqual([0]);
  });

  it('keeps title numbers in anime titles', () => {
    const s = parseRelease('[SubsPlease] Series Title - 100 Years Quest - 01 (1080p)', 'series').series!;
    expect(s.title).toBe('Series Title - 100 Years Quest');
    expect(s.absoluteEpisodes).toEqual([1]);
  });

  it('reads anime release versions', () => {
    expect(parseRelease('[SubsPlease] Anime Title - 01v2 (1080p)', 'series').series!.releaseVersion).toBe(2);
  });

  it('treats decimal anime episodes as specials without an absolute number', () => {
    const s = parseRelease('[HorribleSubs] Show Slayer - 10.5 [1080p]', 'series').series!;
    expect(s.special).toBe(true);
    expect(s.absoluteEpisodes).toEqual([]);
  });

  it('parses daily shows into season 0 and rejects ambiguous dates', () => {
    const s = parseRelease('Talk.Show.2011.04.18.Guest.HDTV', 'series').series!;
    expect(s.airDate).toBe('2011-04-18');
    expect(s.seasons).toEqual([0]);
    expect(parseRelease('Show - 05-06-2024 HDTV 1080p', 'series').series).toBeNull();
  });

  it('expands multi-season packs', () => {
    const s = parseRelease('Series Title S01 S04 (1080p BluRay)', 'series').series!;
    expect(s.seasons).toEqual([1, 2, 3, 4]);
    expect(s.isMultiSeason).toBe(true);
  });

  it('round-trips CJK titles and picks the Latin alias of fansub releases', () => {
    expect(parseRelease('[风车字幕组][名侦探柯南][857][简体][MP4][1080P]', 'series').series!.title).toBe('名侦探柯南');
    const s = parseRelease('[桜都字幕组][盾之勇者成名录/Anime Series Title][01][BIG5][720P]', 'series').series!;
    expect(s.title).toBe('Anime Series Title');
    expect(s.subGroup).toBe('桜都字幕组');
  });

  it('normalises full-width digits', () => {
    expect(parseRelease('[Subz] My Series - １５８ [1080p]', 'series').series!.absoluteEpisodes).toEqual([158]);
  });

  it('returns season-less batch titles only through parseSeasonTitle', () => {
    expect(parseSeasonTitle('[Group] Series Title Curse (BDRip 1920x1080 x264 FLAC)')?.title).toBe('Series Title Curse');
    expect(parseSeasonTitle('[Group] Series Title Curse (OVA)')).toBeNull();
  });
});

describe('movie parsing', () => {
  it('keeps dotted acronyms', () => {
    expect(parseRelease('R.I.P.D.2013.720p.BluRay.x264-SPARKS', 'movie').movie!.title).toBe('R.I.P.D.');
  });

  it('keeps language words that belong to the title out of the languages', () => {
    const r = parseRelease('The.German.Doctor.2013.LIMITED.DVDRip.x264-RedBlade', 'movie');
    expect(r.movie!.title).toBe('The German Doctor');
    expect(r.languages).toEqual(['Unknown']);
  });

  it('separates an edition after the year', () => {
    expect(parseRelease('Movie.1979.The.Imperial.Edition.BluRay.720p', 'movie').movie!.edition).toBe('Imperial Edition');
    expect(parseRelease('The.Christmas.Edition.1941.720p.HDTV', 'movie').movie!.edition).toBeNull();
  });

  it('rejects names with episode numbering', () => {
    expect(parseRelease('Big Movie (S01E18) Complete 360p HDTV', 'movie').movie).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes titles, keeping common words at the edges', () => {
    expect(normalizeTitle('The Series of the Day')).toBe('theseriesday');
    expect(normalizeTitle('Carnivàle 100%')).toBe('carnivale100percent');
  });

  it('normalizes IMDb ids', () => {
    expect(normalizeImdbId('123')).toBe('tt0000123');
    expect(normalizeImdbId('asfd')).toBeNull();
  });

  it('un-reverses reversed file names and falls back to folders for hashed files', () => {
    expect(parseRelease('50E50S.denorD.mkv', 'series').series!.title).toBe('Droned');
    const r = parsePath('C:\\Test\\Show.Title.S02E19.720p.BluRay.x264-GRP\\ba27283b17c00d01193eacc02a8ba98eeb523a76.mkv');
    expect(r.series!.title).toBe('Show Title');
    expect(r.series!.episodes).toEqual([19]);
  });
});
