import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscodeHwaccel } from '@arclight/shared';
import { VAAPI_DEVICE } from '../../transcode/ffmpeg.js';
import type { Exec } from '../video-stream.js';
import { fileInput, generatedInput } from '../../transcode/input-protocols.js';
import { SOFTWARE_CAPS, type PipelineCaps } from './pipeline.js';

// What the full-GPU HLS pipelines can use on this box, tested once per process with tiny ffmpeg
// runs (a fraction of a second each): GPU decode per codec, VPP/OpenCL/VA-API tone-mapping,
// hardware overlay, HEVC (Main 10) encode and low-power encode. Anything that fails is left out,
// and pipeline.ts falls back to the software filter for it.

const T = 15_000;

const QSV_INIT = ['-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs'];
const VAAPI_INIT = ['-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va'];
const SRC = generatedInput('testsrc2=s=320x180:r=10:d=0.5');
const NULL_OUT = ['-frames:v', '3', '-f', 'null', '-'];
const BASE = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

/** Names in `ffmpeg -filters` output. */
export function filterNames(out: string): Set<string> {
  const names = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*[TSC.]{2,3}\s+(\w+)\s/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

/** Names in `ffmpeg -decoders` / `-encoders` output. */
export function codecNames(out: string): Set<string> {
  const names = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)\s/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

/** The capability-test argv list (exported for tests). */
export function capsTests(pipeline: 'qsv' | 'vaapi', dir: string) {
  const h264File = join(dir, 'h264.mp4');
  const hevcFile = join(dir, 'hevc.mp4');
  if (pipeline === 'qsv') {
    const up = (fmt: string) => `format=${fmt},hwupload=extra_hw_frames=16,format=qsv`;
    return {
      base: [...BASE, ...QSV_INIT, ...SRC, '-vf', `${up('nv12')},vpp_qsv=w=160:h=90:format=nv12`, '-c:v', 'h264_qsv', '-frames:v', '10', '-y', h264File],
      lowPower: [...BASE, ...QSV_INIT, ...SRC, '-vf', up('nv12'), '-c:v', 'h264_qsv', '-low_power', '1', ...NULL_OUT],
      hevcEncode: [...BASE, ...QSV_INIT, ...SRC, '-vf', `${up('p010le')},vpp_qsv=w=160:h=90:format=p010`, '-c:v', 'hevc_qsv', '-profile:v', 'main10', '-frames:v', '10', '-y', hevcFile],
      decodeH264: [...BASE, ...QSV_INIT, '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', 'h264_qsv', ...fileInput(h264File), '-vf', 'vpp_qsv=w=80:h=46:format=nv12', '-c:v', 'h264_qsv', ...NULL_OUT],
      decodeHevc: [...BASE, ...QSV_INIT, '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', 'hevc_qsv', ...fileInput(hevcFile), '-vf', 'vpp_qsv=w=80:h=46:format=nv12', '-c:v', 'h264_qsv', ...NULL_OUT],
      vppTonemap: [...BASE, ...QSV_INIT, ...SRC, '-vf', `${up('p010le')},vpp_qsv=w=160:h=90:format=nv12:tonemap=1`, '-c:v', 'h264_qsv', ...NULL_OUT],
      tonemapOpencl: [...BASE, ...QSV_INIT, ...SRC, '-vf', `${up('p010le')},vpp_qsv=w=160:h=90:format=p010,hwmap=derive_device=opencl,tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12,hwmap=derive_device=qsv:reverse=1,format=qsv`, '-c:v', 'h264_qsv', ...NULL_OUT],
      overlay: [...BASE, ...QSV_INIT, ...SRC, ...generatedInput('color=c=white@0.5:s=160x90:d=0.5,format=bgra'), '-filter_complex', `[0:v]${up('nv12')},vpp_qsv=w=160:h=90:format=nv12[b];[1:v]hwupload=extra_hw_frames=16[s];[b][s]overlay_qsv=eof_action=pass:repeatlast=0[v]`, '-map', '[v]', '-c:v', 'h264_qsv', ...NULL_OUT],
    };
  }
  const up = (fmt: string) => `format=${fmt},hwupload`;
  return {
    base: [...BASE, ...VAAPI_INIT, ...SRC, '-vf', `${up('nv12')},scale_vaapi=w=160:h=90:format=nv12`, '-c:v', 'h264_vaapi', '-frames:v', '10', '-y', h264File],
    lowPower: null,
    hevcEncode: [...BASE, ...VAAPI_INIT, ...SRC, '-vf', `${up('p010le')},scale_vaapi=w=160:h=90:format=p010`, '-c:v', 'hevc_vaapi', '-profile:v', 'main10', '-frames:v', '10', '-y', hevcFile],
    decodeH264: [...BASE, ...VAAPI_INIT, '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', ...fileInput(h264File), '-vf', 'scale_vaapi=w=80:h=46:format=nv12', '-c:v', 'h264_vaapi', ...NULL_OUT],
    decodeHevc: [...BASE, ...VAAPI_INIT, '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', ...fileInput(hevcFile), '-vf', 'scale_vaapi=w=80:h=46:format=nv12', '-c:v', 'h264_vaapi', ...NULL_OUT],
    vppTonemap: [...BASE, ...VAAPI_INIT, ...SRC, '-vf', `${up('p010le')},scale_vaapi=w=160:h=90:format=p010,tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709`, '-c:v', 'h264_vaapi', ...NULL_OUT],
    tonemapOpencl: [...BASE, ...VAAPI_INIT, ...SRC, '-vf', `${up('p010le')},scale_vaapi=w=160:h=90:format=p010,hwmap=derive_device=opencl,tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12,hwmap=derive_device=vaapi:reverse=1`, '-c:v', 'h264_vaapi', ...NULL_OUT],
    overlay: [...BASE, ...VAAPI_INIT, ...SRC, ...generatedInput('color=c=white@0.5:s=160x90:d=0.5,format=rgba'), '-filter_complex', `[0:v]${up('nv12')},scale_vaapi=w=160:h=90:format=nv12[b];[1:v]hwupload[s];[b][s]overlay_vaapi=eof_action=pass[v]`, '-map', '[v]', '-c:v', 'h264_vaapi', ...NULL_OUT],
  };
}

/**
 * The pipeline caps for the live backend `hwaccel` (from the 0.23 detection). Software filters
 * (tonemapx, zscale) come from the filter list; the GPU features from test runs.
 */
export async function detectPipelineCaps(bin: string, hwaccel: TranscodeHwaccel, exec: Exec): Promise<PipelineCaps> {
  const filters = filterNames((await exec(bin, ['-hide_banner', '-filters'], T).catch(() => ({ code: 1, stdout: '' }))).stdout);
  const caps: PipelineCaps = { ...SOFTWARE_CAPS, hwaccel, tonemapx: filters.has('tonemapx'), zscale: filters.has('zscale') };
  if (hwaccel === 'nvenc' || hwaccel === 'videotoolbox') {
    const encoders = codecNames((await exec(bin, ['-hide_banner', '-encoders'], T).catch(() => ({ code: 1, stdout: '' }))).stdout);
    caps.hevcEncode = encoders.has(hwaccel === 'nvenc' ? 'hevc_nvenc' : 'hevc_videotoolbox');
    return caps;
  }
  if (hwaccel !== 'qsv' && hwaccel !== 'vaapi') return caps;
  const needed = hwaccel === 'qsv' ? ['vpp_qsv'] : ['scale_vaapi'];
  if (!needed.every((f) => filters.has(f))) return caps;
  const dir = await mkdtemp(join(tmpdir(), 'arclight-caps-'));
  try {
    const tests = capsTests(hwaccel, dir);
    const ok = async (args: string[] | null) => (args ? (await exec(bin, args, T).catch(() => ({ code: 1, stdout: '' }))).code === 0 : false);
    if (!(await ok(tests.base))) return caps;
    caps.pipeline = hwaccel;
    caps.lowPower = await ok(tests.lowPower);
    caps.hevcEncode = await ok(tests.hevcEncode);
    const decoders = codecNames((await exec(bin, ['-hide_banner', '-decoders'], T).catch(() => ({ code: 1, stdout: '' }))).stdout);
    const hwDecode: string[] = [];
    if (await ok(tests.decodeH264)) hwDecode.push('h264');
    if (caps.hevcEncode && (await ok(tests.decodeHevc))) hwDecode.push('hevc');
    // Codecs without a cheap sample: listed decoders are tried; a failing run falls back to software.
    if (hwaccel === 'qsv') {
      for (const [codec, dec] of [['av1', 'av1_qsv'], ['vp9', 'vp9_qsv'], ['mpeg2video', 'mpeg2_qsv'], ['vc1', 'vc1_qsv']] as const) if (decoders.has(dec)) hwDecode.push(codec);
    }
    caps.hwDecode = hwDecode;
    caps.vppTonemap = (hwaccel === 'qsv' || filters.has('tonemap_vaapi')) && (await ok(tests.vppTonemap));
    caps.tonemapVaapi = hwaccel === 'vaapi' && caps.vppTonemap;
    if (hwaccel === 'vaapi') caps.vppTonemap = false;
    caps.tonemapOpencl = filters.has('tonemap_opencl') && (await ok(tests.tonemapOpencl));
    const overlay = await ok(filters.has(hwaccel === 'qsv' ? 'overlay_qsv' : 'overlay_vaapi') ? tests.overlay : null);
    caps.overlayQsv = hwaccel === 'qsv' && overlay;
    caps.overlayVaapi = hwaccel === 'vaapi' && overlay;
    return caps;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
