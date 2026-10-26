import { describe, expect, it } from 'vitest';
import { parseQuality, parseRevision } from './quality.js';

const name = (title: string, ext: string | null = null) => parseQuality(title, ext).quality.name;

describe('parseQuality', () => {
  it('uses the right-most source token', () => {
    expect(name('Series.S01E07.720p.WEB-DL.REPACK.BluRay.x264-GRP')).toBe('Bluray-720p');
  });

  it('only trusts a bare WEB tag when its context marks it as the source', () => {
    expect(name('Series.Title.2016.03.14.1080p.WEB.h264-spamTV')).toBe('WEBDL-1080p');
    expect(name('Series.Title.S02E02.1080p.AMZN.WEB.')).toBe('WEBDL-1080p');
    expect(name('Series.Title.S01E01.The.Web.MT-dd')).toBe('Unknown');
  });

  it('keeps WEBRip distinct from WEB-DL even behind a streaming-service tag', () => {
    expect(name('Series.Title.S01.1080p.AMZN.WEB-Rip.DDP5.1.H.264-Telly')).toBe('WEBRip-1080p');
  });

  it('treats an HDTV MPEG-2 capture as Raw-HD regardless of resolution', () => {
    expect(name('How I Met Your Developer S01E18 720p HDTV DD5.1 MPEG2-TrollHD')).toBe('Raw-HD');
  });

  it('maps PDTV with the HR.WS marker to 720p', () => {
    expect(name('The.Series.US.S12E17.HR.WS.PDTV.X264-DIMENSION')).toBe('HDTV-720p');
  });

  it('has no 720p remux: it falls back to Bluray-720p', () => {
    expect(name('Series.Hunter.S02.720p.Blu-ray.Remux.AVC.FLAC.2.0-SiCFoI')).toBe('Bluray-720p');
    expect(name('Movie.Name.2011.2160p.DD.2.0.AVC.REMUX-FraMeSToR')).toBe('Remux-2160p');
  });

  it('recognises full Blu-ray discs but not encodes of them', () => {
    expect(name('Movie Title 2014 1080p Blu-ray AVC DTS-HD MA 5.1-PTP')).toBe('BR-DISK');
    expect(name('Movie.Title.1996.Bluray', 'iso')).toBe('BR-DISK');
    expect(name('Sonarr.Of.Series.S02E13.1080p.BluRay.x264-AVCDVD')).toBe('Bluray-1080p');
  });

  it('reads German "ML/DL ... BluRay.AVC" untouched streams as remux', () => {
    expect(name('This.Wonderful.Movie.1991.German.ML.1080p.BluRay.AVC-GeRMaNSCeNEGRoUP')).toBe('Remux-1080p');
  });

  it('prefers an explicit resolution over UHD and treats bare UHD as 2160p', () => {
    expect(name('Series.Title.2011.1080p.UHD.BluRay.DD5.1.HDR.x265-CtrlHD')).toBe('Bluray-1080p');
    expect(name('Series.Title.US.s05e13.UHD.4K.Bluray')).toBe('Bluray-2160p');
  });

  it('distinguishes DVD-R from DVD and does not let PAL/NTSC override it', () => {
    expect(name('Some.Movie.Magic.Rainbow.2007.DVD5.NTSC')).toBe('DVD-R');
    expect(name('The.Series.S01E13.NTSC.x264-CtrlSD')).toBe('DVD');
  });

  it('keeps the capture resolution of a telesync', () => {
    const q = parseQuality('Movie.Title.3.2017.720p.TSRip.x264.AAC-Ozlem').quality;
    expect(q.name).toBe('TELESYNC');
    expect(q.resolution).toBe(720);
  });

  it('reports where the source came from', () => {
    expect(parseQuality('Series.Title.S01E02.Chained.Heat.1080p', 'mkv')).toMatchObject({ detectionSource: 'extension' });
    expect(parseQuality('Series.Title.S01E01.1920x1080').detectionSource).toBe('unknown');
    expect(parseQuality('Series.Title.S01E01.Bluray720p').detectionSource).toBe('name');
    expect(parseQuality('Series.Title.S01E01.webm').quality.name).toBe('Unknown');
  });

  it('applies anime bracket conventions when there is no source word', () => {
    expect(name('[HorribleSubs] Series Title! S01 [Web][MKV][h264][AAC 2.0]')).toBe('WEBDL-720p');
    expect(name('[coldhell] Series v2 [BD1080p][5A45EABE]')).toBe('Bluray-1080p');
  });
});

describe('parseRevision', () => {
  it('counts REAL case-sensitively', () => {
    expect(parseRevision('Series.S04E05.REAL.REAL.PROPER.HDTV.x264-W4F').real).toBe(2);
    expect(parseRevision('Series.S21E07.Super.Duper.Real.Proper.HDTV.x264-FTP').real).toBe(0);
  });

  it('numbers repacks and anime versions', () => {
    expect(parseRevision('Series.S04E87.REPACK2.720p.HDTV.x264-aAF')).toEqual({ version: 3, real: 0, isRepack: true });
    expect(parseRevision('Series.S04E87.PROPER.720p.HDTV.x264-aAF')).toEqual({ version: 2, real: 0, isRepack: false });
    expect(parseRevision('[SubsPlease] Anime Title - 01v2 (1080p) [B1F227CF]').version).toBe(2);
    expect(parseRevision('[coldhell] Series v3 [BD720p][03192D4C]').version).toBe(1);
  });
});
