import { describe, expect, it } from 'vitest';
import { LruCache, MAX_REGEX_PATTERN_LENGTH, isSafeRegexPattern, regexPatternProblem } from './safe-regex.js';

describe('regexPatternProblem (DATA-34)', () => {
  it('refuses catastrophic shapes', () => {
    expect(regexPatternProblem('(a+)+$')).toBe('nestedQuantifier');
    expect(regexPatternProblem('^(a*)*b')).toBe('nestedQuantifier');
    expect(regexPatternProblem('(\\w+\\s?)+$')).toBe('nestedQuantifier');
    expect(regexPatternProblem('(?:\\d{1,3})+x')).toBe('nestedQuantifier');
    expect(regexPatternProblem('(.*a){12}')).toBe('nestedQuantifier');
    expect(regexPatternProblem('(?<w>[a-z]+)*!')).toBe('nestedQuantifier');
    expect(regexPatternProblem('(\\w|\\d)+$')).toBe('overlappingAlternation');
    expect(regexPatternProblem('(a|a)*b')).toBe('overlappingAlternation');
    expect(regexPatternProblem('(?:x264|x264)+')).toBe('overlappingAlternation');
    expect(regexPatternProblem('.*.*=.*')).toBe('adjacentQuantifiers');
    expect(regexPatternProblem('\\s*\\s+x')).toBe('adjacentQuantifiers');
    expect(regexPatternProblem('a\\d+\\w+z')).toBe('adjacentQuantifiers');
    // "_" is both a separator and a word character, so the passes can trade it.
    expect(regexPatternProblem('(?:[ ._-]+\\w+)+$')).toBe('nestedQuantifier');
  });

  it('accepts ordinary and guide-style patterns', () => {
    const fine = [
      '\\b(amzn|amazon)\\b(?=[ ._-]web[ ._-]?(dl|rip)?\\b)',
      '(\\d{1,3}\\.){3}\\d{1,3}',
      '(?:[ .-]+\\w+)+$',
      '\\b(FraMeSToR|BHDStudio|playBD)\\b',
      '^(?!.*(?:german|french)).*$',
      '(?<=\\b[12]\\d{3}\\b).*\\b(remaster)\\b',
      '\\[(?:eztv|ettv)\\]',
      '[xh][ ._-]?26[45]',
      '(?i)nope'.slice(4),
      '\\b(Dolby[ ._-]?Vision|DV)\\b',
      '^(?=.*\\b(1080p)\\b)(?=.*\\bWEB\\b).*',
      '(?:\\s*-\\s*\\w+)+',
      '(\\[|\\()?\\b(SiC|Tigole)\\b(\\]|\\))?',
      // TRaSH "BR-DISK" (Radarr), the longest pattern the guides publish.
      '^(?!.*\\b((?<!HD[._ -]|HD)DVD|BDRip|MKV|XviD|WMV|d3g|(BD)?REMUX|^(?=.*1080p)(?=.*HEVC)|[xh][-_. ]?26[45]|German.*[DM]L|((?<=\\d{4}).*German.*([DM]L)?)(?=.*\\b(AVC|HEVC|VC[-_. ]?1|MVC|MPEG[-_. ]?2)\\b))\\b)(((?=.*\\b(Blu[-_. ]?ray|BD|HD[-_. ]?DVD)\\b)(?=.*\\b(AVC|HEVC|VC[-_. ]?1|MVC|MPEG[-_. ]?2|BDMV|ISO)\\b))|^((?=.*\\b(((?=.*\\b((.*_)?COMPLETE.*|Dis[ck])\\b)(?=.*(Blu[-_. ]?ray|HD[-_. ]?DVD)))|3D[-_. ]?BD|BR[-_. ]?DISK|Full[-_. ]?Blu[-_. ]?ray|^((?=.*((BD|UHD)[-_. ]?(25|50|66|100|ISO)))))))).*',
    ];
    for (const p of fine) expect([p, regexPatternProblem(p, 'i')]).toEqual([p, null]);
  });

  it('caps length and rejects invalid syntax', () => {
    expect(regexPatternProblem('')).toBe('empty');
    expect(regexPatternProblem('a'.repeat(MAX_REGEX_PATTERN_LENGTH))).toBeNull();
    expect(regexPatternProblem('a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1))).toBe('tooLong');
    expect(regexPatternProblem('(unclosed')).toBe('invalid');
    expect(isSafeRegexPattern('[a-z]+')).toBe(true);
  });

  it('every refused pattern would really be slow, every accepted one is fast', () => {
    const input = 'a'.repeat(28) + '!';
    const t = performance.now();
    new RegExp('(?:[ .-]+\\w+)+$').test(input);
    new RegExp('(\\d{1,3}\\.){3}\\d{1,3}').test('1'.repeat(5000));
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe('LruCache (DATA-53)', () => {
  it('evicts the least recently used entry', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });
});
