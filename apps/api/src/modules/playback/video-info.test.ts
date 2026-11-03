import { describe, expect, it } from 'vitest';
import { VideoDeviceProfile, type MediaInfo, type VideoInfo, type VideoSubtitleTrack } from '@arclight/shared';
import { sizedImageUrl, subtitleLabel } from './video-routes.js';
import {
  baseRangeOf,
  buildSubtitleArgs,
  buildThumbnailArgs,
  buildVideoStreamArgs,
  compareVersions,
  decideVideo,
  dynamicRangeOf,
  effectiveCap,
  parseProbeChapters,
  segmentsFromChapters,
  versionDescription,
  versionLabel,
  videoContainerOf,
  videoInfoOf,
  type VideoDecisionInput,
} from './video-info.js';

// The pure half of Movies & TV: media info -> VideoInfo, the direct/remux/transcode decision with
// its reason codes, chapter-based segments and the ffmpeg argv. No files, no ffmpeg.

const H264_AAC: MediaInfo = {
  container: 'mp4',
  videoFormat: 'h264',
  videoBitDepth: 8,
  width: 1920,
  height: 1080,
  videoFps: 23.976,
  videoDynamicRangeType: 'SDR',
  overallBitrate: 6_000_000,
  durationMs: 600_000,
  audioStreams: [{ codec: 'aac', channels: 2, language: 'eng', title: null, default: true }],
  subtitleStreams: [],
} as MediaInfo;

const HEVC10_AC3: MediaInfo = {
  container: 'matroska',
  videoFormat: 'hevc',
  videoBitDepth: 10,
  width: 3840,
  height: 2160,
  videoFps: 24,
  videoDynamicRangeType: 'HDR10',
  overallBitrate: 40_000_000,
  durationMs: 600_000,
  audioStreams: [
    { codec: 'ac3', channels: 6, language: 'eng', title: 'Surround', default: true },
    { codec: 'aac', channels: 2, language: 'ger', title: null, default: false },
  ],
  subtitleStreams: [
    { codec: 'subrip', language: 'eng', forced: false, hearingImpaired: false, default: false, title: null },
    { codec: 'hdmv_pgs_subtitle', language: 'eng', forced: true, hearingImpaired: false, default: false, title: null },
  ],
} as MediaInfo;

const info = (mediaInfo: MediaInfo, path = '/m/file.mkv', id = 1): VideoInfo => videoInfoOf({ id, path, sizeBytes: 1_000_000, versionTag: null, mediaInfo });

