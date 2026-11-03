import type { TranscodeHwaccel, VideoDynamicRange } from '@arclight/shared';
import { presetArgs, VAAPI_DEVICE, videoEncoder } from '../../transcode/ffmpeg.js';
import { TONEMAP_ZSCALE } from '../video-info.js';

// The ffmpeg argv of one HLS encoder run: the source from a segment start, one rung, written as
// fragmented MP4 to stdout (the job splits it into segments). Three pipeline families:
//  - qsv: decode, scale, tone-map, overlay and encode on the Intel GPU (frames never leave it);
//  - vaapi: the same with VA-API filters;
//  - software: decode and filters on the CPU (tonemapx when the build has it, else zscale), then
//    libx264, or a hardware encoder that takes system frames (nvenc, videotoolbox).
// Copy runs (the src rung) copy the video and transcode the audio.

export type HlsPipeline = 'qsv' | 'vaapi' | 'none';

/** What the ffmpeg build and the GPU can do (EncoderDetector.caps(), tested once per process). */
export interface PipelineCaps {
  /** The live encoder backend (the 0.23 detection). */
  hwaccel: TranscodeHwaccel;
  /** Full-GPU pipeline family for HLS (qsv/vaapi), else none (software filters). */
  pipeline: HlsPipeline;
  /** Source codecs the GPU decodes (h264, hevc, av1, vp9, mpeg2video, vc1). */
  hwDecode: string[];
  /** HEVC (Main 10) encodes on the GPU. */
  hevcEncode: boolean;
  /** vpp_qsv tone-mapping (tonemap=1). */
  vppTonemap: boolean;
  /** tonemap_opencl through hwmap (QSV/VAAPI interop). */
  tonemapOpencl: boolean;
  tonemapVaapi: boolean;
  overlayQsv: boolean;
  overlayVaapi: boolean;
  /** jellyfin-ffmpeg's SIMD tone-mapper. */
  tonemapx: boolean;
  zscale: boolean;
  /** h264_qsv/hevc_qsv take -low_power 1. */
  lowPower: boolean;
}

export const SOFTWARE_CAPS: PipelineCaps = {
  hwaccel: 'none',
  pipeline: 'none',
  hwDecode: [],
  hevcEncode: false,
  vppTonemap: false,
  tonemapOpencl: false,
  tonemapVaapi: false,
  overlayQsv: false,
  overlayVaapi: false,
  tonemapx: false,
  zscale: false,
  lowPower: false,
};

export interface HlsAudioOut {
  /** Source audio ordinal. */
  ordinal: number;
  codec: 'aac' | 'ac3' | 'eac3';
  channels: number;
  kbps: number;
}

/** Encoder delay (priming samples at 48 kHz) the MP4 muxer leaves at the start of a track without an edit list. */
export const AUDIO_PRIMING: Record<HlsAudioOut['codec'], number> = { aac: 1024, ac3: 256, eac3: 256 };
export const AUDIO_RATE = 48_000;

export interface HlsRunSpec {
  input: string;
  mode: 'copy' | 'transcode';
  /** Transcode: pipeline family (copy ignores it). */
  pipeline: HlsPipeline;
  caps: PipelineCaps;
  source: { codec: string; range: VideoDynamicRange; width: number | null; height: number | null; fps: number | null };
  /** Transcode output. */
  out?: { width: number; height: number; kbps: number; codec: 'h264' | 'hevc'; hdrKeep: boolean; tonemap: boolean; h264Level?: string };
  audio: HlsAudioOut | null;
  burn: { ordinal: number } | { path: string } | null;
  /** ffmpeg's -ss (relative to the container start time) for the audio, and for the video of a transcode. */
  seekSec: number;
  /** Copy: the video seek (a little after the keyframe; demuxers seek by decode time). */
  copySeekSec?: number;
  /** Absolute media times (source timestamps) where transcodes must start a new keyframe. */
  keyframeTimes: readonly number[];
  preset: 'veryfast' | 'superfast';
}

const FMP4_OUT = ['-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-use_editlist', '0', 'pipe:1'];

