import type { VideoDeviceProfile, VideoDynamicRange, VideoHlsRungId, VideoInfo, VideoQuality, VideoSubtitleTrack } from '@arclight/shared';
import { canonicalLanguage } from '../../transcode/ffmpeg.js';
import { decideVideo, normaliseCodec } from '../video-info.js';
import { SAFE_SPEED, type CapacityPipeline, type JobClass } from './capacity.js';
import { codecStringFromProbe, type KeyframeIndex } from './keyframes.js';
import { pipelineFor, type HlsAudioOut, type PipelineCaps } from './pipeline.js';
import { planBitrates, type SegmentPlan } from './plan.js';

// The ABR ladder of one HLS session (pure): which rungs the master playlist lists, what each one
// encodes to, and where the client starts. Never above the source (height or bitrate), never
// above the cap (the height follows it), and only rungs the encoder can sustain at ≥ 1.3x with
// the jobs already running. 2160 conversions need a measured speed (owner decision).

export interface LadderRung {
  id: VideoHlsRungId;
  mode: 'copy' | 'transcode';
  width: number;
  height: number;
  /** Video kbit/s (src: the file's average). */
  videoKbps: number;
  codec: 'h264' | 'hevc' | 'copy';
  range: 'sdr' | 'hdr10' | 'hlg';
  /** EXT-X-STREAM-INF BANDWIDTH / AVERAGE-BANDWIDTH (bit/s, audio included). */
  bandwidth: number;
  avgBandwidth: number;
  /** RFC 6381 video codec string. */
  codecs: string;
  /** Transcode: tone-map HDR to SDR / keep HDR (HEVC Main 10). */
  tonemap: boolean;
  hdrKeep: boolean;
  h264Level?: string;
  /** Predicted encode speed with the running jobs (null for copy). */
  speed: number | null;
  /** Transcode job class (capacity). */
  job: JobClass | null;
}

export interface Ladder {
  /** Best first; `level` = position. */
  rungs: LadderRung[];
  startRung: VideoHlsRungId;
  audio: HlsAudioOut | null;
  /** The image subtitle burned in (chosen, or a forced track while subtitles are off). */
  burn: VideoSubtitleTrack | null;
  /** No rung can be produced now (the box is full). */
  busy: boolean;
}

export interface LadderInput {
  info: VideoInfo;
  baseRange: VideoDynamicRange | null;
  profile: VideoDeviceProfile;
  audioTrack: number;
  /** The chosen subtitle (null: off). */
  subtitle: VideoSubtitleTrack | null;
  quality: VideoQuality;
  /** Effective cap in kbps (device, user, remote); 0: none. */
  capKbps: number;
  bandwidthKbps?: number;
  remote: boolean;
  plan: SegmentPlan;
  index: KeyframeIndex | null;
  caps: PipelineCaps;
  predict: (jc: JobClass) => { speed: number | null; measured: boolean };
}

interface RungDef {
  id: Exclude<VideoHlsRungId, 'src'>;
  height: number;
  h264Kbps: number;
}

const RUNGS: RungDef[] = [
  { id: '2160', height: 2160, h264Kbps: 16_000 },
  { id: '1080', height: 1080, h264Kbps: 8000 },
  { id: '720', height: 720, h264Kbps: 4000 },
  { id: '480', height: 480, h264Kbps: 1600 },
  { id: '360', height: 360, h264Kbps: 800 },
];
const HEVC_1080_KBPS = 5500;
const MIN_KBPS = 300;

/** Height class of a picture: a 1920x800 scope film is a 1080 source. */
export const heightClassOf = (width: number | null, height: number | null): number => Math.max(height ?? 0, width ? Math.round((width * 9) / 16) : 0);

/** Output size of a rung: the source scaled to fit the rung's 16:9 box, even dimensions. */
export function rungSize(srcW: number | null, srcH: number | null, boxH: number): { width: number; height: number } {
  const boxW = Math.round((boxH * 16) / 9);
  const w = srcW && srcW > 0 ? srcW : boxW;
  const h = srcH && srcH > 0 ? srcH : boxH;
  const scale = Math.min(boxW / w, boxH / h, 1);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * scale), height: even(h * scale) };
}

