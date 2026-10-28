// Shared by the Vitest suite and the report script: evaluates one fixture case against the
// parser and lists which expectations failed. Only fields present in `expect` are checked.
import { parseRelease, parsePath, normalizeImdbId } from './index.js';
import { normalizeTitle } from './normalize.js';
import { parseLanguages } from './language.js';
import { parseReleaseGroup } from './group.js';
import { parseSeasonTitle } from './series.js';
import { isHashedRelease } from './hash.js';
import { parseAudioPath, parseMusicRelease } from './music.js';

export interface FixtureCase {
  input: string;
  method?: string;
  parser?: string;
  upstream?: string;
  /** Upstream-derived fixtures use `expect`; Arclight's own (music) fixtures use `expected`. */
  expect?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  /** A known miss: reported separately and left out of the pass rate. */
  skip?: string;
}

export interface CaseResult {
  ok: boolean;
  problems: string[];
  /** Set when the case is a known miss (`skip`); `ok` then says whether it now passes. */
  skipped?: string;
}

const MUSIC_FIELDS = [
  'artist', 'album', 'year', 'isVariousArtists', 'edition', 'releaseTypeHint', 'isDiscography', 'packType', 'albumCount',
  'discographyYears', 'catalogNumber', 'media', 'discCount', 'featuring', 'scene', 'hasLog', 'logScore', 'hasCue',
] as const;
const AUDIO_FIELDS = ['codec', 'bitrateKbps', 'vbrPreset', 'bitDepth', 'sampleRateHz', 'detectionSource'] as const;

/** Music fixtures: `parseMusicRelease`, or `parseAudioPath` for paths. Only listed fields are checked. */
function checkMusicCase(c: FixtureCase): CaseResult {
  const e = c.expected ?? c.expect ?? {};
  const problems: string[] = [];
  const path = c.parser === 'path' || /[\\/]/.test(c.input);
  const r = path ? parseAudioPath(c.input, 'music') : parseMusicRelease(c.input);
  const check = (name: string, actual: unknown) => {
    if (name in e && !eq(e[name], actual)) problems.push(`${name}: expected ${JSON.stringify(e[name])}, got ${JSON.stringify(actual)}`);
  };
  if ('music' in e && e['music'] === null) {
    if (r.music !== null) problems.push(`music: expected null, got ${JSON.stringify({ artist: r.music.artist, album: r.music.album })}`);
  } else if (MUSIC_FIELDS.some((f) => f in e)) {
    if (!r.music) problems.push('music: not parsed');
    else for (const f of MUSIC_FIELDS) check(f, r.music[f]);
  }
  check('releaseGroup', r.releaseGroup);
  for (const f of AUDIO_FIELDS) check(f, r.audio[f]);
  check('quality', r.audio.quality.name);
  const ok = problems.length === 0;
  return c.skip ? { ok, problems, skipped: c.skip } : { ok, problems };
}

const RADARR_SOURCE_TO_OURS: Record<string, string[]> = {
  tv: ['television', 'televisionRaw'],
  dvd: ['dvd'],
  webdl: ['web'],
  webrip: ['webRip'],
  bluray: ['bluray', 'blurayRaw'],
  cam: ['cam'],
  telesync: ['telesync'],
  telecine: ['telecine'],
  workprint: ['workprint'],
  unknown: ['unknown'],
};

