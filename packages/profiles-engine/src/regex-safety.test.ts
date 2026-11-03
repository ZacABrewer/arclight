// DATA-34 / DATA-53: admin-written and imported patterns run against titles anyone on an
// indexer controls, so catastrophic patterns are refused on save and skipped at match time.
import { afterEach, describe, expect, it } from 'vitest';
import { QUALITIES, setUnsafeRegexListener, type CustomFormatSpec, type ReleaseEvaluation } from '@arclight/shared';
import { isValidPattern, isValidTerm, matchesTerm, specMatches, termProblem, validateCustomFormat } from './index.js';

const ev = (title: string): ReleaseEvaluation => ({
  title,
  releaseGroup: 'GROUP',
  languages: ['en'],
  quality: { quality: { ...QUALITIES['Bluray-1080p']!, mediaTypes: [...QUALITIES['Bluray-1080p']!.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
  sizeBytes: 1024 ** 3,
  indexerFlags: [],
  releaseKind: 'single',
  mediaType: 'movie',
});

const titleSpec = (pattern: string): CustomFormatSpec => ({ implementation: 'releaseTitle', name: 't', negate: false, required: false, fields: { pattern } });

const warnings: string[] = [];
setUnsafeRegexListener(({ pattern, where }) => warnings.push(`${where}: ${pattern}`));
afterEach(() => {
  warnings.length = 0;
});

describe('custom-format patterns', () => {
  it('refuses a catastrophic pattern on save', () => {
    const issues = validateCustomFormat({ name: 'evil', includeWhenRenaming: false, specifications: [titleSpec('(a+)+$')] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/nests a repeat/);
    expect(isValidPattern('(a+)+$')).toBe(false);
    expect(isValidPattern('x'.repeat(1001))).toBe(false);
    expect(isValidPattern('\\b(x265|HEVC)\\b')).toBe(true);
  });

  it('skips a stored catastrophic pattern at match time, quickly and with a warning', () => {
    const title = 'a'.repeat(5000) + '!';
    const t = performance.now();
    expect(specMatches(titleSpec('(a+)+$'), ev(title))).toBe(false);
    expect(performance.now() - t).toBeLessThan(100);
    expect(warnings).toEqual(['custom format: (a+)+$']);
    // The verdict is cached: no second warning.
    specMatches(titleSpec('(a+)+$'), ev(title));
    expect(warnings).toHaveLength(1);
  });

  it('still matches ordinary patterns, and invalid ones never match', () => {
    expect(specMatches(titleSpec('bluray'), ev('Movie.2019.BluRay'))).toBe(true);
    expect(specMatches(titleSpec('('), ev('Movie ('))).toBe(false);
  });
});

describe('release-profile terms', () => {
  it('refuses catastrophic regex terms on save', () => {
    expect(isValidTerm('/(a+)+$/')).toBe(false);
    expect(termProblem('/(\\w|\\d)+$/i')).toMatch(/alternatives/);
    expect(isValidTerm('/x265|hevc/')).toBe(true);
    expect(isValidTerm('plain words')).toBe(true);
  });

  it('a stored catastrophic term matches nothing, with a warning', () => {
    expect(matchesTerm('/(a+)+$/', 'a'.repeat(5000) + '!')).toBe(false);
    expect(warnings).toEqual(['release profile term: (a+)+$']);
    expect(matchesTerm('/x26[45]/', 'Movie.x264')).toBe(true);
  });
});
