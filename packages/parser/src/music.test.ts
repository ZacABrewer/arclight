import { describe, expect, it } from 'vitest';
import type { AudioCodec, AudioVbrPreset } from '@arclight/shared';
import { audioQualityFor, musicAudioEvaluation, musicReleaseKind, parseAudioPath, parseAudioQuality, parseMusicRelease, parseRelease } from './index.js';

type Facts = { codec: AudioCodec; kbps?: number; vbr?: AudioVbrPreset; depth?: number; hz?: number };
const q = (f: Facts) =>
  audioQualityFor({ codec: f.codec, bitrateKbps: f.kbps ?? null, vbrPreset: f.vbr ?? null, bitDepth: f.depth ?? null, sampleRateHz: f.hz ?? null }).name;

describe('audioQualityFor', () => {
  it.each<[Facts, string]>([
    [{ codec: 'FLAC' }, 'FLAC'],
    [{ codec: 'FLAC', depth: 16, hz: 44100 }, 'FLAC'],
    [{ codec: 'FLAC', depth: 16, hz: 48000 }, 'FLAC'],
    [{ codec: 'FLAC', depth: 24 }, 'FLAC-24bit'],
    [{ codec: 'FLAC', depth: 16, hz: 88200 }, 'FLAC-24bit'],
    [{ codec: 'ALAC' }, 'ALAC'],
    [{ codec: 'ALAC', depth: 24, hz: 48000 }, 'ALAC-24bit'],
    [{ codec: 'ALAC', hz: 96000 }, 'ALAC-24bit'],
    [{ codec: 'MP3', kbps: 320 }, 'MP3-320'],
    [{ codec: 'MP3', kbps: 256 }, 'MP3-256'],
    [{ codec: 'MP3', kbps: 224 }, 'MP3-256'],
    [{ codec: 'MP3', kbps: 192 }, 'MP3-192'],
    [{ codec: 'MP3', kbps: 160 }, 'MP3-192'],
    [{ codec: 'MP3', kbps: 128 }, 'MP3-Low'],
    [{ codec: 'MP3', vbr: 'V0' }, 'MP3-VBR-V0'],
    [{ codec: 'MP3', vbr: 'APX' }, 'MP3-VBR-V0'],
    [{ codec: 'MP3', vbr: 'V2' }, 'MP3-VBR-V2'],
    [{ codec: 'MP3', vbr: 'APS' }, 'MP3-VBR-V2'],
    [{ codec: 'MP3' }, 'Unknown'],
    [{ codec: 'AAC', kbps: 320 }, 'AAC-320'],
    [{ codec: 'AAC', kbps: 256 }, 'AAC-256'],
    [{ codec: 'AAC', kbps: 128 }, 'AAC-Low'],
    [{ codec: 'AAC' }, 'Unknown'],
    [{ codec: 'Vorbis' }, 'Vorbis'],
    [{ codec: 'Opus', kbps: 128 }, 'Opus'],
    [{ codec: 'WAV' }, 'PCM'],
    [{ codec: 'AIFF' }, 'PCM'],
    [{ codec: 'APE' }, 'Lossless-Other'],
    [{ codec: 'WavPack' }, 'Lossless-Other'],
    [{ codec: 'DSD' }, 'DSD'],
    [{ codec: 'Unknown', kbps: 320 }, 'Unknown'],
  ])('%j → %s', (facts, name) => {
    expect(q(facts)).toBe(name);
  });

  it('only ever returns music qualities or Unknown', () => {
    for (const codec of ['FLAC', 'MP3', 'AAC', 'Opus', 'DSD', 'Unknown'] as const) {
      const def = audioQualityFor({ codec, bitrateKbps: 320, vbrPreset: null, bitDepth: null, sampleRateHz: null });
      expect(def.id === 0 || def.mediaTypes.includes('music')).toBe(true);
    }
  });
});

describe('parseAudioQuality', () => {
  it('uses the extension when the name says nothing', () => {
    const r = parseAudioQuality('01 - Opening', 'flac');
    expect(r).toMatchObject({ codec: 'FLAC', detectionSource: 'extension' });
    expect(r.quality.name).toBe('FLAC');
  });

  it('lets the extension override a contradicting name', () => {
    expect(parseAudioQuality('[FLAC]', 'mp3').codec).toBe('MP3');
  });

  it('reads PROPER/REPACK as a revision', () => {
    expect(parseAudioQuality('Artist-Album-PROPER-WEB-FLAC-2020-GRP').revision.version).toBe(2);
  });

  it('does not read years or depth/rate pairs as bitrates', () => {
    expect(parseAudioQuality('[2016 Vinyl 24-96]').codec).toBe('FLAC');
    expect(parseAudioQuality('[2016 Vinyl 24-96]').bitrateKbps).toBeNull();
  });
});

describe('parseMusicRelease', () => {
  it('returns music info and the same audio block at both levels', () => {
    const r = parseMusicRelease('Cobalt Drift - Night Ferry (2021) [WEB FLAC 24-96]');
    expect(r.music?.audio).toBe(r.audio);
    expect(r.releaseTitle).toBe('Cobalt Drift - Night Ferry (2021) [WEB FLAC 24-96]');
  });

  it('leaves parseRelease unchanged for video names', () => {
    expect(parseRelease('Some.Movie.2019.1080p.BluRay.x264-GROUP').movie?.title).toBe('Some Movie');
  });

  it('strips audio extensions and container names', () => {
    expect(parseMusicRelease('Cobalt Drift - Night Ferry (2021) [FLAC].nzb').music?.album).toBe('Night Ferry');
  });
});

describe('parseAudioPath', () => {
  it('falls back to folders for track files', () => {
    const r = parseAudioPath('/music/Cobalt Drift/Night Ferry (2021) [FLAC 24-96]/CD2/04 - Undertow.flac', 'music');
    expect(r.music).toMatchObject({ artist: 'Cobalt Drift', album: 'Night Ferry', year: 2021 });
    expect(r.audio.quality.name).toBe('FLAC-24bit');
  });

  it('parses a bare file name without folders', () => {
    expect(parseAudioPath('Cobalt Drift - Night Ferry (2021) [FLAC].flac').music?.artist).toBe('Cobalt Drift');
  });

  it('keeps the file codec when the folder disagrees', () => {
    expect(parseAudioPath('/dl/Cobalt Drift - Night Ferry [FLAC]/01 - Opening.mp3').audio.codec).toBe('MP3');
  });
});

describe('bridges to the profiles engine', () => {
  it('builds the ReleaseEvaluation audio block', () => {
    const info = parseMusicRelease('Cobalt Drift - Night Ferry (1979) [CD FLAC 24-96] [Log 100%] [Cue]').music!;
    expect(musicAudioEvaluation(info)).toEqual({ codec: 'FLAC', bitDepth: 24, sampleRateHz: 96000, source: 'cd', hasLog: true, logScore: 100, hasCue: true });
    const mp3 = parseMusicRelease('Cobalt Drift - Night Ferry [V0]').music!;
    expect(musicAudioEvaluation(mp3)).toEqual({ codec: 'MP3', vbrPreset: 'V0', hasLog: false, hasCue: false });
  });

  it('maps packs to release kinds', () => {
    expect(musicReleaseKind(parseMusicRelease('Cobalt Drift - Discography (1990-2020) [FLAC]').music!)).toBe('discography');
    expect(musicReleaseKind(parseMusicRelease('Cobalt Drift - 5 Albums [FLAC]').music!)).toBe('multiAlbum');
    expect(musicReleaseKind(parseMusicRelease('Cobalt Drift - Night Ferry [FLAC]').music!)).toBe('single');
  });
});
