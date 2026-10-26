import { describe, expect, it } from 'vitest';
import { parseFormat, normalizeTokenName, fitTitles, episodeTitles, type Token } from './tokens.js';
import {
  cleanIllegal,
  cleanTitle,
  firstCharacter,
  formatEdition,
  restorePlaceholders,
  titleThe,
  truncateText,
  type CleanOptions,
} from './text.js';
import { audioCodecName, languageListText, videoCodecName } from './media-info.js';

const tok = (format: string, opts = {}): Token => {
  const t = parseFormat(format, opts).find((p): p is Token => p.kind === 'token');
  if (!t) throw new Error(`no token in ${format}`);
  return t;
};

describe('tokenizer', () => {
  it.each([
    ['{Series Title}', '', 'Series Title', ' ', undefined, ''],
    ['{Series.Title}', '', 'Series.Title', '.', undefined, ''],
    ['{series_title}', '', 'series_title', '_', undefined, ''],
    ['{-Release Group}', '-', 'Release Group', ' ', undefined, ''],
    ['{[Quality Title]}', '[', 'Quality Title', ' ', undefined, ']'],
    ['{Series TitleThe:30}', '', 'Series TitleThe', ' ', '30', ''],
    ['{MediaInfo AudioLanguages:EN+DE}', '', 'MediaInfo AudioLanguages', ' ', 'EN+DE', ''],
    ['{ Release Group}', ' ', 'Release Group', ' ', undefined, ''],
    ['{season:00}', '', 'season', '', '00', ''],
    ['{ - Release Group}', ' - ', 'Release Group', ' ', undefined, ''],
  ])('parses %s', (format, prefix, name, sep, mod, suffix) => {
    const t = tok(format);
    expect([t.prefix, t.name, t.separator, t.modifier, t.suffix]).toEqual([prefix, name, sep, mod, suffix]);
  });

  it('treats three-word names and unbalanced braces as literal text', () => {
    expect(parseFormat('{Series Title Year}')).toEqual([{ kind: 'literal', text: '{Series Title Year}' }]);
    expect(parseFormat('a { b')).toEqual([{ kind: 'literal', text: 'a { b' }]);
  });

  it('supports TV brace escaping', () => {
    expect(parseFormat('{{x}}', { escapes: true })).toEqual([{ kind: 'literal', text: '{x}' }]);
  });

  it('parses movie wrapper tokens', () => {
    const t = tok('{edition-{Edition Tags}}', { wrappers: true });
    expect([t.wrapper, t.name]).toEqual(['edition-', 'Edition Tags']);
  });

  it('normalises token names ignoring case and punctuation', () => {
    const names = ['Series Title', 'series.title', 'SERIES_TITLE', 'Series-Title'].map(normalizeTokenName);
    expect(new Set(names).size).toBe(1);
  });
});

describe('text transforms', () => {
  it.each([
    ['Tom & Jerry', 'Tom and Jerry'],
    ["The Series Title's!", "The Series Title's!"],
    ["Marvel's Agents of S.H.I.E.L.D.", 'Marvels Agents of S.H.I.E.L.D.'],
    ['Amélie (2001)', 'Amelie 2001'],
    ['CSI: Miami', 'CSI Miami'],
    ['A / B', 'A B'],
  ])('cleanTitle(%s)', (input, expected) => {
    expect(cleanTitle(input)).toBe(expected);
  });

  it.each([
    ['The Office (US)', 'Office, The (US)'],
    ['A Series', 'Series, A'],
    ['An Example', 'Example, An'],
    ['Theory', 'Theory'],
  ])('titleThe(%s)', (input, expected) => {
    expect(titleThe(input)).toBe(expected);
  });

  it.each([
    ['Game of Thrones', '10', 'Game of...'],
    ['Game of Thrones', '-10', '...Thrones'],
    ['Game of Thrones', '30', 'Game of Thrones'],
    ['Breaking Bad Extra', '12', 'Breaking...'],
    ['Game of Thrones', 'abc', 'Game of Thrones'],
    ['   ', '5', ''],
  ])('truncateText(%s, %s)', (input, mod, expected) => {
    expect(restorePlaceholders(truncateText(input, mod))).toBe(expected);
  });

  it('first character uses diacritic-free upper-case alphanumerics', () => {
    expect(firstCharacter('élan')).toBe('E');
    expect(firstCharacter("'Allo")).toBe('A');
    expect(firstCharacter('!!')).toBe('_');
  });

  it.each([
    ['Ultimate extended edition', 'Ultimate Extended Edition'],
    ['imax 70mm cut', 'IMAX 70mm Cut'],
    ['40TH ANNIVERSARY 3d', '40th Anniversary 3D'],
    ["director's cut", "Director's Cut"],
  ])('formatEdition(%s)', (input, expected) => {
    expect(formatEdition(input)).toBe(expected);
  });

  const opts = (o: Partial<CleanOptions>): CleanOptions => ({
    replaceIllegalCharacters: true,
    colonReplacement: 'smart',
    ...o,
  });
  it.each([
    ['Star Trek: Voyager', opts({}), 'Star Trek - Voyager'],
    ['Mission:Impossible', opts({}), 'Mission-Impossible'],
    ['Who? What*', opts({}), 'Who! What-'],
    ['Star Trek: Voyager', opts({ colonReplacement: 'delete' }), 'Star Trek Voyager'],
    ['Star Trek: Voyager', opts({ colonReplacement: 'dash' }), 'Star Trek- Voyager'],
    ['Star Trek: Voyager', opts({ colonReplacement: 'spaceDash' }), 'Star Trek - Voyager'],
    ['A: B', opts({ colonReplacement: 'spaceDashSpace' }), 'A -  B'],
    ['A: B', opts({ colonReplacement: 'custom', customColonReplacement: ' ~' }), 'A ~ B'],
    ['AC/DC \\ <x> |"y"', opts({}), 'AC+DC + x y'],
    ['AC/DC: <x>?*', opts({ replaceIllegalCharacters: false }), 'ACDC x'],
    ['  ..lead and trail  ', opts({}), 'lead and trail'],
  ])('cleanIllegal(%s)', (input, o, expected) => {
    expect(cleanIllegal(input, o)).toBe(expected);
  });
});

