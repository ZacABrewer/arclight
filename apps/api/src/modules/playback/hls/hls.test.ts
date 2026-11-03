import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VideoDeviceProfile, type VideoInfo, type VideoSubtitleTrack } from '@arclight/shared';
import { CapacityModel, cpuFactor, jobKey, seedSpeed, sharedSpeed, type JobClass } from './capacity.js';
import { capsTests, codecNames, detectPipelineCaps, filterNames } from './caps.js';
import { dropLeadingSamples, Fmp4Splitter, initSignature, initTracks, shiftFragment, type Fmp4Fragment } from './fmp4.js';
import { AUDIO_ID, AUDIO_TS, decodeTimes, fragment, initSegment, sampledFragment, samplesOf, VIDEO_ID, VIDEO_TS } from './fmp4.fixtures.js';
import { codecStringFromProbe, copySeekTarget, keyframeAtOrBefore, parseProbePackets, parseStartTime, type KeyframeIndex } from './keyframes.js';
import { audioFor, buildLadder, burnFor, h264CodecString, h264Level, hevcCodecString, pickStart, rungSize, type LadderInput } from './ladder.js';
import { hlsLinkQuery, verifyHlsLink } from './links.js';
import { buildHlsArgs, forceKeyframesArg, pipelineFor, SOFTWARE_CAPS, type HlsRunSpec, type PipelineCaps } from './pipeline.js';
import { ffmpegSeek, planBitrates, planFromKeyframes, segmentAt, segmentPlan, sourceTime, uniformStarts } from './plan.js';
import { masterPlaylist, mediaPlaylist } from './playlist.js';

// The pure half of HLS (0.24): segment plans, keyframe helpers, the ladder and its admission,
// the ffmpeg argv of every pipeline family, the capability tests, playlists, signed links and
// the fMP4 timestamp rewrite. No ffmpeg here (hls.ffmpeg.test.ts runs the real thing).