const BROWSER = VideoDeviceProfile.parse({ containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9', 'av1'], audioCodecs: ['aac', 'mp3', 'opus', 'flac'], maxAudioChannels: 2, maxHeight: 2160 });
const TV = VideoDeviceProfile.parse({ containers: ['mp4', 'mkv'], videoCodecs: ['h264', 'hevc'], hevc10bit: true, hdr: ['hdr10', 'hlg'], audioCodecs: ['aac', 'ac3', 'eac3'], maxAudioChannels: 6, maxHeight: 2160 });

function decide(i: VideoInfo, profile = BROWSER, over: Partial<VideoDecisionInput> = {}) {
  return decideVideo({ info: i, baseRange: null, profile, audioTrack: 0, subtitle: null, quality: 'auto', userCapKbps: 0, ...over });
}

describe('video info', () => {
  it('reads container, codec, range and tracks from media info', () => {
    const v = info(HEVC10_AC3);
    expect(v).toMatchObject({ container: 'mkv', videoCodec: 'hevc', bitDepth: 10, dynamicRange: 'hdr10', bitrateKbps: 40_000 });
    expect(v.audioTracks.map((a) => [a.index, a.codec, a.channels, a.default])).toEqual([
      [0, 'ac3', 6, true],
      [1, 'aac', 2, false],
    ]);
    expect(v.subtitleTracks.map((s) => [s.id, s.text, s.forced])).toEqual([
      ['e0', true, false],
      ['e1', false, true],
    ]);
    expect(videoContainerOf('/x/file.unknown', 'matroska')).toBe('mkv');
  });

  it('maps dynamic range strings, with DV base layers', () => {
    expect(dynamicRangeOf({ videoDynamicRangeType: 'DV HDR10' } as MediaInfo)).toBe('dv');
    expect(baseRangeOf({ videoDynamicRangeType: 'DV HDR10' } as MediaInfo)).toBe('hdr10');
    expect(baseRangeOf({ videoDynamicRangeType: 'DV' } as MediaInfo)).toBeNull();
    expect(dynamicRangeOf({ videoDynamicRangeType: 'HDR10Plus' } as MediaInfo)).toBe('hdr10plus');
    expect(dynamicRangeOf({ videoDynamicRangeType: 'PQ' } as MediaInfo)).toBe('hdr10');
    expect(dynamicRangeOf({ videoDynamicRangeType: 'HLG' } as MediaInfo)).toBe('hlg');
    expect(dynamicRangeOf(null)).toBe('sdr');
  });

  it('labels and orders versions best first', () => {
    const uhd = info(HEVC10_AC3, '/m/a.mkv', 1);
    const hd = info(H264_AAC, '/m/b.mp4', 2);
    expect(versionLabel(uhd, { versionTag: '4K', edition: null })).toBe('4K HDR');
    expect(versionLabel(hd, { versionTag: null, edition: "Director's Cut" })).toBe("1080p · Director's Cut");
    expect([hd, uhd].sort(compareVersions).map((v) => v.mediaFileId)).toEqual([1, 2]);
    expect(versionDescription(uhd)).toBe('HEVC 10-bit · AC3 5.1 · 2160p');
  });

  it('labels subtitles by language and flags', () => {
    const t = (over: Partial<VideoSubtitleTrack>): VideoSubtitleTrack => ({ id: 'e0', source: 'embedded', codec: 'subrip', language: 'eng', title: null, forced: false, hearingImpaired: false, default: false, text: true, ...over });
    expect(subtitleLabel(t({}), 0)).toBe('English');
    expect(subtitleLabel(t({ language: 'ger', forced: true }), 0)).toBe('German (Forced)');
    expect(subtitleLabel(t({ hearingImpaired: true }), 0)).toBe('English (SDH)');
    expect(subtitleLabel(t({ language: null, title: null }), 2)).toBe('Track 3');
  });

  it('sizes TMDB image URLs and leaves others alone', () => {
    expect(sizedImageUrl('https://image.tmdb.org/t/p/original/abc.jpg', 'poster', '342')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(sizedImageUrl('https://image.tmdb.org/t/p/w500/abc.jpg', 'fanart', '1280')).toBe('https://image.tmdb.org/t/p/w1280/abc.jpg');
    expect(sizedImageUrl('https://example.com/x.jpg', 'poster', '342')).toBe('https://example.com/x.jpg');
    expect(sizedImageUrl('https://image.tmdb.org/t/p/original/abc.jpg', 'poster', undefined)).toBe('https://image.tmdb.org/t/p/original/abc.jpg');
  });
});

describe('the playback decision', () => {
  it('direct plays an H.264/AAC MP4 in a browser', () => {
    expect(decide(info(H264_AAC, '/m/a.mp4'))).toMatchObject({ method: 'direct', reasons: [] });
  });

  it('remuxes when only the container or the audio is wrong', () => {
    const mkv = info(H264_AAC, '/m/a.mkv');
    expect(decide(mkv)).toMatchObject({ method: 'remux', reasons: ['container'], copyAudio: true });
    const ac3 = info({ ...H264_AAC, audioStreams: [{ codec: 'ac3', channels: 6, language: 'eng', title: null, default: true }] } as MediaInfo, '/m/a.mp4');
    expect(decide(ac3)).toMatchObject({ method: 'remux', reasons: ['audio-codec'], copyAudio: false, audioChannels: 2 });
    const six = info({ ...H264_AAC, audioStreams: [{ codec: 'aac', channels: 6, language: 'eng', title: null, default: true }] } as MediaInfo, '/m/a.mp4');
    expect(decide(six)).toMatchObject({ method: 'remux', reasons: ['audio-channels'], copyAudio: false });
  });

  it('transcodes 10-bit HEVC HDR for a browser, tone-mapped, with every reason in order', () => {
    const plan = decide(info(HEVC10_AC3));
    expect(plan.method).toBe('transcode');
    expect(plan.reasons).toEqual(['container', 'video-codec', 'audio-codec', 'hdr']);
    expect(plan).toMatchObject({ tonemap: true, videoCodec: 'h264', height: 2160, copyAudio: false, audioChannels: 2 });
  });

  it('direct plays the same file on an HDR TV, and picks the second audio track without changing the method', () => {
    expect(decide(info(HEVC10_AC3), TV)).toMatchObject({ method: 'direct' });
    expect(decide(info(HEVC10_AC3), TV, { audioTrack: 1 })).toMatchObject({ method: 'direct' });
  });

  it('honours 10-bit support, DV base layers, quality, bitrate caps and burned subtitles', () => {
    const noMain10 = VideoDeviceProfile.parse({ ...TV, hevc10bit: false });
    expect(decide(info(HEVC10_AC3), noMain10).reasons).toContain('video-profile');
    const dv = info({ ...HEVC10_AC3, videoDynamicRangeType: 'DV HDR10' } as MediaInfo);
    expect(decide(dv, TV, { baseRange: 'hdr10' }).method).toBe('direct');
    expect(decide(dv, TV, { baseRange: null }).reasons).toEqual(['hdr']);
    const q = decide(info(HEVC10_AC3), TV, { quality: '1080p' });
    expect(q).toMatchObject({ method: 'transcode', reasons: ['quality'], height: 1080, videoCodec: 'h264' });
    const capped = decide(info(HEVC10_AC3), TV, { userCapKbps: 8000 });
    expect(capped.reasons).toEqual(['bitrate']);
    expect(capped.videoKbps).toBeLessThanOrEqual(8000 - 384);
    const pgs = info(HEVC10_AC3).subtitleTracks[1]!;
    expect(decide(info(HEVC10_AC3), TV, { subtitle: pgs })).toMatchObject({ method: 'transcode', reasons: ['burn-subtitle'], burn: 'e1' });
    const srt = info(HEVC10_AC3).subtitleTracks[0]!;
    expect(decide(info(HEVC10_AC3), TV, { subtitle: srt }).method).toBe('direct');
    expect(effectiveCap({ maxBitrateKbps: 5000 }, 3000)).toBe(3000);
    expect(effectiveCap({}, 0)).toBe(0);
  });

  it('uses HEVC output only above 1080p on devices that decode it', () => {
    const tooBig = VideoDeviceProfile.parse({ ...TV, hdr: [] });
    expect(decide(info(HEVC10_AC3), tooBig)).toMatchObject({ method: 'transcode', videoCodec: 'hevc', reasons: ['hdr'] });
  });

  it('re-encodes a codec that cannot go into MP4 even when only the container is wrong', () => {
    const mpeg2 = info({ ...H264_AAC, videoFormat: 'mpeg2video' } as MediaInfo, '/m/a.ts');
    const anything = VideoDeviceProfile.parse({ ...BROWSER, videoCodecs: ['h264', 'mpeg2video'] });
    expect(decide(mpeg2, anything)).toMatchObject({ method: 'transcode', reasons: ['container', 'video-codec'] });
  });
});

describe('chapters and segments', () => {
  const probe = JSON.stringify({
    chapters: [
      { start_time: '0.000', end_time: '60.000', tags: { title: 'Previously on' } },
      { start_time: '60.000', end_time: '90.000', tags: { title: 'Opening Credits' } },
      { start_time: '90.000', end_time: '1500.000', tags: { title: 'Act One' } },
      { start_time: '1500.000', end_time: '1560.000', tags: { title: 'End Credits' } },
      { start_time: '1560.000', end_time: '1600.000', tags: { title: 'Credits (cont.)' } },
    ],
  });

  it('parses ffprobe chapters and finds recap, intro and credits', () => {
    const chapters = parseProbeChapters(probe, 1_600_000);
    expect(chapters).toHaveLength(5);
    expect(chapters[2]).toEqual({ title: 'Act One', startMs: 90_000, durationMs: 1_410_000 });
    expect(segmentsFromChapters(chapters)).toEqual([
      { type: 'recap', startMs: 0, endMs: 60_000 },
      { type: 'intro', startMs: 60_000, endMs: 90_000 },
      { type: 'credits', startMs: 1_500_000, endMs: 1_600_000 },
    ]);
  });

  it('survives garbage and untitled chapters', () => {
    expect(parseProbeChapters('not json', 0)).toEqual([]);
    const untitled = parseProbeChapters(JSON.stringify({ chapters: [{ start_time: 0 }, { start_time: 10 }] }), 20_000);
    expect(untitled.map((c) => [c.title, c.durationMs])).toEqual([
      ['Chapter 1', 10_000],
      ['Chapter 2', 10_000],
    ]);
  });
});

describe('ffmpeg argv', () => {
  const base = { audioTrack: 1, audioCodec: 'aac', audioChannelsIn: 2, copyAudio: true, audioChannels: 2, startMs: 0 } as const;

  it('remuxes into fragmented MP4 with the chosen audio track, tagging HEVC hvc1', () => {
    const args = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'remux', sourceVideoCodec: 'hevc' });
    expect(args.join(' ')).toContain('-map 0:v:0 -map 0:a:1?');
    expect(args).toContain('hvc1');
    expect(args.join(' ')).toMatch(/-c:v copy .*-c:a copy .*-movflags frag_keyframe\+empty_moov\+delay_moov\+default_base_moof -f mp4 pipe:1$/);
  });

  it('transcodes with seek, scale, tone-mapping and AAC 2.0 in software', () => {
    const args = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'transcode', copyAudio: false, startMs: 90_500, hwaccel: 'none', videoCodec: 'h264', height: 1080, sourceHeight: 2160, videoKbps: 8000, tonemap: true, zscale: true, fps: 24 });
    const s = args.join(' ');
    expect(s).toContain('-ss 90.500 -i /m/a.mkv');
    expect(s).toContain('scale=-2:1080,zscale=t=linear');
    expect(s).toContain('format=yuv420p');
    expect(s).toContain('-c:v libx264');
    expect(s).toContain('-b:v 8000k -maxrate 8000k -bufsize 16000k -g 72');
    expect(s).toContain('-c:a aac -ac 2 -b:a 192k');
  });

  it('burns an embedded picture subtitle or an external file over the video', () => {
    const embedded = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'transcode', hwaccel: 'none', burn: { ordinal: 1 } }).join(' ');
    expect(embedded).toContain('[0:s:1][0:v:0]scale2ref[sub][base];[base][sub]overlay');
    expect(embedded).toContain('-map [v]');
    const external = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'transcode', hwaccel: 'none', burn: { path: '/m/a.sup' } }).join(' ');
    expect(external).toContain('-i /m/a.mkv -i /m/a.sup');
    expect(external).toContain('[1:s:0][0:v:0]scale2ref');
  });

  it('uses the hardware upload chain for QSV and VAAPI', () => {
    const qsv = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'transcode', hwaccel: 'qsv' }).join(' ');
    expect(qsv).toContain('hwupload=extra_hw_frames=64,format=qsv');
    expect(qsv).toContain('h264_qsv');
    const vaapi = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'transcode', hwaccel: 'vaapi' }).join(' ');
    expect(vaapi).toContain('format=nv12,hwupload');
  });

  it('builds WebVTT and thumbnail commands', () => {
    expect(buildSubtitleArgs('/m/a.mkv', 2, '/c/out.vtt').join(' ')).toContain('-map 0:s:2 -c:s webvtt -f webvtt /c/out.vtt');
    expect(buildSubtitleArgs('/m/a.srt', null, '/c/out.vtt', 'CP1252').join(' ')).toContain('-sub_charenc CP1252 -i /m/a.srt');
    expect(buildThumbnailArgs('/m/a.mkv', 90_000, '/c/t.jpg').join(' ')).toContain('-ss 90.000');
  });
});
