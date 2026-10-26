import { describe, expect, it } from 'vitest';
import {
  EPISODE_SCORES,
  MOVIE_SCORES,
  chooseBest,
  computeMatches,
  guessMatches,
  matchReport,
  minimumScore,
  passesReleaseFilters,
  releaseGroupsMatch,
  sanitize,
  score,
  scoreCandidate,
  scorePercent,
  selectCandidates,
  sourceFamily,
} from './scoring.js';
import type { MatchKey, SubtitleCandidate, SubtitleQuery, WantedLanguage } from './types.js';

const episodeQuery: SubtitleQuery = {
  mediaType: 'episode',
  title: 'The Office',
  alternativeTitles: ['The Office US'],
  season: 3,
  episode: 5,
  year: 2005,
  releaseGroup: 'LOL',
  source: 'HDTV',
  resolution: '720p',
  videoCodec: 'x264',
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
};

const movieQuery: SubtitleQuery = {
  mediaType: 'movie',
  title: 'Movie Title',
  year: 2019,
  imdbId: 'tt1234567',
  releaseGroup: 'SPARKS',
  source: 'Blu-ray',
  resolution: '1080p',
  videoCodec: 'H.264',
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
};

function cand(over: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  return {
    provider: 'opensubtitlescom',
    id: over.id ?? 'x',
    language: 'en',
    forced: false,
    hi: false,
    releaseInfo: '',
    matches: new Set(),
    score: 0,
    scoreWithoutHash: 0,
    hashVerifiable: false,
    hiVerifiable: true,
    ...over,
  };
}

const set = (...k: MatchKey[]) => new Set<MatchKey>(k);
const EN: WantedLanguage = { tag: 'en', forced: false, hi: 'normal' };

describe('score tables', () => {
  it('episode max excluding hash is 360 and hash is max - 1', () => {
    const total = Object.entries(EPISODE_SCORES).filter(([k]) => k !== 'hash').reduce((n, [, v]) => n + (v ?? 0), 0);
    expect(total).toBe(360);
    expect(EPISODE_SCORES.hash).toBe(359);
  });
  it('movie max excluding hash is 180 and hash is max - 1', () => {
    const total = Object.entries(MOVIE_SCORES).filter(([k]) => k !== 'hash').reduce((n, [, v]) => n + (v ?? 0), 0);
    expect(total).toBe(180);
    expect(MOVIE_SCORES.hash).toBe(179);
  });
  it('minimum scores truncate: 324 of 360 and 126 of 180', () => {
    expect(minimumScore('episode')).toBe(324);
    expect(minimumScore('movie')).toBe(126);
    expect(minimumScore('episode', 85)).toBe(306);
  });
  it('percent has two decimals (359/360 = 99.72)', () => {
    expect(scorePercent(359, 'episode')).toBe(99.72);
    expect(scorePercent(335, 'episode')).toBe(93.06);
  });
  it('spec examples: 335 passes, 245 fails at 90%', () => {
    expect(score(set('series', 'year', 'season', 'episode', 'source'), 'episode')).toBe(335);
    expect(score(set('series', 'season', 'episode', 'source'), 'episode')).toBe(245);
    expect(score(set('series', 'season', 'episode', 'release_group', 'audio_codec', 'resolution', 'video_codec', 'streaming_service'), 'episode')).toBe(244);
  });
  it('movie examples: title+year+edition = 130 passes, title+year = 100 fails', () => {
    expect(score(set('title', 'year', 'edition'), 'movie')).toBe(130);
    expect(score(set('title', 'year'), 'movie')).toBeLessThan(minimumScore('movie'));
  });
  it('hash wins regardless of other keys', () => {
    expect(score(set('hash', 'series', 'year'), 'episode')).toBe(359);
    expect(score(set('hash'), 'movie')).toBe(179);
  });
});