// H.264 levels: [name, idc, MaxFS (macroblocks), MaxMBPS, MaxBR (kbit/s, High = ×1.25)].
const H264_LEVELS: Array<[string, number, number, number, number]> = [
  ['3.0', 30, 1620, 40_500, 10_000],
  ['3.1', 31, 3600, 108_000, 14_000],
  ['3.2', 32, 5120, 216_000, 20_000],
  ['4.0', 40, 8192, 245_760, 20_000],
  ['4.1', 41, 8192, 245_760, 50_000],
  ['4.2', 42, 8704, 522_240, 50_000],
  ['5.0', 50, 22_080, 589_824, 135_000],
  ['5.1', 51, 36_864, 983_040, 240_000],
  ['5.2', 52, 36_864, 2_073_600, 240_000],
];

/** The lowest H.264 level that fits a size, frame rate and bitrate. */
export function h264Level(width: number, height: number, fps: number, kbps: number): { name: string; idc: number } {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = fs * (fps > 0 ? fps : 30);
  for (const [name, idc, maxFs, maxMbps, maxBr] of H264_LEVELS) {
    if (fs <= maxFs && mbps <= maxMbps && kbps * 2 <= maxBr * 1.25) return { name, idc };
  }
  return { name: '5.2', idc: 52 };
}

export function h264CodecString(level: number): string {
  return `avc1.6400${level.toString(16).padStart(2, '0')}`;
}

export function hevcCodecString(height: number, fps: number, main10: boolean): string {
  const level = height > 1440 ? (fps > 30 ? 153 : 150) : fps > 30 ? 123 : 120;
  return main10 ? `hvc1.2.4.L${level}.B0` : `hvc1.1.6.L${level}.B0`;
}

export function audioCodecString(codec: HlsAudioOut['codec']): string {
  return codec === 'aac' ? 'mp4a.40.2' : codec === 'ac3' ? 'ac-3' : 'ec-3';
}

export const videoRangeTag = (range: LadderRung['range']): 'SDR' | 'PQ' | 'HLG' => (range === 'hdr10' ? 'PQ' : range === 'hlg' ? 'HLG' : 'SDR');

/** §4.9 (v1: audio is always encoded, so its timing is exact across encoder restarts). */
export function audioFor(info: VideoInfo, audioTrack: number, profile: VideoDeviceProfile, capKbps: number): HlsAudioOut | null {
  const audio = info.audioTracks.find((a) => a.index === audioTrack) ?? info.audioTracks.find((a) => a.default) ?? info.audioTracks[0];
  if (!audio) return null;
  if (capKbps > 0 && capKbps < 3000) return { ordinal: audio.index, codec: 'aac', channels: 2, kbps: 128 };
  const codecs = profile.audioCodecs.map(normaliseCodec);
  if ((audio.channels ?? 2) >= 6 && profile.maxAudioChannels >= 6) {
    if (codecs.includes('eac3')) return { ordinal: audio.index, codec: 'eac3', channels: 6, kbps: 640 };
    if (codecs.includes('ac3')) return { ordinal: audio.index, codec: 'ac3', channels: 6, kbps: 640 };
    return { ordinal: audio.index, codec: 'aac', channels: 6, kbps: 384 };
  }
  return { ordinal: audio.index, codec: 'aac', channels: 2, kbps: 192 };
}

const sameLanguage = (a: string | null, b: string | null) => !!a && !!b && canonicalLanguage(a) === canonicalLanguage(b);

/** §4.10: the chosen image subtitle; with subtitles off, a forced image track in the audio's language. */
export function burnFor(info: VideoInfo, audioTrack: number, subtitle: VideoSubtitleTrack | null, quality: VideoQuality): VideoSubtitleTrack | null {
  if (subtitle) return subtitle.text ? null : subtitle;
  if (quality === 'original') return null;
  const audio = info.audioTracks.find((a) => a.index === audioTrack) ?? info.audioTracks.find((a) => a.default) ?? info.audioTracks[0];
  const lang = audio?.language ?? null;
  return info.subtitleTracks.find((s) => s.forced && !s.text && sameLanguage(s.language, lang)) ?? null;
}

/** The capacity class of a transcode (pipeline.ts picks the same family). */
export function capacityPipeline(caps: PipelineCaps, need: { tonemap: boolean; burn: boolean }): CapacityPipeline {
  const p = pipelineFor(caps, need);
  if (p !== 'none') return p;
  return caps.hwaccel === 'nvenc' ? 'nvenc' : caps.hwaccel === 'videotoolbox' ? 'videotoolbox' : 'software';
}

