import { describe, expect, it } from 'vitest';
import { parseReleaseGroup } from './group.js';

describe('parseReleaseGroup', () => {
  it('reads the scene suffix', () => {
    expect(parseReleaseGroup('Series.2009.S01E14.English.HDTV.XviD-LOL')).toBe('LOL');
  });

  it('returns null without a separated group', () => {
    expect(parseReleaseGroup('Series 2009 S01E14 English HDTV XviD LOL')).toBeNull();
    expect(parseReleaseGroup('SomeShow.S20E13.1080p.BluRay.DTS-X.MA.5.1.x264')).toBeNull();
    expect(parseReleaseGroup('Some.Movie.2013.1080p.BluRay.REMUX.AVC.DTS-MA.5.1')).toBeNull();
  });

  it('peels repost, indexer and obfuscation suffixes', () => {
    expect(parseReleaseGroup('Who.is.Sonarr.S01E01.INTERNAL.720p.HDTV.x264-aAF-RakuvUS-Obfuscated')).toBe('aAF');
    expect(parseReleaseGroup('Series.S01E06.1080p.AMZN.WEB-DL.JPN.DDP2.0.H.264-ToonsHub.mkv-[N-Z-B]-xpost')).toBe('ToonsHub');
    expect(parseReleaseGroup('Series.Title.S02E04.720p.WEB-DL.AAC2.0.H.264-EVL-RP-RP')).toBe('EVL');
    expect(parseReleaseGroup('Some.Movie.2019.1080p.BDRip.X264.AC3-EVO-1')).toBe('EVO');
  });

  it('keeps an indexer name when it is the only candidate', () => {
    expect(parseReleaseGroup('Movie.Title.2018.720p.HDTV.x264-NZBgeek')).toBe('NZBgeek');
    expect(parseReleaseGroup('Series.Title.S04E04.720p.BluRay.x264-xHD-NZBgeek')).toBe('xHD');
  });

  it('drops a language glued after the group', () => {
    expect(parseReleaseGroup('Series.Title.S02E04.720p.WEBRip.x264-SKGTV_English')).toBe('SKGTV');
  });

  it('reads anime prefixes, including multi-word ones', () => {
    expect(parseReleaseGroup('[Anime-Koi] Series Title 2 - 01 [h264-720p][28D54E2C]')).toBe('Anime-Koi');
    expect(parseReleaseGroup('[Hakata Ramen] Show Title - Season 2 - Revival of The Commandments')).toBe('Hakata Ramen');
    expect(parseReleaseGroup('[GHOST][1080p] Series - 25 [BD HEVC 10bit Dual Audio AC3][AE0ADDBA]')).toBe('GHOST');
  });

  it('reads trailing bracket tags but not descriptions or version tags', () => {
    expect(parseReleaseGroup('Show (2021) Season 1 S01 (1080p BluRay x265 HEVC 10bit AAC 5.1 Tigole) [QxR]')).toBe('QxR');
    expect(parseReleaseGroup('Movie Title (2018) [BluRay] [1080p] [YIFY] [YTS.LT]')).toBe('YTS.LT');
    expect(parseReleaseGroup('Series Title S01 [2160p REMUX] [HEVC DV HYBRID HDR10+ Atmos 7 1 English] [Data Lass]')).toBeNull();
    expect(parseReleaseGroup('Terrible.Anime.Title.001.DBOX.480p.x264-iKaos [v3] [6AFFEF6B]')).toBeNull();
    expect(parseReleaseGroup('Some TV (1979) - S02E10 - Hart-Shaped Murder [HDTV-480p][AAC 2.0][x264]')).toBeNull();
  });

  it('ignores tracker tags and site suffixes', () => {
    expect(parseReleaseGroup('Series S02E09 HDTV x264-2HD [eztv]-[rarbg.com]')).toBe('2HD');
    expect(parseReleaseGroup('SomeShow.S20E13.1080p.Blu-Ray.DTS-ES.5.1.x264-ROUGH [PublicHD]')).toBe('ROUGH');
  });

  it('only takes an encoder tag inside parentheses for known signers', () => {
    expect(parseReleaseGroup('The Show (2020) - S02E03 - Fighting His Series(1080p ATVP WEB-DL x265 t3nzin)')).toBe('t3nzin');
    expect(parseReleaseGroup('The Show (2020) - S02E03 - Fighting His Series(1080p ATVP WEB-DL x265 t3nzinFAKE)')).toBeNull();
    expect(parseReleaseGroup('Movie.Should.Not.Use.Dots.2022.1080p.BluRay.x265.10bit.Tigole')).toBeNull();
  });

  it('reads " - Group)" closing the last parenthesis', () => {
    expect(parseReleaseGroup('Show Name (2022) S01 (2160p DSNP WEB-DL H265 DV HDR DDP Atmos 5.1 English - HONE)')).toBe('HONE');
  });

  it('supports hyphenated, dotted, spaced and non-ASCII group names', () => {
    expect(parseReleaseGroup('SomeShow S01E168 1080p WEB-DL AAC 2.0 x264-Erai-raws')).toBe('Erai-raws');
    expect(parseReleaseGroup('Series.S01E05.1080p.WEB-DL.DDP5.1.H264-BEN.THE.MEN')).toBe('BEN.THE.MEN');
    expect(parseReleaseGroup('Movie Title(2023) 1080p SkySHO WEB-DL ESP DD+ 5.1 H.264-EML HDTeam')).toBe('EML HDTeam');
    expect(parseReleaseGroup('Series S01E01 VOSTFR 1080p WEB x265 EAC3 -Hveðrungr')).toBe('Hveðrungr');
  });

  it('reads anime batch "[Softsubs (Group)]" naming', () => {
    expect(parseReleaseGroup('Crappy Anime Movie Name 2017 [-ZR-] [Blu-ray][MKV][h264][1080p][TrueHD 5.1][Dual Audio][Softsubs (-ZR-)]')).toBe('-ZR-');
  });

  it('accepts long numeric names but not resolutions or episode numbers', () => {
    expect(parseReleaseGroup('Movie Title 2024 2160p WEB-DL DoVi HDR10+ H265 DDP 5.1 Atmos-126811')).toBe('126811');
    expect(parseReleaseGroup('7s-Series-s02e01-720p.mkv')).toBeNull();
    expect(parseReleaseGroup('Series.Title.S01E05.The-Aniversary.WEBDL-1080p.mkv')).toBeNull();
  });
});