describe('helpers', () => {
  it('sanitizes titles per R4.4', () => {
    expect(sanitize("Marvel's Agents of S.H.I.E.L.D.")).toBe('marvels agents of s h i e l d');
    expect(sanitize('Star Trek: Discovery (2017)')).toBe('star trek discovery 2017');
  });
  it('maps sources to families', () => {
    expect(sourceFamily('HDTV')).toBe('TV');
    expect(sourceFamily('Ultra HDTV')).toBe('TV');
    expect(sourceFamily('Blu-ray')).toBe('Disk-HD');
    expect(sourceFamily('HD-DVD')).toBe('Disk-HD');
    expect(sourceFamily('DVD')).toBe('Disk-SD');
    expect(sourceFamily('webRip')).toBe('Web');
    expect(sourceFamily('SATRip')).toBe('Air');
  });
  it('release group equivalence', () => {
    expect(releaseGroupsMatch('LOL', 'DIMENSION')).toBe(true);
    expect(releaseGroupsMatch('[eztv] immerse', 'FLEET')).toBe(true);
    expect(releaseGroupsMatch('SPARKS', 'GECKOS')).toBe(false);
    expect(releaseGroupsMatch('AVS, KILLERS', 'SVA')).toBe(true);
  });
  it('must contain / must not contain', () => {
    expect(passesReleaseFilters('Show.S01E01.720p.WEB-NTb', ['web'], ['hdtv'])).toBe(true);
    expect(passesReleaseFilters('Show.S01E01.720p.HDTV-LOL', [], ['hdtv'])).toBe(false);
    expect(passesReleaseFilters('Show.S01E01.720p.HDTV-LOL', ['web', 'lol'])).toBe(false);
    expect(passesReleaseFilters('a(b', ['a(b'])).toBe(true);
  });
});

describe('guessMatches / computeMatches', () => {
  it('matches a full episode release', () => {
    const m = guessMatches(episodeQuery, 'The.Office.US.S03E05.720p.HDTV.x264-LOL');
    for (const k of ['series', 'season', 'episode', 'year', 'source', 'resolution', 'video_codec', 'release_group'] as const) expect(m.has(k)).toBe(true);
  });
  it('accepts equivalent release groups (DIMENSION for LOL)', () => {
    expect(guessMatches(episodeQuery, 'The.Office.US.S03E05.720p.HDTV.x264-DIMENSION').has('release_group')).toBe(true);
  });
  it('drops release_group when source does not match', () => {
    const r = computeMatches(episodeQuery, cand({ releaseInfo: 'The.Office.US.S03E05.720p.WEB-DL.x264-LOL' }));
    expect(r.matches.has('release_group')).toBe(false);
    expect(r.matches.has('source')).toBe(false);
  });
  it('wrong episode does not match episode', () => {
    expect(guessMatches(episodeQuery, 'The.Office.US.S03E06.720p.HDTV.x264-LOL').has('episode')).toBe(false);
  });
  it('movie release with absent edition earns edition (R4.11)', () => {
    const r = computeMatches(movieQuery, cand({ releaseInfo: 'Movie.Title.2019.1080p.BluRay.x264-SPARKS' }));
    expect([...r.matches].sort()).toEqual(['edition', 'release_group', 'resolution', 'source', 'streaming_service', 'title', 'video_codec', 'year'].sort());
    expect(score(r.matches, 'movie')).toBe(178);
  });
  it('series imdb id equivalence adds series and year but not to original matches', () => {
    const r = computeMatches(episodeQuery, cand({ matches: set('series_imdb_id', 'season', 'episode') }));
    expect(r.matches.has('series')).toBe(true);
    expect(r.matches.has('year')).toBe(true);
    expect(r.original.has('series')).toBe(false);
  });
  it('episode imdb id implies series, year, season, episode', () => {
    const r = computeMatches(episodeQuery, cand({ matches: set('imdb_id') }));
    for (const k of ['series', 'year', 'season', 'episode'] as const) expect(r.matches.has(k)).toBe(true);
  });
  it('verifiable hash with corroboration reduces to {hash} = 359', () => {
    const c = cand({ hashVerifiable: true, matches: set('hash', 'series', 'season', 'episode'), releaseInfo: 'The.Office.US.S03E05.720p.HDTV.x264-LOL' });
    const s = scoreCandidate(episodeQuery, c, EN);
    expect([...s.matches]).toEqual(['hash']);
    expect(s.score).toBe(359);
    expect(s.scoreWithoutHash).toBeGreaterThan(300);
  });
  it('verifiable hash without corroboration is dropped', () => {
    const c = cand({ hashVerifiable: true, matches: set('hash', 'series') });
    const s = scoreCandidate(episodeQuery, c, EN);
    expect(s.matches.has('hash')).toBe(false);
    expect(s.score).toBeLessThan(359);
  });
  it('unverifiable hash claim is kept (embedded)', () => {
    const s = scoreCandidate(movieQuery, cand({ hashVerifiable: false, matches: set('hash') }));
    expect(s.score).toBe(179);
  });
  it('specials skip hash validation', () => {
    const q = { ...episodeQuery, season: 0 };
    const s = scoreCandidate(q, cand({ hashVerifiable: true, matches: set('hash') }));
    expect(s.score).toBe(359);
  });
  it('hearing_impaired match only in force modes', () => {
    const hiCand = cand({ hi: true });
    expect(computeMatches(episodeQuery, hiCand, { tag: 'en', forced: false, hi: 'required' }).matches.has('hearing_impaired')).toBe(true);
    expect(computeMatches(episodeQuery, hiCand, EN).matches.has('hearing_impaired')).toBe(false);
    expect(computeMatches(episodeQuery, cand(), { tag: 'en', forced: false, hi: 'excluded' }).matches.has('hearing_impaired')).toBe(true);
  });
  it('history report trims hash matches', () => {
    expect(matchReport(set('hash', 'hearing_impaired'), 'episode')).toEqual({ matched: ['hash', 'hearing_impaired'], notMatched: [] });
    const r = matchReport(set('title', 'year'), 'movie');
    expect(r.matched).toEqual(['title', 'year']);
    expect(r.notMatched).toContain('source');
    expect(r.notMatched).not.toContain('hash');
  });
});