const BROWSER = VideoDeviceProfile.parse({ containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9', 'av1'], audioCodecs: ['aac', 'mp3', 'opus', 'flac'], maxAudioChannels: 2, maxHeight: 2160 });
const TV = VideoDeviceProfile.parse({ containers: ['mp4', 'mkv'], videoCodecs: ['h264', 'hevc'], hevc10bit: true, hdr: ['hdr10', 'hlg'], audioCodecs: ['aac', 'ac3', 'eac3'], maxAudioChannels: 6, maxHeight: 2160 });

const H264: VideoInfo = {
  mediaFileId: 1,
  versionTag: null,
  container: 'mp4',
  videoCodec: 'h264',
  videoProfile: 'High',
  bitDepth: 8,
  width: 1920,
  height: 1080,
  fps: 24,
  dynamicRange: 'sdr',
  sizeBytes: 450_000_000,
  bitrateKbps: 6000,
  audioTracks: [{ index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: true }],
  subtitleTracks: [],
} as VideoInfo;

const PGS_FORCED: VideoSubtitleTrack = { id: 'e1', language: 'eng', forced: true, default: false, text: false, codec: 'hdmv_pgs_subtitle', label: 'English (forced)', external: false } as unknown as VideoSubtitleTrack;
const UHD: VideoInfo = {
  ...H264,
  container: 'mkv',
  videoCodec: 'hevc',
  videoProfile: 'Main 10',
  bitDepth: 10,
  width: 3840,
  height: 2160,
  dynamicRange: 'hdr10',
  bitrateKbps: 40_000,
  sizeBytes: 3_000_000_000,
  audioTracks: [{ index: 0, codec: 'ac3', channels: 6, language: 'eng', title: null, default: true }],
  subtitleTracks: [PGS_FORCED],
} as VideoInfo;

const QSV: PipelineCaps = { ...SOFTWARE_CAPS, hwaccel: 'qsv', pipeline: 'qsv', hwDecode: ['h264', 'hevc'], hevcEncode: true, vppTonemap: true, tonemapOpencl: true, overlayQsv: true, lowPower: true };

function ladderInput(over: Partial<LadderInput> = {}): LadderInput {
  const capacity = new CapacityModel({ file: null, cpus: 4 });
  return {
    info: H264,
    baseRange: null,
    profile: BROWSER,
    audioTrack: 0,
    subtitle: null,
    quality: 'auto',
    capKbps: 0,
    remote: false,
    plan: segmentPlan(null, 600),
    index: null,
    caps: SOFTWARE_CAPS,
    predict: (jc) => capacity.predict(jc),
    ...over,
  };
}

describe('segment plan', () => {
  it('groups keyframes towards 6 s, keeps a long GOP whole and folds a short tail', () => {
    const kf2 = Array.from({ length: 30 }, (_, i) => i * 2);
    expect(planFromKeyframes(kf2, 60)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
    // A 15 s GOP is one segment.
    expect(planFromKeyframes([0, 6, 21, 27], 33)).toEqual([0, 6, 21, 27]);
    // A 1 s tail joins the previous segment.
    expect(planFromKeyframes(kf2, 59)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
    expect(planFromKeyframes(kf2, 61)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 58]);
    expect(uniformStarts(20)).toEqual([0, 6, 12]);
  });

  it('finds segments, durations and bitrates', () => {
    const index: KeyframeIndex = { v: 1, source: 'cues', keyframes: [0, 6, 12, 18], positions: [0, 1000, 5000, 6000], fileSize: 8000, codec: null };
    const plan = segmentPlan(index, 24);
    expect(plan).toMatchObject({ starts: [0, 6, 12, 18], durations: [6, 6, 6, 6], keyframeAligned: true, bytes: [1000, 4000, 1000, 2000], base: 0 });
    expect(segmentAt(plan, 0)).toBe(0);
    expect(segmentAt(plan, 11.9995)).toBe(2);
    expect(segmentAt(plan, 13)).toBe(2);
    expect(planBitrates(plan, 8000)).toEqual({ peakKbps: 5, avgKbps: 3 });
  });

  it('keeps an MPEG-TS start offset out of media time; an MP4 start delay is ffmpeg seek only', () => {
    const ts = segmentPlan({ v: 1, source: 'ffprobe', keyframes: [1.4, 7.4, 13.4, 19.4], positions: null, fileSize: 1, codec: null, startTime: 1.4 }, 24);
    expect(ts.starts).toEqual([0, 6, 12, 18]);
    expect(ffmpegSeek(ts, 12)).toBe(12);
    expect(sourceTime(ts, 12)).toBeCloseTo(13.4);
    const mp4 = segmentPlan({ v: 1, source: 'mp4', keyframes: [0.042, 6.042, 12.042], positions: null, fileSize: 1, codec: null, startTime: 0.042 }, 18);
    expect(mp4.base).toBe(0);
    expect(ffmpegSeek(mp4, 6.042)).toBeCloseTo(6);
  });
});

describe('keyframes', () => {
  it('parses ffprobe packets and the start time', () => {
    const out = 'pts_time=0.000000|pos=48|flags=K__\npts_time=0.041667|pos=900|flags=___\npts_time=2.000000|pos=12000|flags=K__\n';
    expect(parseProbePackets(out)).toEqual([
      { t: 0, pos: 48 },
      { t: 2, pos: 12000 },
    ]);
    expect(parseStartTime('start_time=1.400000\n')).toBe(1.4);
    expect(parseStartTime('start_time=N/A')).toBe(0);
  });

  it('snaps to keyframes and seeks a copy a little past one', () => {
    const index = { keyframes: [0, 4, 10] };
    expect(keyframeAtOrBefore(index, 9.99)).toBe(4);
    expect(keyframeAtOrBefore(index, 10)).toBe(10);
    expect(copySeekTarget(index, 4)).toBe(4.25);
    expect(copySeekTarget({ keyframes: [0, 0.2] }, 0)).toBeCloseTo(0.1);
  });

  it('builds codec strings', () => {
    expect(codecStringFromProbe('h264', 'High', 40)).toBe('avc1.640028');
    expect(codecStringFromProbe('hevc', 'Main 10', 150)).toBe('hvc1.2.4.L150.B0');
    expect(h264CodecString(h264Level(1920, 1080, 24, 8000).idc)).toBe('avc1.640028');
    expect(h264Level(1280, 720, 24, 4000).name).toBe('3.1');
    expect(hevcCodecString(2160, 24, true)).toBe('hvc1.2.4.L150.B0');
    expect(rungSize(1920, 800, 720)).toEqual({ width: 1280, height: 534 });
    expect(rungSize(1440, 1080, 720)).toEqual({ width: 960, height: 720 });
  });
});

describe('ladder', () => {
  it('lists rungs up to the source, best first, with sane bitrates', () => {
    const l = buildLadder(ladderInput());
    expect(l.rungs.map((r) => [r.id, r.videoKbps, r.width, r.height])).toEqual([
      ['1080', 4800, 1920, 1080],
      ['720', 4000, 1280, 720],
      ['480', 1600, 854, 480],
      ['360', 800, 640, 360],
    ]);
    expect(l.audio).toEqual({ ordinal: 0, codec: 'aac', channels: 2, kbps: 192 });
    expect(l.startRung).toBe('1080');
    expect(l.rungs[0]!.codecs).toBe('avc1.640028');
  });

  it('follows the cap with the height, and picks a start rung from the bandwidth', () => {
    const l = buildLadder(ladderInput({ capKbps: 2000, remote: true }));
    expect(l.rungs.map((r) => r.id)).toEqual(['480', '360']);
    expect(l.audio?.kbps).toBe(128);
    const full = buildLadder(ladderInput()).rungs;
    expect(pickStart(full, { quality: 'auto', bandwidthKbps: 3000, remote: true })).toBe('480');
    expect(pickStart(full, { quality: 'auto', remote: true })).toBe('720');
    expect(pickStart(full, { quality: 'auto', remote: false })).toBe('1080');
  });

  it('offers the source as a copy when the device plays its codecs', () => {
    const index: KeyframeIndex = { v: 1, source: 'cues', keyframes: Array.from({ length: 100 }, (_, i) => i * 6), positions: Array.from({ length: 100 }, (_, i) => i * 7_500_000), fileSize: 750_000_000, codec: 'hvc1.2.4.L150.B0' };
    const l = buildLadder(ladderInput({ info: { ...UHD, subtitleTracks: [] }, profile: TV, caps: QSV, index, plan: segmentPlan(index, 600), quality: 'original' }));
    expect(l.rungs[0]).toMatchObject({ id: 'src', mode: 'copy', codecs: 'hvc1.2.4.L150.B0', range: 'hdr10' });
    expect(l.startRung).toBe('src');
  });

  it('offers 2160 only once its speed is measured', () => {
    const capacity = new CapacityModel({ file: null, cpus: 4 });
    const input = ladderInput({ info: { ...UHD, subtitleTracks: [] }, profile: TV, caps: QSV, predict: (jc) => capacity.predict(jc) });
    const first = buildLadder(input);
    expect(first.rungs.map((r) => r.id)).toEqual(['1080', '720', '480', '360']);
    expect(first.rungs[0]).toMatchObject({ codec: 'hevc', videoKbps: 5500, tonemap: true });
    const uhdJob: JobClass = { pipeline: 'qsv', hwDecode: true, srcCodec: 'hevc', srcHeight: 2160, srcHdr: true, outHeight: 2160, outCodec: 'hevc', tonemap: false, tonemapx: false, burn: false };
    void capacity.record(uhdJob, 2.1);
    const second = buildLadder(input);
    expect(second.rungs[0]).toMatchObject({ id: '2160', codec: 'hevc', hdrKeep: true, range: 'hdr10' });
  });

  it('admits jobs by capacity: three 1080 QSV runs at 5x fit, the fourth gets 720', async () => {
    const capacity = new CapacityModel({ file: null, cpus: 4 });
    const input = ladderInput({ caps: QSV, predict: (jc) => capacity.predict(jc) });
    const job = buildLadder(input).rungs.find((r) => r.id === '1080')!.job!;
    await capacity.record(job, 5);
    for (let i = 0; i < 3; i++) {
      const l = buildLadder(input);
      expect(l.rungs[0]!.id).toBe('1080');
      capacity.begin(`s${i}`, job);
    }
    const fourth = buildLadder(input);
    expect(fourth.rungs[0]!.id).toBe('720');
    expect(fourth.rungs[0]!.speed).toBeGreaterThanOrEqual(1.3);
  });

  it('is busy when nothing is sustainable', () => {
    const l = buildLadder(ladderInput({ predict: () => ({ speed: 0.8, measured: true }) }));
    expect(l).toMatchObject({ busy: true, rungs: [] });
    // At 1.0x to 1.3x the lowest rung is still offered.
    expect(buildLadder(ladderInput({ predict: () => ({ speed: 1.1, measured: true }) })).rungs.map((r) => r.id)).toEqual(['360']);
  });

  it('picks audio per device and cap, and burns a forced image track in while subtitles are off', () => {
    expect(audioFor(UHD, 0, TV, 0)).toEqual({ ordinal: 0, codec: 'eac3', channels: 6, kbps: 640 });
    expect(audioFor(UHD, 0, { ...TV, audioCodecs: ['aac', 'ac3'] }, 0)).toMatchObject({ codec: 'ac3', channels: 6 });
    expect(audioFor(UHD, 0, BROWSER, 0)).toEqual({ ordinal: 0, codec: 'aac', channels: 2, kbps: 192 });
    expect(audioFor(UHD, 0, TV, 2500)).toEqual({ ordinal: 0, codec: 'aac', channels: 2, kbps: 128 });
    expect(burnFor(UHD, 0, null, 'auto')?.id).toBe('e1');
    expect(burnFor(UHD, 0, null, 'original')).toBeNull();
    expect(burnFor({ ...UHD, audioTracks: [{ ...UHD.audioTracks[0]!, language: 'ger' }] }, 0, null, 'auto')).toBeNull();
    const l = buildLadder(ladderInput({ info: UHD, profile: TV, caps: QSV }));
    expect(l.burn?.id).toBe('e1');
    expect(l.rungs.some((r) => r.id === 'src')).toBe(false);
  });
});

describe('ffmpeg argv', () => {
  const base: HlsRunSpec = {
    input: '/media/film.mkv',
    mode: 'transcode',
    pipeline: 'none',
    caps: SOFTWARE_CAPS,
    source: { codec: 'h264', range: 'sdr', width: 1920, height: 1080, fps: 24 },
    out: { width: 1280, height: 720, kbps: 4000, codec: 'h264', hdrKeep: false, tonemap: false, h264Level: '3.1' },
    audio: { ordinal: 1, codec: 'aac', channels: 2, kbps: 192 },
    burn: null,
    seekSec: 120,
    keyframeTimes: [126, 132],
    preset: 'veryfast',
  };
  const joined = (s: HlsRunSpec) => buildHlsArgs(s).join(' ');

  it('software: copyts seek, pinned x264, forced keyframes, 48 kHz audio, fMP4 to stdout', () => {
    const a = joined(base);
    expect(a).toContain('-copyts -ss 120.000 -protocol_whitelist file,pipe -i /media/film.mkv -copyts -ss 119.750 -protocol_whitelist file,pipe -i /media/film.mkv');
    expect(a).toContain('-map 0:v:0 -vf scale=1280:720:flags=fast_bilinear,format=yuv420p -map 1:a:1');
    // A burned-in subtitle file is the third input; without audio, the second.
    expect(joined({ ...base, burn: { path: '/media/film.en.srt' } })).toContain('[2:s:0][0:v:0]scale2ref');
    expect(joined({ ...base, audio: null, burn: { path: '/media/film.en.srt' } })).toContain('[1:s:0][0:v:0]scale2ref');
    // Every file input (the video, the audio reader, a burned-in subtitle) opens local files only (DATA-32).
    expect(joined({ ...base, burn: { path: '/media/film.en.srt' } }).match(/-protocol_whitelist file,pipe -i /g)).toHaveLength(3);
    expect(joined({ ...base, seekSec: 0 })).toContain('-copyts -ss 0.000 -protocol_whitelist file,pipe -i /media/film.mkv -copyts -ss 0.000 -protocol_whitelist file,pipe -i');
    expect(a).toContain('-c:v libx264 -preset veryfast -profile:v high -level:v 3.1 -x264-params bframes=3:ref=1:cabac=1:8x8dct=1:weightp=1:b-pyramid=normal');
    expect(a).toContain('-g 288 -sc_threshold 0 -force_key_frames 125.995,131.995');
    expect(a).toContain('-c:a aac -ac 2 -ar 48000 -b:a 192k');
    expect(a).toMatch(/-avoid_negative_ts disabled -f mp4 -movflags \+frag_keyframe\+empty_moov\+default_base_moof\+frag_discont -use_editlist 0 pipe:1$/);
    expect(a).not.toContain(' -t ');
    expect(joined({ ...base, preset: 'superfast' })).toContain('-preset superfast');
    expect(forceKeyframesArg([0, 6])).toBe('5.995');
  });

  it('qsv: GPU decode, vpp_qsv scale, low-power h264_qsv with forced IDR', () => {
    const a = joined({ ...base, pipeline: 'qsv', caps: QSV });
    expect(a).toContain('-init_hw_device vaapi=va:/dev/dri/renderD128 -init_hw_device qsv=qs@va -filter_hw_device qs -hwaccel qsv -hwaccel_output_format qsv -c:v h264_qsv -copyts -ss 120.000');
    expect(a).toContain('-vf vpp_qsv=w=1280:h=720:format=nv12');
    expect(a).toContain('-c:v h264_qsv -preset veryfast -look_ahead 0 -low_power 1 -forced_idr 1 -profile:v high');
    // Without GPU decode for the codec: upload system frames.
    expect(joined({ ...base, pipeline: 'qsv', caps: { ...QSV, hwDecode: [] } })).toContain('-vf format=nv12,hwupload=extra_hw_frames=64,format=qsv,vpp_qsv=w=1280:h=720:format=nv12');
  });

  it('qsv HDR: tone-map with OpenCL, else VPP; HDR kept as HEVC Main 10', () => {
    const hdr: HlsRunSpec = { ...base, pipeline: 'qsv', caps: QSV, source: { ...base.source, codec: 'hevc', range: 'hdr10', width: 3840, height: 2160 }, out: { width: 1920, height: 1080, kbps: 5500, codec: 'hevc', hdrKeep: false, tonemap: true } };
    expect(joined(hdr)).toContain('vpp_qsv=w=1920:h=1080:format=p010,hwmap=derive_device=opencl,tonemap_opencl=');
    expect(joined({ ...hdr, caps: { ...QSV, tonemapOpencl: false } })).toContain('vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1');
    const keep = joined({ ...hdr, out: { width: 3840, height: 2160, kbps: 16000, codec: 'hevc', hdrKeep: true, tonemap: false } });
    expect(keep).toContain('vpp_qsv=w=3840:h=2160:format=p010');
    expect(keep).toContain('-c:v hevc_qsv');
    expect(keep).toContain('-profile:v main10 -tag:v hvc1');
  });

  it('qsv burn-in overlays on the GPU', () => {
    const a = joined({ ...base, pipeline: 'qsv', caps: QSV, burn: { ordinal: 2 } });
    expect(a).toContain('[0:s:2]scale=1280:720:flags=fast_bilinear,format=bgra,hwupload=extra_hw_frames=64[sub];[base][sub]overlay_qsv');
  });

  it('vaapi: scale_vaapi and h264_vaapi', () => {
    const caps: PipelineCaps = { ...SOFTWARE_CAPS, hwaccel: 'vaapi', pipeline: 'vaapi', hwDecode: ['h264'] };
    const a = joined({ ...base, pipeline: 'vaapi', caps });
    expect(a).toContain('-filter_hw_device va -hwaccel vaapi -hwaccel_output_format vaapi -copyts');
    expect(a).toContain('-vf scale_vaapi=w=1280:h=720:format=nv12');
    expect(a).toContain('-c:v h264_vaapi -profile:v high');
  });

  it('copy: video from its keyframe, audio from just before the segment start', () => {
    const a = joined({ ...base, mode: 'copy', out: undefined, source: { ...base.source, codec: 'hevc' }, seekSec: 120, copySeekSec: 120.25 } as unknown as HlsRunSpec);
    expect(a).toContain('-copyts -ss 120.250 -protocol_whitelist file,pipe -i /media/film.mkv -copyts -ss 119.750 -protocol_whitelist file,pipe -i /media/film.mkv -map 0:v:0 -map 1:a:1');
    expect(a).toContain('-c:v copy -tag:v hvc1');
    expect(a).not.toContain('force_key_frames');
  });

  it('falls back to software filters when the GPU lacks one the job needs', () => {
    expect(pipelineFor(QSV, { tonemap: true, burn: true })).toBe('qsv');
    expect(pipelineFor({ ...QSV, tonemapOpencl: false, vppTonemap: false }, { tonemap: true, burn: false })).toBe('none');
    expect(pipelineFor({ ...QSV, overlayQsv: false }, { tonemap: false, burn: true })).toBe('none');
    expect(pipelineFor(SOFTWARE_CAPS, { tonemap: false, burn: false })).toBe('none');
  });
});

describe('pipeline caps', () => {
  it('parses filter and codec lists', () => {
    expect([...filterNames(' T.. vpp_qsv           V->V       Quick Sync Video VPP.\n ... tonemapx          V->V       HDR to SDR\n')]).toEqual(['vpp_qsv', 'tonemapx']);
    expect([...codecNames(' V....D h264_qsv             H264 video (Intel Quick Sync Video acceleration) (codec h264)\n')]).toEqual(['h264_qsv']);
  });

  it('builds one test run per feature', () => {
    const q = capsTests('qsv', '/tmp/x');
    expect(q.base.join(' ')).toContain('-c:v h264_qsv');
    expect(q.tonemapOpencl.join(' ')).toContain('tonemap_opencl');
    expect(q.overlay.join(' ')).toContain('overlay_qsv');
    expect(capsTests('vaapi', '/tmp/x').lowPower).toBeNull();
    expect(capsTests('vaapi', '/tmp/x').vppTonemap.join(' ')).toContain('tonemap_vaapi');
  });

  it('keeps what passes and drops what fails', async () => {
    const filters = ' T.. vpp_qsv  V->V x\n T.. tonemap_opencl V->V x\n T.. overlay_qsv VV->V x\n ... tonemapx V->V x\n';
    const decoders = ' V....D h264_qsv x\n V....D av1_qsv x\n';
    const exec = async (_bin: string, args: readonly string[]) => {
      const a = args.join(' ');
      if (a.endsWith('-filters')) return { code: 0, stdout: filters };
      if (a.endsWith('-decoders')) return { code: 0, stdout: decoders };
      if (a.includes('tonemap_opencl') || a.includes('-low_power')) return { code: 1, stdout: '' };
      return { code: 0, stdout: '' };
    };
    const caps = await detectPipelineCaps('ffmpeg', 'qsv', exec);
    expect(caps).toMatchObject({ pipeline: 'qsv', lowPower: false, hevcEncode: true, vppTonemap: true, tonemapOpencl: false, overlayQsv: true, tonemapx: true });
    expect(caps.hwDecode).toEqual(['h264', 'hevc', 'av1']);
    const none = await detectPipelineCaps('ffmpeg', 'qsv', async (_b, args) => (args.join(' ').endsWith('-filters') ? { code: 0, stdout: filters } : { code: 1, stdout: '' }));
    expect(none.pipeline).toBe('none');
    expect((await detectPipelineCaps('ffmpeg', 'none', exec)).pipeline).toBe('none');
  });
});

describe('capacity', () => {
  const job: JobClass = { pipeline: 'software', hwDecode: false, srcCodec: 'h264', srcHeight: 1080, srcHdr: false, outHeight: 1080, outCodec: 'h264', tonemap: false, tonemapx: false, burn: false };

  it('seeds, shares and scales with the CPU', () => {
    expect(seedSpeed(job, 4)).toBe(2.6);
    expect(seedSpeed({ ...job, outHeight: 720 }, 8)).toBe(11.6);
    expect(seedSpeed({ ...job, srcHeight: 2160, srcHdr: true, tonemap: true, tonemapx: true }, 4)).toBe(1.17);
    expect(seedSpeed({ ...job, outHeight: 2160 }, 4)).toBeNull();
    expect(seedSpeed({ ...job, pipeline: 'qsv', hwDecode: true }, 4)).toBe(8);
    expect(cpuFactor(64)).toBe(2);
    expect(sharedSpeed([5, 5, 5])).toBeCloseTo(5 / 3);
  });

  it('records medians and keeps them on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arclight-cap-'));
    try {
      const file = join(dir, 'capacity.json');
      const a = new CapacityModel({ file, cpus: 4 });
      for (const s of [3, 9, 4]) await a.record(job, s);
      expect(a.single(job)).toEqual({ speed: 4, measured: true });
      expect(JSON.parse(await readFile(file, 'utf8')).history[jobKey(job)]).toEqual([3, 9, 4]);
      const b = new CapacityModel({ file, cpus: 4 });
      await b.load();
      expect(b.single(job).speed).toBe(4);
      b.begin('x', job);
      expect(b.predict(job).speed).toBe(2);
      expect(b.predict(job, 'x').speed).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('playlists', () => {
  it('writes a master playlist with codecs, sizes and ranges', () => {
    const l = buildLadder(ladderInput());
    const m = masterPlaylist(l.rungs.slice(0, 2), l.audio, 'u=1&exp=2&sig=x', 23.976);
    expect(m.split('\n').slice(0, 5)).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=5472000,AVERAGE-BANDWIDTH=4992000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=23.976,VIDEO-RANGE=SDR',
      '1080/index.m3u8?u=1&exp=2&sig=x',
    ]);
  });

  it('writes a complete VOD media playlist from the plan', () => {
    const p = mediaPlaylist({ durations: [6, 6.5, 2] }, 'q=1');
    expect(p).toContain('#EXT-X-TARGETDURATION:7');
    expect(p).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(p).toContain('#EXT-X-MAP:URI="init.mp4?q=1"');
    expect(p).toContain('#EXTINF:6.500000,\n1.m4s?q=1');
    expect(p.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });
});

describe('signed links', () => {
  const key = Buffer.alloc(32, 3);
  const sid = 'a'.repeat(32);
  const q = (s: string) => Object.fromEntries(new URLSearchParams(s));

  it('verifies its own session only, and expires', () => {
    const query = q(hlsLinkQuery(key, { userId: 4, profileId: 9, sessionId: sid, exp: 2000 }));
    expect(verifyHlsLink(key, sid, query, 1_000_000)).toEqual({ ok: true, userId: 4, profileId: 9 });
    expect(verifyHlsLink(key, 'b'.repeat(32), query, 1_000_000)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyHlsLink(key, sid, { ...query, p: '8' }, 1_000_000)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyHlsLink(key, sid, query, 2_000_000)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verifyHlsLink(key, '../x', query, 0)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyHlsLink(key, sid, q(hlsLinkQuery(key, { userId: 4, sessionId: sid, exp: 2000 })), 0)).toEqual({ ok: true, userId: 4, profileId: null });
  });
});

describe('fragmented MP4', () => {
  it('splits a chunked stream into the init and fragments, and rewrites decode times', () => {
    const stream = Buffer.concat([initSegment(), fragment(0n, 0n), fragment(540_000n, 288_000n)]);
    const inits: Buffer[] = [];
    const frags: Fmp4Fragment[] = [];
    const s = new Fmp4Splitter(
      (i) => inits.push(i),
      (f) => frags.push(f),
    );
    for (let p = 0; p < stream.length; p += 7) s.push(stream.subarray(p, p + 7));
    expect(inits).toHaveLength(1);
    expect(initTracks(inits[0]!)).toEqual([
      { id: VIDEO_ID, timescale: VIDEO_TS, kind: 'video' },
      { id: AUDIO_ID, timescale: AUDIO_TS, kind: 'audio' },
    ]);
    expect(frags.map((f) => f.trafs.map((t) => [t.trackId, t.decodeTime, t.firstCts]))).toEqual([
      [
        [1, 0n, 7500],
        [2, 0n, 0],
      ],
      [
        [1, 540_000n, 7500],
        [2, 288_000n, 0],
      ],
    ]);
    shiftFragment(frags[1]!, new Map([[1, 1_000n], [2, -300_000n]]));
    expect(decodeTimes(frags[1]!.bytes)).toEqual([
      { track: 1, t: 541_000n },
      { track: 2, t: 0n },
    ]);
    expect(initSignature(initSegment())).toBe(initSignature(inits[0]!));
    expect(initSignature(initSegment('hvc1'))).not.toBe(initSignature(inits[0]!));
  });

  it('a negative start decodes from 0: video keeps its presentation time in signed composition offsets', () => {
    const frags: Fmp4Fragment[] = [];
    const s = new Fmp4Splitter(
      () => undefined,
      (f) => frags.push(f),
    );
    // The first fragment of a film: B-frame delay (video) and the AAC priming frame (audio) before 0.
    s.push(Buffer.concat([initSegment(), fragment(-7500n, -1024n, 7500)]));
    expect(frags[0]!.trafs.map((t) => t.decodeTime)).toEqual([-7500n, -1024n]);
    shiftFragment(frags[0]!, new Map());
    expect(decodeTimes(frags[0]!.bytes)).toEqual([
      { track: 1, t: 0n },
      { track: 2, t: 0n },
    ]);
    expect(frags[0]!.trafs[0]!.firstCts).toBe(0);
    // Read back: trun version 1 with the lowered offset, so the keyframe still shows at 0.
    const again: Fmp4Fragment[] = [];
    new Fmp4Splitter(
      () => undefined,
      (f) => again.push(f),
    ).push(Buffer.concat([initSegment(), frags[0]!.bytes]));
    expect(again[0]!.trafs[0]!).toMatchObject({ decodeTime: 0n, firstCts: 0 });
  });

  it('drops leading audio samples before a cut, keeping every other sample and its bytes', () => {
    const split = (buf: Buffer) => {
      const out: Fmp4Fragment[] = [];
      new Fmp4Splitter(
        () => undefined,
        (f) => out.push(f),
      ).push(Buffer.concat([initSegment(), buf]));
      return out[0]!;
    };
    for (const audioFirst of [false, true]) {
      const frag = split(sampledFragment(900_000n, 479_000n, [5, 6, 7, 8], audioFirst));
      // Samples start at 479000, 480024, 481048, 482072: a cut at 481000 drops the first two.
      const { frag: cut, reached } = dropLeadingSamples(frag, AUDIO_ID, 481_000n);
      expect(reached).toBe(true);
      expect(decodeTimes(cut.bytes)).toEqual([
        { track: VIDEO_ID, t: 900_000n },
        { track: AUDIO_ID, t: 481_048n },
      ]);
      expect(cut.bytes.length).toBe(frag.bytes.length - 8 - 11);
      const samples = samplesOf(cut.bytes);
      expect(samples.get(VIDEO_ID)).toEqual([Buffer.alloc(10, 0xee)]);
      expect(samples.get(AUDIO_ID)).toEqual([Buffer.alloc(7, 3), Buffer.alloc(8, 4)]);
      // Re-parses as a fragment.
      expect(split(cut.bytes).trafs.map((t) => t.decodeTime)).toEqual([900_000n, 481_048n]);
    }
    const frag = split(sampledFragment(900_000n, 479_000n, [5, 6], false));
    // Nothing before the cut: unchanged.
    expect(dropLeadingSamples(frag, AUDIO_ID, 0n).frag).toBe(frag);
    // Everything before it: keeps the last sample and asks for the next fragment.
    const all = dropLeadingSamples(frag, AUDIO_ID, 10_000_000n);
    expect(all.reached).toBe(false);
    expect(samplesOf(all.frag.bytes).get(AUDIO_ID)).toEqual([Buffer.alloc(6, 2)]);
    // A layout without sample tables (the synthetic fixtures) is left alone.
    const plain = split(fragment(0n, 0n));
    expect(dropLeadingSamples(plain, AUDIO_ID, 1000n).frag).toBe(plain);
  });
});
