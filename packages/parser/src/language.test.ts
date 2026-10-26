import { describe, expect, it } from 'vitest';
import { parseLanguages } from './language.js';

describe('parseLanguages', () => {
  it('is Unknown when the release names no language', () => {
    expect(parseLanguages('Title.the.Series.2009.S01E14.HDTV.XviD-LOL', 'LOL')).toEqual(['Unknown']);
  });

  it('ignores language words in the title before the episode marker or year', () => {
    expect(parseLanguages('Title.the.Spanish.Series.S02E02.1080p.WEB.H264-CAKES')).toEqual(['Unknown']);
    expect(parseLanguages('The Danish Movie 2015')).toEqual(['Unknown']);
  });

  it('does not mistake a resolution for a year', () => {
    expect(parseLanguages('Series Title (Temporada 11 Completa) Audio Dual Ingles/Latino 1920x1080')).toContain('Spanish (Latino)');
  });

  it('treats tags followed by a SUBS marker as subtitle languages', () => {
    expect(parseLanguages('Detektiv.Conan.1996.S33E39.Ger.Eng.Fre.Sub.AAC.1080p.WEB.H264-WeebPinn')).toEqual(['Unknown']);
    expect(parseLanguages('Movie.Title.1994.PL-SUB.1080p.XviD-LOL', 'LOL')).toEqual(['Unknown']);
    expect(parseLanguages('Series.Title.S01E01.SUBFRENCH.1080p.WEB.x264-GROUP')).toEqual(['Unknown']);
  });

  it('keeps a full language name even next to "sub"', () => {
    expect(parseLanguages('Series Title - S01E01 - Pilot.English.sub')).toEqual(['English']);
  });

  it('reads case-sensitive codes only in upper case', () => {
    expect(parseLanguages('Movie Title 1994 EN 1080p XviD-GROUP')).toContain('English');
    expect(parseLanguages('Movie.Title.2010.En.1080p.WEB.x264-GROUP')).toEqual(['Unknown']);
  });

  it('does not read DTS-ES as Spanish or a site tag as a language', () => {
    expect(parseLanguages('Movie Name (2016) BluRay 1080p DTS-ES AC3 x264-3Li', '3Li')).toEqual(['Unknown']);
    expect(parseLanguages('Movie.Title.2010.720p.BluRay.x264.-[YTS.LT]', 'YTS.LT')).toEqual(['Unknown']);
    expect(parseLanguages('Movie Title 2022 [Remux-1080p 8-bit h264 DTS-HD MA 2.0][ES.EN]-HiFi', 'HiFi')).toEqual(['English', 'Spanish']);
  });

  it('lists Latino before the generic tags so it is the main language', () => {
    expect(parseLanguages('Movie.Title.2019.720p_Eng-Spa(Latino)_MovieClubMx')[0]).toBe('Spanish (Latino)');
  });

  it('distinguishes Catalan tags from the "cat" word', () => {
    expect(parseLanguages('Series S01 [WEB-DL NF 1080p EAC3 2.0 esp cat Subs][HDOlimpo]', 'HDOlimpo')).toEqual(['Spanish', 'Catalan']);
    expect(parseLanguages('Series Title S02 (2021) [WEB-DL 1080p Castellano DD 5.1 - Catalán DD 5.1 Subs]').sort()).toEqual(['Catalan', 'Spanish']);
  });

  it('adds Original (and English) for German DL / ML releases, but not for WEB-DL', () => {
    expect(parseLanguages('Series.Title.S01E01.German.DL.1080p.BluRay.x264-RlsGrp', 'RlsGrp')).toEqual(['German', 'Original']);
    expect(parseLanguages('Series.Title.2023.S01.German.ML.EAC3.1080p.NF.WEB.H264-RlsGrp', 'RlsGrp')).toEqual(['German', 'Original', 'English']);
    expect(parseLanguages('Series.Title.2023.S01E01.GERMAN.1080P.WEB-DL.H264-RlsGrp', 'RlsGrp')).toEqual(['German']);
  });

  it('reads Ukrainian multi-track counts and keeps every distinct language once', () => {
    expect(parseLanguages('Справжня серія (Сезон 1-3) / True Series (Season 1-3) (2014-2019) BDRip-AVC 3xUkr/Eng | Ukr/Eng').sort()).toEqual(['English', 'Ukrainian']);
  });

  it('takes Chinese from a fansub group name when only the tail is passed', () => {
    expect(parseLanguages(' - 01 [HDTV]', 'ABC字幕组')).toEqual(['Chinese']);
  });

  it('only strips the release group when it ends the text', () => {
    expect(parseLanguages('Title.the.Series.2009.S01E14.HDTV.XviD.HUN-LOL', 'LOL')).toEqual(['Hungarian']);
  });
});
