import { describe, expect, it } from 'vitest';
import { TranscodeOptions, type MediaInfo, type TranscodeAction, type TranscodeOptionsInput } from '@arclight/shared';
import { buildFfmpegArgs, formatCommand, planStreams, presetArgs, qualityArgs, TranscodeBuildError, VAAPI_DEVICE, videoEncoder } from './ffmpeg.js';
import { H264_INFO, HEVC_INFO } from './test-support.js';

const build = (action: TranscodeAction, raw: TranscodeOptionsInput = {}, info: MediaInfo | null = H264_INFO) =>
  buildFfmpegArgs('/in/a.mkv', '/in/.a.arclight-transcode.mkv', { action, options: TranscodeOptions.parse(raw) }, info);

/** Value following a flag (first occurrence). */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const maps = (args: string[]) => args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));

describe('buildFfmpegArgs', () => {
  it('remux to mkv: exact argv with progress on stdout', () => {
    expect(build('remux', {}, null)).toEqual([
      '-hide_banner', '-nostdin', '-y',
      '-i', '/in/a.mkv',
      '-map', '0:v:0', '-map', '0:a?', '-map', '0:s?', '-map', '0:t?',
      '-map_metadata', '0', '-map_chapters', '0',
      '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'copy', '-c:t', 'copy',
      '-f', 'matroska',
      '-max_muxing_queue_size', '1024', '-progress', 'pipe:1', '-nostats',
      '/in/.a.arclight-transcode.mkv',
    ]);
  });

  it('remux to mp4: faststart, hvc1 tag, text subtitles as mov_text, image subtitles dropped', () => {
    const args = build('remux', { container: 'mp4' }, HEVC_INFO);
    expect(args).toContain('+faststart');
    expect(after(args, '-f')).toBe('mp4');
    expect(after(args, '-tag:v')).toBe('hvc1');
    expect(maps(args)).toEqual(['0:v:0', '0:a?', '0:s:0']);
    expect(after(args, '-c:s')).toBe('mov_text');
    expect(args).not.toContain('0:t?');
  });

  it('mp4 without media info drops subtitles (cannot tell text from image)', () => {
    const args = build('remux', { container: 'mp4' }, null);
    expect(args).toContain('-sn');
    expect(maps(args)).toEqual(['0:v:0', '0:a?']);
  });

  const encoders: Array<[string, 'none' | 'vaapi' | 'qsv' | 'nvenc' | 'videotoolbox', 'h264' | 'hevc' | 'av1', string, string[], string[], string[]]> = [
    // label, hwaccel, codec, encoder, input flags, quality (crf 22), preset (slow)
    ['x264', 'none', 'h264', 'libx264', [], ['-crf', '22'], ['-preset', 'slow']],
    ['x265', 'none', 'hevc', 'libx265', [], ['-crf', '22'], ['-preset', 'slow']],
    ['svt-av1', 'none', 'av1', 'libsvtav1', [], ['-crf', '22'], ['-preset', '4']],
    ['vaapi h264', 'vaapi', 'h264', 'h264_vaapi', ['-vaapi_device', VAAPI_DEVICE], ['-qp', '22'], []],
    ['vaapi hevc', 'vaapi', 'hevc', 'hevc_vaapi', ['-vaapi_device', VAAPI_DEVICE], ['-qp', '22'], []],
    ['vaapi av1', 'vaapi', 'av1', 'av1_vaapi', ['-vaapi_device', VAAPI_DEVICE], ['-qp', '22'], []],
    ['qsv h264', 'qsv', 'h264', 'h264_qsv', ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], ['-global_quality', '22'], ['-preset', 'slow']],
    ['qsv hevc', 'qsv', 'hevc', 'hevc_qsv', ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], ['-global_quality', '22'], ['-preset', 'slow']],
    ['qsv av1', 'qsv', 'av1', 'av1_qsv', ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], ['-global_quality', '22'], ['-preset', 'slow']],
    ['nvenc h264', 'nvenc', 'h264', 'h264_nvenc', ['-hwaccel', 'cuda'], ['-rc', 'vbr', '-cq', '22', '-b:v', '0'], ['-preset', 'p5']],
    ['nvenc hevc', 'nvenc', 'hevc', 'hevc_nvenc', ['-hwaccel', 'cuda'], ['-rc', 'vbr', '-cq', '22', '-b:v', '0'], ['-preset', 'p5']],
    ['nvenc av1', 'nvenc', 'av1', 'av1_nvenc', ['-hwaccel', 'cuda'], ['-rc', 'vbr', '-cq', '22', '-b:v', '0'], ['-preset', 'p5']],
    ['videotoolbox h264', 'videotoolbox', 'h264', 'h264_videotoolbox', ['-hwaccel', 'videotoolbox'], ['-q:v', '56'], []],
    ['videotoolbox hevc', 'videotoolbox', 'hevc', 'hevc_videotoolbox', ['-hwaccel', 'videotoolbox'], ['-q:v', '56'], []],
  ];

  it.each(encoders)('transcode %s: encoder, input flags, quality and preset', (_label, hwaccel, codec, encoder, input, quality, preset) => {
    const args = build('transcode', { videoCodec: codec, hwaccel, crf: 22, preset: 'slow' });
    expect(after(args, '-c:v')).toBe(encoder);
    const iIdx = args.indexOf('-i');
    expect(args.slice(3, iIdx)).toEqual(input);
    const tail = args.slice(args.indexOf('-c:v'));
    if (quality.length) expect(tail.join(' ')).toContain(quality.join(' '));
    if (preset.length) expect(tail.join(' ')).toContain(preset.join(' '));
    else expect(tail).not.toContain('-preset');
    if (hwaccel === 'vaapi') expect(after(args, '-vf')).toBe('format=nv12,hwupload');
    if (hwaccel === 'qsv') expect(after(args, '-vf')).toBe('format=nv12,hwupload=extra_hw_frames=64,format=qsv');
  });

  it('VideoToolbox has no AV1 encoder', () => {
    expect(() => build('transcode', { videoCodec: 'av1', hwaccel: 'videotoolbox' })).toThrow(TranscodeBuildError);
    expect(() => videoEncoder('av1', 'videotoolbox')).toThrow(/no av1 encoder/);
  });

  it('10-bit sources: h264 forces yuv420p, VAAPI HEVC uploads p010', () => {
    expect(after(build('transcode', { videoCodec: 'h264' }, HEVC_INFO), '-pix_fmt')).toBe('yuv420p');
    expect(after(build('transcode', { videoCodec: 'hevc', hwaccel: 'vaapi' }, HEVC_INFO), '-vf')).toBe('format=p010,hwupload');
    expect(build('transcode', { videoCodec: 'hevc' }, HEVC_INFO)).not.toContain('-pix_fmt');
  });

  it('hardware input flags only when video is encoded', () => {
    const args = build('transcode', { videoCodec: 'copy', audio: 'aac', hwaccel: 'nvenc' });
    expect(args).not.toContain('-hwaccel');
    expect(after(args, '-c:v')).toBe('copy');
  });

  it.each([
    ['aac', 2, '128k'],
    ['aac', 6, '384k'],
    ['eac3', 2, '224k'],
    ['eac3', 6, '640k'],
  ] as const)('audio %s %i ch -> bitrate %s', (codec, channels, bitrate) => {
    const args = build('transcode', { audio: codec, channels });
    expect(after(args, '-c:a')).toBe(codec);
    expect(after(args, '-ac')).toBe(String(channels));
    expect(after(args, '-b:a')).toBe(bitrate);
  });

  it('audio codec without channels leaves the layout alone; remux ignores codec options', () => {
    const args = build('transcode', { audio: 'aac' });
    expect(after(args, '-c:a')).toBe('aac');
    expect(args).not.toContain('-ac');
    const remux = build('remux', { audio: 'aac', videoCodec: 'hevc' });
    expect(after(remux, '-c:a')).toBe('copy');
    expect(after(remux, '-c:v')).toBe('copy');
  });

  it('keepLanguages maps matching tracks (2- or 3-letter), keeps untagged ones', () => {
    const info: MediaInfo = {
      ...HEVC_INFO,
      audioStreams: [
        { codec: 'truehd', language: 'eng' },
        { codec: 'ac3', language: 'ger' },
        { codec: 'aac', language: null },
        { codec: 'ac3', language: 'fre' },
      ],
      subtitleStreams: [
        { codec: 'subrip', language: 'fre', forced: false, hearingImpaired: false },
        { codec: 'subrip', language: 'en', forced: false, hearingImpaired: false },
      ],
    };
    const args = build('stripTracks', { keepLanguages: ['en', 'deu'] }, info);
    expect(maps(args)).toEqual(['0:v:0', '0:a:0', '0:a:1', '0:a:2', '0:s:1', '0:t?']);
  });

  it('keepLanguages never strips every audio track', () => {
    const args = build('stripTracks', { keepLanguages: ['jpn'] }, H264_INFO);
    expect(maps(args)).toContain('0:a?');
  });

  it('dropSubtitles maps no subtitle streams and adds -sn', () => {
    const args = build('stripTracks', { dropSubtitles: true }, HEVC_INFO);
    expect(maps(args).some((m) => m?.startsWith('0:s'))).toBe(false);
    expect(args).toContain('-sn');
    expect(args).not.toContain('-c:s');
  });

  it('addAudioTrack keeps the originals and adds AAC stereo from the first kept track', () => {
    const args = build('addAudioTrack', {}, HEVC_INFO);
    expect(maps(args)).toEqual(['0:v:0', '0:a?', '0:a:0', '0:s?', '0:t?']);
    expect(after(args, '-c:a')).toBe('copy');
    expect(after(args, '-c:a:2')).toBe('aac');
    expect(after(args, '-ac:a:2')).toBe('2');
    expect(after(args, '-b:a:2')).toBe('128k');
    expect(after(args, '-metadata:s:a:2')).toBe('title=Stereo (AAC)');
    expect(after(args, '-c:v')).toBe('copy');
  });

  it('addAudioTrack honours keepLanguages, audio codec and channels', () => {
    const args = build('addAudioTrack', { keepLanguages: ['ger'], audio: 'eac3', channels: 6 }, HEVC_INFO);
    expect(maps(args)).toEqual(['0:v:0', '0:a:1', '0:a:1', '0:t?']);
    expect(after(args, '-c:a:1')).toBe('eac3');
    expect(after(args, '-ac:a:1')).toBe('6');
    expect(after(args, '-b:a:1')).toBe('640k');
  });

  it('addAudioTrack needs media info with audio', () => {
    expect(() => build('addAudioTrack', {}, null)).toThrow(/media info/);
    expect(() => build('addAudioTrack', {}, { ...H264_INFO, audioStreams: [], audioStreamCount: 0 })).toThrow(/no audio/);
  });

  it('every combination ends with progress on stdout and the output path', () => {
    for (const action of ['remux', 'transcode', 'stripTracks', 'addAudioTrack'] as const) {
      for (const container of ['mkv', 'mp4'] as const) {
        for (const hwaccel of ['none', 'vaapi', 'qsv', 'nvenc'] as const) {
          const args = build(action, { container, hwaccel, videoCodec: 'hevc', audio: 'aac', dropSubtitles: container === 'mp4' }, HEVC_INFO);
          expect(args.slice(-3)).toEqual(['pipe:1', '-nostats', '/in/.a.arclight-transcode.mkv']);
          expect(after(args, '-progress')).toBe('pipe:1');
          expect(after(args, '-f')).toBe(container === 'mp4' ? 'mp4' : 'matroska');
          expect(args.includes('-movflags')).toBe(container === 'mp4');
        }
      }
    }
  });
});