const QSV_DECODERS: Record<string, string> = { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv', vp9: 'vp9_qsv', mpeg2video: 'mpeg2_qsv', vc1: 'vc1_qsv' };

const sec = (n: number) => Math.max(0, n).toFixed(3);

/** -force_key_frames list: a hair before each boundary so the frame at it is the keyframe. */
export function forceKeyframesArg(times: readonly number[]): string | null {
  const list = times.filter((t) => t > 0.01).map((t) => (t - 0.005).toFixed(3));
  return list.length > 0 ? list.join(',') : null;
}

/** HDR (PQ/HLG) software tone-map to 8-bit BT.709. */
function softwareTonemap(caps: PipelineCaps): string[] {
  if (caps.tonemapx) return ['tonemapx=tonemap=bt2390:t=bt709:m=bt709:p=bt709:format=yuv420p'];
  if (caps.zscale) return [TONEMAP_ZSCALE, 'format=yuv420p'];
  return ['format=yuv420p'];
}

function audioArgs(audio: HlsAudioOut | null): string[] {
  if (!audio) return ['-an'];
  return ['-c:a', audio.codec, '-ac', String(audio.channels), '-ar', String(AUDIO_RATE), '-b:a', `${audio.kbps}k`];
}

function rateArgs(kbps: number, fps: number | null): string[] {
  // A GOP longer than any segment: keyframes come only from -force_key_frames.
  const gop = String(Math.ceil((fps && fps > 0 ? fps : 30) * 12));
  return ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', gop];
}

/**
 * x264 settings pinned so the preset step (veryfast → superfast) keeps the same SPS/PPS: the
 * init segment of a rung must stay valid across encoder restarts.
 */
const X264_PINNED = 'bframes=3:ref=1:cabac=1:8x8dct=1:weightp=1:b-pyramid=normal';

/** The argv (without the binary) of one encoder run. */
export function buildHlsArgs(spec: HlsRunSpec): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-progress', 'pipe:2', '-stats_period', '1'];
  const audioMap = spec.audio ? ['-map', `${spec.mode === 'copy' ? 1 : 0}:a:${spec.audio.ordinal}`] : [];
  const tail = ['-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '4096'];

  if (spec.mode === 'copy') {
    // Two readers of the file: the video from its keyframe, the audio trimmed to the segment start.
    args.push('-copyts', '-ss', sec(spec.copySeekSec ?? spec.seekSec), '-i', spec.input);
    if (spec.audio) args.push('-copyts', '-ss', sec(spec.seekSec), '-i', spec.input);
    args.push('-map', '0:v:0', ...audioMap, ...tail, '-c:v', 'copy');
    if (spec.source.codec === 'hevc') args.push('-tag:v', 'hvc1');
    args.push(...audioArgs(spec.audio), ...FMP4_OUT);
    return args;
  }

  const out = spec.out!;
  const pipeline = spec.pipeline;
  const fk = forceKeyframesArg(spec.keyframeTimes);
  const scaled = out.height !== (spec.source.height ?? out.height) || out.width !== (spec.source.width ?? out.width);
  const hwDecoder = pipeline === 'qsv' ? QSV_DECODERS[spec.source.codec] : undefined;
  const hwDecode = pipeline !== 'none' && spec.caps.hwDecode.includes(spec.source.codec) && (pipeline !== 'qsv' || hwDecoder !== undefined);

  if (pipeline === 'qsv') {
    args.push('-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs');
    if (hwDecode) args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', hwDecoder!);
  } else if (pipeline === 'vaapi') {
    args.push('-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va');
    if (hwDecode) args.push('-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi');
  } else if (spec.caps.hwaccel === 'nvenc' || spec.caps.hwaccel === 'videotoolbox') {
    // Encode-only hardware: decode and filters stay on the CPU (frames in system memory).
  }
  args.push('-copyts', '-ss', sec(spec.seekSec), '-i', spec.input);
  if (spec.burn && 'path' in spec.burn) args.push('-copyts', '-ss', sec(spec.seekSec), '-i', spec.burn.path);

  const W = out.width;
  const H = out.height;
  const hdrSource = spec.source.range !== 'sdr';
  let main: string[];
  if (pipeline === 'qsv') {
    const upload = hwDecode ? [] : ['format=nv12', 'hwupload=extra_hw_frames=64', 'format=qsv'];
    if (out.hdrKeep) main = [...(hwDecode ? [] : ['format=p010le', 'hwupload=extra_hw_frames=64', 'format=qsv']), `vpp_qsv=w=${W}:h=${H}:format=p010`];
    else if (hdrSource && out.tonemap && spec.caps.tonemapOpencl)
      main = [...(hwDecode ? [] : ['format=p010le', 'hwupload=extra_hw_frames=64', 'format=qsv']), `vpp_qsv=w=${W}:h=${H}:format=p010`, 'hwmap=derive_device=opencl', 'tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12', 'hwmap=derive_device=qsv:reverse=1', 'format=qsv'];
    else if (hdrSource && out.tonemap) main = [...(hwDecode ? [] : ['format=p010le', 'hwupload=extra_hw_frames=64', 'format=qsv']), `vpp_qsv=w=${W}:h=${H}:format=nv12:tonemap=1`];
    else main = [...upload, `vpp_qsv=w=${W}:h=${H}:format=nv12`];
  } else if (pipeline === 'vaapi') {
    const upload = hwDecode ? [] : [hdrSource ? 'format=p010le' : 'format=nv12', 'hwupload'];
    if (out.hdrKeep) main = [...upload, `scale_vaapi=w=${W}:h=${H}:format=p010`];
    else if (hdrSource && out.tonemap && spec.caps.tonemapOpencl) main = [...upload, `scale_vaapi=w=${W}:h=${H}:format=p010`, 'hwmap=derive_device=opencl', 'tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12', 'hwmap=derive_device=vaapi:reverse=1'];
    else if (hdrSource && out.tonemap) main = [...upload, `scale_vaapi=w=${W}:h=${H}:format=p010`, 'tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709'];
    else main = [...upload, `scale_vaapi=w=${W}:h=${H}:format=nv12`];
  } else {
    main = [];
    if (scaled) main.push(`scale=${W}:${H}:flags=fast_bilinear`);
    if (hdrSource && out.tonemap) main.push(...softwareTonemap(spec.caps));
    else main.push('format=yuv420p');
  }

  if (spec.burn) {
    const sub = 'path' in spec.burn ? '[1:s:0]' : `[0:s:${spec.burn.ordinal}]`;
    if (pipeline === 'qsv' && spec.caps.overlayQsv) {
      args.push('-filter_complex', `[0:v:0]${main.join(',')}[base];${sub}scale=${W}:${H}:flags=fast_bilinear,format=bgra,hwupload=extra_hw_frames=64[sub];[base][sub]overlay_qsv=eof_action=pass:repeatlast=0[v]`, '-map', '[v]');
    } else if (pipeline === 'vaapi' && spec.caps.overlayVaapi) {
      args.push('-filter_complex', `[0:v:0]${main.join(',')}[base];${sub}scale=${W}:${H}:flags=fast_bilinear,format=rgba,hwupload[sub];[base][sub]overlay_vaapi=eof_action=pass[v]`, '-map', '[v]');
    } else {
      // Software: lay the subtitle picture over the source frame, then scale/tone-map.
      args.push('-filter_complex', `${sub}[0:v:0]scale2ref[sub][base];[base][sub]overlay=eof_action=pass${main.length ? ',' + main.join(',') : ''}[v]`, '-map', '[v]');
    }
  } else {
    args.push('-map', '0:v:0', '-vf', main.join(','));
  }
  args.push(...audioMap, ...tail);

  if (pipeline === 'qsv') {
    const enc = out.codec === 'hevc' ? 'hevc_qsv' : 'h264_qsv';
    args.push('-c:v', enc, '-preset', 'veryfast', '-look_ahead', '0', ...(spec.caps.lowPower ? ['-low_power', '1'] : []), '-forced_idr', '1');
    if (out.codec === 'hevc') args.push('-profile:v', out.hdrKeep ? 'main10' : 'main', '-tag:v', 'hvc1');
    else args.push('-profile:v', 'high');
  } else if (pipeline === 'vaapi') {
    const enc = out.codec === 'hevc' ? 'hevc_vaapi' : 'h264_vaapi';
    args.push('-c:v', enc);
    if (out.codec === 'hevc') args.push('-profile:v', out.hdrKeep ? 'main10' : 'main', '-tag:v', 'hvc1');
    else args.push('-profile:v', 'high');
  } else if (spec.caps.hwaccel === 'nvenc' || spec.caps.hwaccel === 'videotoolbox') {
    const enc = videoEncoder(out.codec, spec.caps.hwaccel);
    args.push('-c:v', enc, ...presetArgs(enc, 'veryfast'));
    if (out.codec === 'hevc') args.push('-tag:v', 'hvc1');
    else args.push('-profile:v', 'high');
    if (enc.endsWith('_nvenc')) args.push('-forced-idr', '1');
  } else {
    args.push('-c:v', 'libx264', '-preset', spec.preset, '-profile:v', 'high', ...(out.h264Level ? ['-level:v', out.h264Level] : []), '-x264-params', X264_PINNED, '-forced-idr', '1');
  }
  args.push(...rateArgs(out.kbps, spec.source.fps), '-sc_threshold', '0');
  if (fk) args.push('-force_key_frames', fk);
  args.push(...audioArgs(spec.audio), ...FMP4_OUT);
  return args;
}

/** True for the software family (preset steps apply; CPU capacity). */
export const isSoftware = (spec: Pick<HlsRunSpec, 'mode' | 'pipeline' | 'caps'>): boolean => spec.mode === 'transcode' && spec.pipeline === 'none' && spec.caps.hwaccel !== 'nvenc' && spec.caps.hwaccel !== 'videotoolbox';

/**
 * The pipeline family a transcode can use: the GPU chain when every filter it needs is there
 * (tone-mapping, overlay for a burn-in), else software filters (hardware HDR keep needs the GPU).
 */
export function pipelineFor(caps: PipelineCaps, need: { tonemap: boolean; burn: boolean }): HlsPipeline {
  if (caps.pipeline === 'qsv') {
    if (need.tonemap && !caps.tonemapOpencl && !caps.vppTonemap) return 'none';
    if (need.burn && !caps.overlayQsv) return 'none';
    return 'qsv';
  }
  if (caps.pipeline === 'vaapi') {
    if (need.tonemap && !caps.tonemapOpencl && !caps.tonemapVaapi) return 'none';
    if (need.burn && !caps.overlayVaapi) return 'none';
    return 'vaapi';
  }
  return 'none';
}
