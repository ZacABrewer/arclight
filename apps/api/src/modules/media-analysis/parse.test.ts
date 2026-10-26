import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MediaInfo } from '@arclight/shared';
import { decimalChannels, detectDynamicRange, FfprobeParseError, friendlyAudioCodec, needsFrameProbe, parseFfprobeOutput } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

describe('parseFfprobeOutput', () => {
  it('SDR H.264 1080p: video, audio, subtitles, container, duration, bitrate', () => {
    const info = parseFfprobeOutput(fixture('sdr-h264-1080p.json'));
    expect(MediaInfo.parse(info)).toBeTruthy();
    expect(info).toMatchObject({
      container: 'matroska',
      durationMs: 2551104,
      runtimeSeconds: 2551,
      overallBitrate: 5903051,
      videoFormat: 'h264',
      videoCodec: 'AVC',
      videoCodecId: null,
      videoProfile: 'High',
      videoBitDepth: 8,
      videoBitrate: 5672318,
      videoFps: 23.976,
      width: 1920,
      height: 1080,
      resolution: '1920x1080',
      videoDynamicRange: 'SDR',
      videoDynamicRangeType: 'SDR',
      doviProfile: null,
      scanType: 'Progressive',
      audioFormat: 'aac',
      audioCodec: 'AAC',
      audioChannels: 2,
      audioChannelPositions: '2.0',
      audioBitrate: 224000,
      audioStreamCount: 1,
      audioLanguages: ['eng'],
      subtitles: ['eng'],
    });
    expect(info.subtitleStreams).toEqual([{ codec: 'subrip', language: 'eng', forced: false, hearingImpaired: false, default: false, title: null }]);
  });

  it('ignores attached cover art when picking the video stream', () => {
    const info = parseFfprobeOutput(fixture('sdr-h264-1080p.json'));
    expect(info.videoFormat).toBe('h264');
    expect(info.width).toBe(1920);
  });

  it('HDR10 HEVC 2160p: PQ + BT.2020 + mastering metadata, TrueHD Atmos 7.1 primary', () => {
    const info = parseFfprobeOutput(fixture('hdr10-hevc-2160p.json'));
    expect(info).toMatchObject({
      videoCodec: 'HEVC',
      videoProfile: 'Main 10',
      videoBitDepth: 10,
      resolution: '3840x2160',
      videoDynamicRange: 'HDR10',
      colorTransfer: 'smpte2084',
      colorPrimaries: 'bt2020',
      audioCodec: 'TrueHD Atmos',
      audioProfile: 'Dolby TrueHD + Dolby Atmos',
      audioChannels: 7.1,
      audioChannelPositions: '7.1',
      audioStreamCount: 2,
      audioLanguages: ['eng'],
      subtitles: ['eng', 'fre'],
    });
    expect(info.scanType).toBeNull();
  });

  it('HDR10: forced and SDH subtitle flags from disposition and titles', () => {
    const subs = parseFfprobeOutput(fixture('hdr10-hevc-2160p.json')).subtitleStreams!;
    expect(subs.map((s) => [s.language, s.forced, s.hearingImpaired])).toEqual([
      ['eng', true, false],
      ['eng', false, true],
      ['fre', false, false],
    ]);
    expect(subs[0]!.default).toBe(true);
  });

  it('Dolby Vision profile 8.1 with HDR10+ frame metadata -> DV HDR10Plus', () => {
    const info = parseFfprobeOutput(fixture('dv-p8-hdr10plus.json'), fixture('dv-p8-hdr10plus.frames.json'));
    expect(info).toMatchObject({
      container: 'mp4',
      videoDynamicRange: 'DV HDR10Plus',
      doviProfile: 8,
      videoCodecId: 'hvc1',
      videoFps: 24,
      videoBitrate: 15873005,
      audioCodec: 'EAC3 Atmos',
      audioChannels: 5.1,
      audioChannelPositions: '5.1',
    });
  });

  it('Dolby Vision profile 8.1 without frame data -> DV HDR10', () => {
    const info = parseFfprobeOutput(fixture('dv-p8-hdr10plus.json'));
    expect(info.videoDynamicRange).toBe('DV HDR10');
    expect(info.subtitleStreams?.[0]).toMatchObject({ codec: 'mov_text', hearingImpaired: true });
    // `und` is not a language.
    expect(info.audioLanguages).toEqual(['eng']);
  });

  it('Dolby Vision profile 5 (no compatible base layer) -> DV', () => {
    const info = parseFfprobeOutput(fixture('dv-p5.json'));
    expect(info).toMatchObject({ videoDynamicRange: 'DV', doviProfile: 5, videoCodecId: 'dvh1', audioCodec: 'EAC3' });
  });

  it('multi-audio: default track is primary, every track and language listed', () => {
    const info = parseFfprobeOutput(fixture('multi-audio-anime.json'));
    expect(info.audioCodec).toBe('FLAC');
    expect(info.audioLanguages).toEqual(['jpn', 'eng', 'ger']);
    expect(info.audioStreamCount).toBe(3);
    expect(info.audioStreams!.map((a) => [a.codec, a.channels, a.language, a.bitrate])).toEqual([
      ['flac', 2, 'jpn', 912345],
      ['dts', 6, 'eng', 3012000],
      ['aac', 2, 'ger', 192000],
    ]);
    expect(friendlyAudioCodec(info.audioStreams![1]!.codec, info.audioStreams![1]!.profile)).toBe('DTS-HD MA');
  });

  it('multi-audio: `-eng` suffixed Matroska tags, forced-by-title subtitles, untagged languages skipped', () => {
    const info = parseFfprobeOutput(fixture('multi-audio-anime.json'));
    expect(info.videoBitrate).toBe(3400211);
    expect(info.videoBitDepth).toBe(10);
    expect(info.subtitles).toEqual(['eng']);
    expect(info.subtitleStreams!.map((s) => s.forced)).toEqual([false, true, false]);
    expect(info.subtitleStreams![2]!.language).toBeNull();
  });

  it('HLG transport stream: HLG range, first audio primary without a default flag', () => {
    const info = parseFfprobeOutput(fixture('hlg-ts.json'));
    expect(info).toMatchObject({ container: 'mpegts', videoDynamicRange: 'HLG', audioCodec: 'HE-AAC', videoFps: 50, videoCodecId: 'hevc' });
    expect(info.subtitleStreams![0]!.hearingImpaired).toBe(true);
  });

  it('SD MPEG-2: interlaced scan type, MPEG2 codec, bibliographic language code kept', () => {
    const info = parseFfprobeOutput(fixture('sd-mpeg2-interlaced.json'));
    expect(info).toMatchObject({ videoCodec: 'MPEG2', scanType: 'Interlaced', resolution: '720x576', audioCodec: 'AC3', audioLanguages: ['dut'], videoBitDepth: 8 });
  });

  it('falls back to the stream DURATION tag when the format has no duration', () => {
    const data = JSON.parse(fixture('multi-audio-anime.json'));
    delete data.format.duration;
    const info = parseFfprobeOutput(data);
    expect(info.runtimeSeconds).toBe(1420);
    expect(info.durationMs).toBe(1420044);
  });

  it('rejects output that is not ffprobe JSON', () => {
    expect(() => parseFfprobeOutput('not json')).toThrow(FfprobeParseError);
    expect(() => parseFfprobeOutput('{}')).toThrow(FfprobeParseError);
  });

  it('audio-only files have no video fields', () => {
    const info = parseFfprobeOutput({ streams: [{ codec_type: 'audio', codec_name: 'mp3', channels: 2 }], format: { format_name: 'mp3', duration: '200.5' } });
    expect(info.videoCodec).toBeUndefined();
    expect(info).toMatchObject({ audioCodec: 'MP3', runtimeSeconds: 201, container: 'mp3' });
  });
});