describe('episode titles', () => {
  const eps = (...titles: string[]) =>
    titles.map((title, i) => ({ seasonNumber: 1, episodeNumber: i + 1, title }));

  it('strips multipart markers and de-duplicates', () => {
    expect(episodeTitles(eps('Pilot (1)', 'Pilot (2)'))).toEqual(['Pilot']);
    expect(episodeTitles(eps('Finale Part 1', 'Finale: Part 2'))).toEqual(['Finale']);
    expect(episodeTitles(eps('Alpha', 'Beta'))).toEqual(['Alpha', 'Beta']);
  });

  it('single titles lose trailing dots, spaces and question marks only', () => {
    expect(episodeTitles(eps('Who Is It?.. '))).toEqual(['Who Is It']);
    expect(episodeTitles(eps('Pilot (1)'))).toEqual(['Pilot (1)']);
  });

  it('fits titles into a byte budget in the spec order', () => {
    const r = (t: string[], b: number) => restorePlaceholders(fitTitles(t, ' + ', b));
    expect(r(['Alpha', 'Omega'], 13)).toBe('Alpha + Omega');
    expect(r(['Alpha', 'Omega'], 12)).toBe('Alpha...');
    expect(r(['Alpha', 'Mid', 'Omega'], 14)).toBe('Alpha...Omega');
    expect(r(['Abcdefghij'], 8)).toBe('Abcde...');
    expect(r(['ééééé'], 7)).toBe('éé...');
  });
});

describe('media info helpers', () => {
  it.each([
    [{ videoFormat: 'h264' }, 'Show.x264-GRP', 'x264'],
    [{ videoFormat: 'h264' }, 'Show.AVC.Remux', 'AVC'],
    [{ videoFormat: 'h264' }, null, 'h264'],
    [{ videoFormat: 'hevc' }, 'Show.HEVC', 'HEVC'],
    [{ videoFormat: 'hevc' }, null, 'h265'],
    [{ videoFormat: 'mpeg4', videoCodecId: 'XVID' }, null, 'XviD'],
    [{ videoFormat: 'mpeg2video' }, null, 'MPEG2'],
    [{ videoFormat: 'vp9' }, null, 'VP9'],
    [{ videoFormat: 'rawvideo' }, null, ''],
    [{ videoFormat: 'weird' }, null, 'weird'],
  ])('video codec %o', (info, scene, expected) => {
    expect(videoCodecName(info, scene)).toBe(expected);
  });

  it.each([
    [{ audioFormat: 'truehd', audioProfile: 'TrueHD + Atmos' }, 'TrueHD Atmos'],
    [{ audioFormat: 'dts', audioProfile: 'DTS-HD MA' }, 'DTS-HD MA'],
    [{ audioFormat: 'dts', audioProfile: 'DTS:X' }, 'DTS-X'],
    [{ audioFormat: 'eac3', audioCodecId: 'ec+3' }, 'EAC3 Atmos'],
    [{ audioFormat: 'aac', audioProfile: 'HE-AAC' }, 'HE-AAC'],
    [{ audioFormat: 'pcm_s16le' }, 'PCM'],
    [{ audioCodec: 'opus' }, 'Opus'],
  ])('audio codec %o', (info, expected) => {
    expect(audioCodecName(info)).toBe(expected);
  });

  it.each([
    [['eng', 'ger', 'ger'], undefined, false, '[EN+DE]'],
    [['eng'], undefined, true, ''],
    [['eng'], undefined, false, '[EN]'],
    [['eng', 'ger'], 'DE', true, '[DE]'],
    [['eng', 'ger'], '-DE', true, ''],
    [['en', 'de', 'fr'], 'EN+', false, '[EN+--]'],
    [['fre', 'und', ''], undefined, false, '[FR]'],
    [['klingon'], undefined, false, '[klingon]'],
  ])('languages %o mod %s', (langs, mod, skip, expected) => {
    expect(restorePlaceholders(languageListText(langs, mod, skip))).toBe(expected);
  });
});