describe('quality/preset mapping', () => {
  it('maps presets per encoder', () => {
    expect(presetArgs('libsvtav1', 'medium')).toEqual(['-preset', '6']);
    expect(presetArgs('libsvtav1', '10')).toEqual(['-preset', '10']);
    expect(presetArgs('hevc_nvenc', 'p7')).toEqual(['-preset', 'p7']);
    expect(presetArgs('hevc_nvenc', 'ultrafast')).toEqual(['-preset', 'p1']);
    expect(presetArgs('hevc_qsv', 'ultrafast')).toEqual(['-preset', 'veryfast']);
    expect(presetArgs('hevc_vaapi', 'slow')).toEqual([]);
    expect(presetArgs('libx264', undefined)).toEqual([]);
  });

  it('maps crf per encoder (VideoToolbox clamps)', () => {
    expect(qualityArgs('libx265', 18)).toEqual(['-crf', '18']);
    expect(qualityArgs('h264_videotoolbox', 0)).toEqual(['-q:v', '100']);
    expect(qualityArgs('h264_videotoolbox', 60)).toEqual(['-q:v', '1']);
    expect(qualityArgs('h264_qsv', undefined)).toEqual([]);
  });
});

describe('planStreams / formatCommand', () => {
  it('mkv without filters keeps everything', () => {
    expect(planStreams(TranscodeOptions.parse({}), 'mkv', HEVC_INFO)).toEqual({ audio: 'all', subtitles: 'all' });
  });

  it('quotes arguments for display', () => {
    expect(formatCommand('/usr/bin/ffmpeg', ['-i', '/m/My Film (2020).mkv', '-metadata:s:a:1', 'title=Stereo (AAC)'])).toBe(
      '/usr/bin/ffmpeg -i "/m/My Film (2020).mkv" -metadata:s:a:1 "title=Stereo (AAC)"',
    );
  });
});