describe('selection', () => {
  const good = (id: string, over: Partial<SubtitleCandidate> = {}) =>
    scoreCandidate(episodeQuery, cand({ id, releaseInfo: 'The.Office.US.S03E05.720p.HDTV.x264-LOL', ...over }), EN);

  it('picks the highest score and stops below the minimum', () => {
    const low = scoreCandidate(episodeQuery, cand({ id: 'low', releaseInfo: 'The.Office.US.S03E05' }), EN);
    const list = selectCandidates(episodeQuery, [low, good('a')], EN);
    expect(list.map((c) => c.id)).toEqual(['a']);
  });
  it('ties keep provider order', () => {
    const list = selectCandidates(episodeQuery, [good('first'), good('second')], EN);
    expect(list.map((c) => c.id)).toEqual(['first', 'second']);
  });
  it('never crosses forced and normal', () => {
    const forced = good('f', { forced: true });
    expect(chooseBest(episodeQuery, [forced], EN)).toBeUndefined();
    expect(chooseBest(episodeQuery, [forced], { tag: 'en', forced: true, hi: 'normal' })?.id).toBe('f');
  });
  it('force-HI skips verifiable non-HI candidates', () => {
    const wanted: WantedLanguage = { tag: 'en', forced: false, hi: 'required' };
    const normal = scoreCandidate(episodeQuery, cand({ id: 'n', releaseInfo: 'The.Office.US.S03E05.720p.HDTV.x264-LOL' }), wanted);
    const hi = scoreCandidate(episodeQuery, cand({ id: 'h', hi: true, releaseInfo: 'The.Office.US.S03E05.720p.HDTV.x264-LOL' }), wanted);
    expect(selectCandidates(episodeQuery, [normal, hi], wanted).map((c) => c.id)).toEqual(['h']);
  });
  it('HI excluded never returns HI', () => {
    const wanted: WantedLanguage = { tag: 'en', forced: false, hi: 'excluded' };
    const hi = scoreCandidate(episodeQuery, cand({ id: 'h', hi: true, hiVerifiable: false, releaseInfo: 'The.Office.US.S03E05.720p.HDTV.x264-LOL' }), wanted);
    expect(selectCandidates(episodeQuery, [hi], wanted)).toEqual([]);
  });
  it('episodes need season+episode in original matches, not just equivalents', () => {
    const viaIdOnly = scoreCandidate(episodeQuery, cand({ id: 'id', matches: set('tvdb_id', 'source', 'release_group') }), EN);
    expect(viaIdOnly.score).toBeGreaterThanOrEqual(324);
    expect(selectCandidates(episodeQuery, [viaIdOnly], EN)).toEqual([]);
  });
  it('honours a configured minimum and manual (no minimum) mode', () => {
    const mid = scoreCandidate(episodeQuery, cand({ id: 'm', releaseInfo: 'The.Office.US.S03E05.WEB' }), EN);
    expect(selectCandidates(episodeQuery, [mid], EN)).toEqual([]);
    expect(selectCandidates(episodeQuery, [mid], EN, { minScore: 200 }).map((c) => c.id)).toEqual(['m']);
    expect(selectCandidates(episodeQuery, [mid], EN, { ignoreMinimum: true }).map((c) => c.id)).toEqual(['m']);
  });
});