describe('dynamic range and helpers', () => {
  it('PQ without BT.2020 or mastering metadata is PQ; plain PQ + HDR10+ is HDR10Plus', () => {
    expect(detectDynamicRange({ color_transfer: 'smpte2084' }).type).toBe('PQ');
    expect(detectDynamicRange({ color_transfer: 'smpte2084', color_primaries: 'bt2020' }, [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }]).type).toBe('HDR10Plus');
  });

  it('DV compatibility ids map to the base layer', () => {
    const dv = (compat: number, transfer?: string) =>
      detectDynamicRange({ ...(transfer ? { color_transfer: transfer } : {}), side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 8, dv_bl_signal_compatibility_id: compat }] }).type;
    expect(dv(1)).toBe('DV HDR10');
    expect(dv(2)).toBe('DV SDR');
    expect(dv(4)).toBe('DV HLG');
    expect(dv(6)).toBe('DV HDR10');
    expect(dv(9, 'arib-std-b67')).toBe('DV HLG');
  });

  it('needsFrameProbe only for PQ content', () => {
    expect(needsFrameProbe(fixture('hdr10-hevc-2160p.json'))).toBe(true);
    expect(needsFrameProbe(fixture('sdr-h264-1080p.json'))).toBe(false);
  });

  it('decimal channel counts', () => {
    expect(decimalChannels(6)).toBe(5.1);
    expect(decimalChannels(8)).toBe(7.1);
    expect(decimalChannels(2)).toBe(2);
    expect(decimalChannels(3, '2.1')).toBe(2.1);
    expect(decimalChannels(null)).toBeNull();
  });
});