function transcodeRange(info: VideoInfo, baseRange: VideoDynamicRange | null): 'sdr' | 'hdr10' | 'hlg' {
  const r = info.dynamicRange === 'dv' ? (baseRange ?? 'sdr') : info.dynamicRange;
  return r === 'hlg' ? 'hlg' : r === 'sdr' ? 'sdr' : r === 'dv' ? 'sdr' : 'hdr10';
}

export function buildLadder(input: LadderInput): Ladder {
  const { info, profile, plan, caps } = input;
  const cap = input.capKbps;
  const audio = audioFor(info, input.audioTrack, profile, cap);
  const audioKbps = audio?.kbps ?? 0;
  const burn = burnFor(info, input.audioTrack, input.subtitle, input.quality);
  const fps = info.fps && info.fps > 0 ? info.fps : 24;
  const vcodecs = profile.videoCodecs.map(normaliseCodec);
  const srcClass = heightClassOf(info.width, info.height);
  const srcRange = transcodeRange(info, input.baseRange);
  const needTonemap = srcRange !== 'sdr';
  const pipeline = capacityPipeline(caps, { tonemap: needTonemap, burn: burn !== null });
  const gpuChain = pipeline === 'qsv' || pipeline === 'vaapi';
  const hwHevc = caps.hevcEncode && pipeline !== 'software';
  const deviceHevc = vcodecs.includes('hevc');
  const srcKbps = info.bitrateKbps && info.bitrateKbps > 0 ? info.bitrateKbps : null;
  const pinned = input.quality === '1080p' ? 1080 : input.quality === '720p' ? 720 : input.quality === '480p' ? 480 : null;

  // ---- src (copy) ----
  const rungs: LadderRung[] = [];
  const src = (() => {
    if (burn || !plan.keyframeAligned || pinned !== null) return null;
    const asIf = { ...profile, containers: [info.container], audioCodecs: [info.audioTracks.map((a) => a.codec), profile.audioCodecs].flat(), maxAudioChannels: 16 };
    const d = decideVideo({ info, baseRange: input.baseRange, profile: asIf, audioTrack: input.audioTrack, subtitle: null, quality: input.quality, userCapKbps: cap });
    if (d.method === 'transcode') return null;
    const rates = planBitrates(plan, input.index?.fileSize ?? info.sizeBytes);
    const avg = rates?.avgKbps ?? srcKbps ?? 0;
    const peak = rates?.peakKbps ?? Math.round(avg * 1.5);
    const range: LadderRung['range'] = info.dynamicRange === 'hlg' ? 'hlg' : info.dynamicRange === 'sdr' ? 'sdr' : info.dynamicRange === 'dv' ? (input.baseRange === 'hlg' ? 'hlg' : input.baseRange === 'sdr' ? 'sdr' : 'hdr10') : 'hdr10';
    const codecs = input.index?.codec ?? codecStringFromProbe(info.videoCodec, info.videoProfile, null) ?? (info.videoCodec === 'hevc' ? hevcCodecString(info.height ?? 1080, fps, (info.bitDepth ?? 8) > 8) : 'avc1.640028');
    const rung: LadderRung = {
      id: 'src',
      mode: 'copy',
      width: info.width ?? 0,
      height: info.height ?? 0,
      videoKbps: avg,
      codec: 'copy',
      range,
      bandwidth: (peak + audioKbps) * 1000,
      avgBandwidth: (avg + audioKbps) * 1000,
      codecs,
      tonemap: false,
      hdrKeep: false,
      speed: null,
      job: null,
    };
    return rung;
  })();
  if (src) rungs.push(src);

  // ---- transcode rungs ----
  type Candidate = LadderRung & { measured: boolean };
  const candidates: Candidate[] = [];
  for (const def of RUNGS) {
    if (def.height > srcClass + 8 && !(def.id === '360' && srcClass < 360)) continue;
    if (def.height > profile.maxHeight + 8) continue;
    if (pinned !== null && def.height > pinned) continue;
    let codec: 'h264' | 'hevc' = 'h264';
    let kbps = def.h264Kbps;
    let hdrKeep = false;
    if (def.id === '2160') {
      if (!hwHevc || !deviceHevc || profile.maxHeight < 2160 || pinned !== null) continue;
      codec = 'hevc';
      hdrKeep = gpuChain && srcRange !== 'sdr' && profile.hevc10bit && profile.hdr.includes(srcRange === 'hlg' ? 'hlg' : 'hdr10');
    } else if (def.id === '1080' && hwHevc && deviceHevc && srcClass > 1440) {
      codec = 'hevc';
      kbps = HEVC_1080_KBPS;
    }
    if (srcKbps) kbps = Math.min(kbps, Math.round(srcKbps * 0.8));
    kbps = Math.max(MIN_KBPS, kbps);
    const size = rungSize(info.width, info.height, def.height);
    const tonemap = srcRange !== 'sdr' && !hdrKeep;
    const job: JobClass = {
      // HDR kept on the GPU needs no tone-map filter; the family is the same.
      pipeline: hdrKeep ? (caps.pipeline === 'vaapi' ? 'vaapi' : 'qsv') : pipeline,
      hwDecode: gpuChain && caps.hwDecode.includes(info.videoCodec),
      srcCodec: info.videoCodec,
      srcHeight: srcClass,
      srcHdr: srcRange !== 'sdr',
      outHeight: def.height,
      outCodec: codec,
      tonemap,
      tonemapx: caps.tonemapx,
      burn: burn !== null,
    };
    const level = codec === 'h264' ? h264Level(size.width, size.height, fps, kbps) : null;
    const { speed, measured } = input.predict(job);
    candidates.push({
      id: def.id,
      mode: 'transcode',
      width: size.width,
      height: size.height,
      videoKbps: kbps,
      codec,
      range: hdrKeep ? srcRange : 'sdr',
      bandwidth: Math.round(kbps * 1.1 + audioKbps) * 1000,
      avgBandwidth: (kbps + audioKbps) * 1000,
      codecs: codec === 'h264' ? h264CodecString(level!.idc) : hevcCodecString(size.height, fps, hdrKeep),
      tonemap,
      hdrKeep,
      ...(level ? { h264Level: level.name } : {}),
      speed,
      job,
      measured,
    });
  }

  // Dedupe: a lower rung at (nearly) the same bitrate adds nothing.
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && c.videoKbps >= prev.videoKbps * 0.9) continue;
    deduped.push(c);
  }

  // Cap: the height follows the bitrate.
  let capped = deduped;
  if (cap > 0) {
    capped = deduped.filter((c) => c.videoKbps + audioKbps <= cap);
    if (capped.length === 0 && deduped.length > 0) {
      const lowest = deduped[deduped.length - 1]!;
      const kbps = Math.max(MIN_KBPS, cap - audioKbps);
      const level = lowest.codec === 'h264' ? h264Level(lowest.width, lowest.height, fps, kbps) : null;
      capped = [{ ...lowest, videoKbps: kbps, bandwidth: Math.round(kbps * 1.1 + audioKbps) * 1000, avgBandwidth: (kbps + audioKbps) * 1000, ...(level ? { h264Level: level.name, codecs: h264CodecString(level.idc) } : {}) }];
    }
  }

  // Admission: sustainable rungs only (2160 only when measured).
  const admitted = capped.filter((c) => c.speed !== null && c.speed >= SAFE_SPEED && (c.id !== '2160' || c.measured));
  let busy = false;
  if (admitted.length === 0) {
    const lowest = capped[capped.length - 1];
    if (lowest && lowest.speed !== null && lowest.speed >= 1.0 && lowest.id !== '2160') admitted.push(lowest);
    else if (!src) busy = true;
  }
  for (const { measured: _m, ...r } of admitted) rungs.push(r);

  return { rungs, startRung: busy ? '360' : pickStart(rungs, input), audio, burn, busy };
}

/** §4.2: the highest rung within 0.7 × the hint; without one, 1080 on the LAN, 720 remote. */
export function pickStart(rungs: readonly LadderRung[], input: Pick<LadderInput, 'quality' | 'bandwidthKbps' | 'remote'>): VideoHlsRungId {
  if (rungs.length === 0) return '360';
  if (input.quality !== 'auto') return rungs[0]!.id;
  const lowest = rungs[rungs.length - 1]!;
  if (input.bandwidthKbps) {
    const budget = input.bandwidthKbps * 1000 * 0.7;
    return (rungs.find((r) => r.bandwidth <= budget) ?? lowest).id;
  }
  const maxH = input.remote ? 720 : 1080;
  return (rungs.find((r) => r.height <= maxH + 8) ?? lowest).id;
}
