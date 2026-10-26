import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '@arclight/shared';
import {
  baseLanguages,
  fileAudioLanguages,
  missingLanguages,
  normalizeLanguage,
  releaseAudioLanguages,
  requiredAudioFor,
  scopeApplies,
  scopeKeyOf,
  slotLanguageFit,
  type AudioRequirementRow,
} from './audio.js';

const row = (o: Partial<AudioRequirementRow>): AudioRequirementRow => ({
  kind: 'audio',
  mediaType: 'series',
  movieId: null,
  seriesId: 1,
  seasonNumber: null,
  episodeId: null,
  language: 'es',
  mode: 'replace',
  ...o,
});

describe('language normalisation', () => {
  it('reads ISO 639-2 tags, names, parser names and regional tags', () => {
    expect(normalizeLanguage('spa')).toBe('es');
    expect(normalizeLanguage('ger')).toBe('de');
    expect(normalizeLanguage('Spanish')).toBe('es');
    expect(normalizeLanguage('Spanish (Latino)')).toBe('es');
    expect(normalizeLanguage('pt_br')).toBe('pt-BR');
    expect(normalizeLanguage('und')).toBeNull();
    expect(normalizeLanguage('unknown')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(baseLanguages(['eng', 'en', 'pt-BR', 'por', null, 'und'])).toEqual(['en', 'pt']);
    expect(missingLanguages(['spa', 'eng'], ['en'])).toEqual(['es']);
  });
});

describe('file audio languages', () => {
  const info = (o: Partial<MediaInfo>): MediaInfo => ({ ...o });

  it('uses the probed streams, then the summary list', () => {
    expect(fileAudioLanguages({ mediaInfo: info({ audioStreams: [{ codec: 'eac3', language: 'eng' }, { codec: 'ac3', language: 'spa' }] }) })).toEqual(['en', 'es']);
    expect(fileAudioLanguages({ mediaInfo: info({ audioLanguages: ['fre'] }) })).toEqual(['fr']);
  });

  it('is unknown when not analysed or untagged, unless asked to fall back to the release name', () => {
    expect(fileAudioLanguages({ mediaInfo: null, languages: ['en'] })).toBeNull();
    expect(fileAudioLanguages({ mediaInfo: info({ audioStreams: [{ codec: 'aac', language: 'und' }] }), languages: ['English'] })).toBeNull();
    expect(fileAudioLanguages({ mediaInfo: null, languages: ['English'] }, { fallback: true })).toEqual(['en']);
    expect(fileAudioLanguages({ mediaInfo: null, languages: ['unknown'] }, { fallback: true })).toBeNull();
  });
});

describe('release audio languages', () => {
  it('takes the named languages, else the original language', () => {
    expect(releaseAudioLanguages('Movie.2020.SPANISH.ENGLISH.1080p.WEB-DL-GRP', ['es', 'en'], 'en')).toEqual(['es', 'en']);
    expect(releaseAudioLanguages('Movie.2020.1080p.WEB-DL-GRP', ['unknown'], 'en')).toEqual(['en']);
    expect(releaseAudioLanguages('Movie.2020.1080p.WEB-DL-GRP', [], 'ja')).toEqual(['ja']);
    expect(releaseAudioLanguages('Movie.2020.1080p.WEB-DL-GRP', ['original'], 'fr')).toEqual(['fr']);
  });

  it('adds the original language for MULTi and English for a bare dual-audio tag', () => {
    expect(releaseAudioLanguages('Film.2020.MULTi.VFF.1080p.BluRay-GRP', ['fr'], 'en')).toEqual(['fr', 'en']);
    expect(releaseAudioLanguages('Show.S01E01.1080p.Dual-Audio.WEB-DL-GRP', [], 'ja')).toEqual(['ja', 'en']);
    // Subtitle tags say nothing about audio.
    expect(releaseAudioLanguages('Film.2020.MULTi.Subs.1080p.WEB-DL-GRP', ['fr'], 'en')).toEqual(['fr']);
  });
});

describe('scopes and requirements', () => {
  const eps = [
    { id: 11, seasonNumber: 1 },
    { id: 12, seasonNumber: 1 },
  ];

  it('builds keys and matches series, season and episode scopes', () => {
    expect(scopeKeyOf({ movieId: 3, seriesId: null, seasonNumber: null, episodeId: null })).toBe('movie:3');
    expect(scopeKeyOf({ movieId: null, seriesId: 1, seasonNumber: 2, episodeId: null })).toBe('series:1:s2');
    expect(scopeKeyOf({ movieId: null, seriesId: 1, seasonNumber: null, episodeId: 7 })).toBe('series:1:e7');
    expect(scopeApplies(row({}), { seriesId: 1, episodes: eps })).toBe(true);
    expect(scopeApplies(row({ seasonNumber: 2 }), { seriesId: 1, episodes: eps })).toBe(false);
    expect(scopeApplies(row({ seasonNumber: 1 }), { seriesId: 1, episodes: eps })).toBe(true);
    expect(scopeApplies(row({ episodeId: 12 }), { seriesId: 1, episodes: eps })).toBe(true);
    expect(scopeApplies(row({ episodeId: 13 }), { seriesId: 1, episodes: eps })).toBe(false);
    expect(scopeApplies(row({ seriesId: 2 }), { seriesId: 1, episodes: eps })).toBe(false);
    expect(scopeApplies(row({ mediaType: 'movie', movieId: 4, seriesId: null }), { movieId: 4 })).toBe(true);
  });

  it('a slot with its own languages wins over item-level replace requirements', () => {
    const rows = [row({ language: 'es' }), row({ language: 'fr', mode: 'version' }), row({ kind: 'subtitle', language: 'de' })];
    expect(requiredAudioFor(rows, { seriesId: 1, episodes: eps }, null)).toEqual({ languages: ['es'], keepExisting: true });
    expect(requiredAudioFor(rows, { seriesId: 1, episodes: eps }, { audioLanguages: ['fre'] })).toEqual({ languages: ['fr'], keepExisting: false });
    expect(requiredAudioFor([], { seriesId: 1, episodes: eps }, null)).toBeNull();
  });

  it('ranks version slots by audio fit', () => {
    expect(slotLanguageFit({ audioLanguages: ['es'] }, ['es', 'en'])).toBe(2);
    expect(slotLanguageFit({}, ['en'])).toBe(1);
    expect(slotLanguageFit({ audioLanguages: ['es'] }, ['en'])).toBe(0);
  });
});