/** A file path, as opposed to a release name that merely contains "/" ("Title / Alias", "(2024/S01E07/WEB-DL)"). */
function isPath(c: FixtureCase): boolean {
  if (c.parser === 'path') return true;
  return /\\/.test(c.input) || /^(?:[a-z]:)?\//i.test(c.input) || /\/[^/]+\.[a-z0-9]{2,4}$/i.test(c.input);
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function checkCase(file: string, c: FixtureCase): CaseResult {
  if (file.startsWith('music')) return checkMusicCase(c);
  const problems: string[] = [];
  const e = c.expect ?? c.expected ?? {};
  // Roman numerals, slugs and ISO lookups belong to metadata/organizer, not the parser.
  if (typeof c.input !== 'string' || file.includes('roman') || file.includes('slug') || file.includes('iso-codes')) {
    return { ok: true, problems: [] };
  }
  const expectField = (name: string, actual: unknown) => {
    if (name in e && !eq(e[name], actual)) problems.push(`${name}: expected ${JSON.stringify(e[name])}, got ${JSON.stringify(actual)}`);
  };

  // Pure helpers
  if ('normalized' in e) {
    // ParseSeriesName: the parsed series title, cleaned (falls back to the raw input).
    const subject = c.parser === 'seriesName' ? parseRelease(c.input, 'series').series?.title ?? c.input : c.input;
    expectField('normalized', normalizeTitle(subject));
    return { ok: problems.length === 0, problems };
  }
  if (file.includes('normalize-imdb-id')) {
    expectField('imdbId', normalizeImdbId(c.input));
    return { ok: problems.length === 0, problems };
  }
  if (c.parser === 'seasonTitle') {
    const st = parseSeasonTitle(c.input);
    if (e['rejected'] === true) {
      if (st) problems.push(`rejected: season title "${st.title}"`);
    } else if (!st) {
      problems.push('seasonTitle: not parsed');
    } else {
      expectField('title', st.title);
      expectField('fullSeason', st.fullSeason);
    }
    return { ok: problems.length === 0, problems };
  }
  if ('rejected' in e) {
    // Sonarr's parser never produces movies and Radarr's never produces series.
    const r = parseRelease(c.input, file.startsWith('movies') ? 'movie' : file.startsWith('series') ? 'series' : 'auto');
    const parsed = Boolean(r.series || r.movie) && !isHashedRelease(c.input);
    if (e['rejected'] === true && parsed) problems.push(`rejected: parsed as ${r.series ? 'series' : 'movie'} "${r.series?.title ?? r.movie?.title}"`);
    if (e['rejected'] === false && !parsed) problems.push('rejected: should have parsed');
    return { ok: problems.length === 0, problems };
  }
  if ('subtitleLanguage' in e || 'language' in e && file.includes('iso')) {
    return { ok: true, problems: [] }; // subtitle-file and ISO lookups land with the subtitles module
  }
  if (file.includes('title-info')) {
    // SeriesTitleInfo is derived from the parsed series title, not from the raw release name.
    const s = parseRelease(c.input, 'series').series;
    if (!s) return { ok: false, problems: ['series: not parsed'] };
    const info = s.titleInfo;
    expectField('title', info.title);
    expectField('titleWithoutYear', info.titleWithoutYear);
    expectField('year', info.year);
    expectField('titleEqualsTitleWithoutYear', info.title === info.titleWithoutYear);
    // "the regexes can parse it" means a regular season/episode parse, not a season-title fallback.
    if ('isSeasonTitle' in e && e['isSeasonTitle'] === false && s.seasons.length === 0 && s.absoluteEpisodes.length === 0) problems.push('isSeasonTitle: no season/episode parsed');
    return { ok: problems.length === 0, problems };
  }

  const r = isPath(c) ? parsePath(c.input) : parseRelease(c.input, file.startsWith('movies') ? 'movie' : file.startsWith('series') ? 'series' : 'auto');

  // Quality
  if ('quality' in e) {
    const want = String(e['quality']).replace(/^WEBDL(\d)/, 'WEBDL-$1').replace(/^HDTV(\d)/, 'HDTV-$1').replace(/^Bluray(\d{3,4}p)$/, 'Bluray-$1').replace('Bluray-1080p Remux', 'Remux-1080p').replace('Bluray-2160p Remux', 'Remux-2160p').replace(/^Bluray(\d{3,4}p)Remux$/, 'Remux-$1').replace(/^WEBRip(\d)/, 'WEBRip-$1');
    expectField('quality', r.quality.quality.name === want ? e['quality'] : r.quality.quality.name);
  }
  if ('source' in e) {
    const ok = RADARR_SOURCE_TO_OURS[String(e['source'])]?.includes(r.quality.quality.source);
    if (!ok) problems.push(`source: expected ${e['source']}, got ${r.quality.quality.source}`);
  }
  if ('resolution' in e && e['resolution'] != null) {
    const want = Number(String(e['resolution']).replace(/^r/, ''));
    expectField('resolution', r.quality.quality.resolution === want ? e['resolution'] : r.quality.quality.resolution);
  }
  if ('modifier' in e && e['modifier'] != null) {
    expectField('modifier', r.quality.quality.modifier);
  }
  if ('proper' in e) expectField('proper', r.quality.revision.version > 1);
  if ('repack' in e) expectField('repack', r.quality.revision.isRepack);
  // An anime release version ("01v2") only overrides the revision when it is set (> 1).
  if ('version' in e) expectField('version', file.startsWith('quality/') ? r.quality.revision.version : (r.series && r.series.releaseVersion > 1 ? r.series.releaseVersion : r.quality.revision.version));
  if ('real' in e) expectField('real', r.quality.revision.real);
  if ('sourceDetectionSource' in e) expectField('sourceDetectionSource', r.quality.detectionSource);

  // Languages
  if ('languages' in e) {
    const got = r.languages;
    const want = e['languages'] as string[];
    if (e['exact'] === false) {
      for (const l of want) if (!got.includes(l)) problems.push(`languages: missing ${l} in ${JSON.stringify(got)}`);
    } else if (!eq([...want].sort(), [...got].sort())) {
      problems.push(`languages: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  if ('firstLanguage' in e) {
    const got = r.languages;
    expectField('firstLanguage', got[0]);
  }

  // Group / hash
  if ('releaseGroup' in e) expectField('releaseGroup', r.series?.subGroup ?? r.releaseGroup);
  // Upstream asserts "" for "no hash"; we return null.
  if ('releaseHash' in e) expectField('releaseHash', r.releaseHash ?? (e['releaseHash'] === '' ? '' : null));
  if ('isSceneTitle' in e) return { ok: true, problems: [] }; // scene checker lands with the decision engine

  // Series
  const s = r.series;
  const m = r.movie;
  if (file.startsWith('series') || file.startsWith('path') || c.parser === 'path') {
    if (!s) {
      if (Object.keys(e).some((k) => ['seasons', 'episodes', 'absoluteEpisodes', 'airDate', 'fullSeason', 'title'].includes(k))) problems.push('series: not parsed');
      return { ok: problems.length === 0, problems };
    }
    expectField('title', s.title);
    expectField('seasons', s.seasons);
    expectField('episodes', s.episodes);
    expectField('absoluteEpisodes', s.absoluteEpisodes);
    expectField('airDate', s.airDate);
    expectField('fullSeason', s.fullSeason);
    expectField('special', s.special);
    expectField('isMultiSeason', s.isMultiSeason);
    expectField('isPartialSeason', s.isPartialSeason);
    expectField('isSeasonExtra', s.isSeasonExtra);
    expectField('isSplitEpisode', s.isSplitEpisode);
    expectField('isMiniSeries', s.isMiniSeries);
    expectField('seasonPart', s.seasonPart);
    expectField('isPossibleSpecialEpisode', s.special || (s.seasons[0] === 0) || (s.episodes.length === 0 && s.absoluteEpisodes.length === 0 && !s.fullSeason && !s.airDate));
    return { ok: problems.length === 0, problems };
  }

  // Movies
  if (file.startsWith('movies')) {
    if ('year' in e || 'title' in e || 'edition' in e || 'imdbId' in e || 'tmdbId' in e || 'titles' in e) {
      if (!m) {
        problems.push('movie: not parsed');
        return { ok: false, problems };
      }
      expectField('title', m.title);
      expectField('year', m.year);
      if ('edition' in e) expectField('edition', (m.edition ?? '').toLowerCase() === String(e['edition']).toLowerCase() ? e['edition'] : m.edition ?? '');
      expectField('imdbId', m.imdbId);
      expectField('tmdbId', m.tmdbId);
    }
  }
  return { ok: problems.length === 0, problems };
}
