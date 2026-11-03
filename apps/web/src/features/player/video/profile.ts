import type { VideoDelivery, VideoDeviceProfile } from '@arclight/shared';
import { browserPlaysHls } from './hls-engine.js';

// What this browser can play, sent with every video session request so the server can choose
// direct play, a remux or a transcode. Built from `MediaSource.isTypeSupported` and
// `HTMLVideoElement.canPlayType` (either one saying yes counts), the display's dynamic range and
// its size. The probes are injectable so the logic is testable without a real browser.

export interface ProfileProbes {
  /** canPlayType / isTypeSupported for a full MIME type with codecs. */
  supports: (mime: string) => boolean;
  /** `(dynamic-range: high)` matches. */
  hdrDisplay: boolean;
  /** Longest screen side in device pixels. */
  screenPixels: number;
  /** Output channels the audio device takes (AudioContext destination). */
  audioChannels: number;
}

const any = (p: ProfileProbes, mimes: readonly string[]) => mimes.some((m) => p.supports(m));

export function buildVideoProfile(p: ProfileProbes): VideoDeviceProfile {
  const hevc = any(p, ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"']);
  const hevc10bit = any(p, ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/mp4; codecs="hev1.2.4.L153.B0"']);
  const av1 = any(p, ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"']);
  const vp9 = any(p, ['video/webm; codecs="vp09.00.40.08"', 'video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.40.08"']);
  const dv = any(p, ['video/mp4; codecs="dvh1.05.06"', 'video/mp4; codecs="dvhe.05.06"']);

  const containers: string[] = [];
  if (any(p, ['video/mp4', 'video/mp4; codecs="avc1.42E01E"'])) containers.push('mp4');
  if (any(p, ['video/webm', 'video/webm; codecs="vp9"'])) containers.push('webm');
  if (any(p, ['video/x-matroska', 'video/matroska', 'video/x-matroska; codecs="avc1.42E01E"'])) containers.push('mkv');
  if (any(p, ['video/quicktime'])) containers.push('mov');
  // Every browser that has <video> plays fragmented MP4 (the remux output); say so even when the probe is shy.
  if (!containers.includes('mp4')) containers.unshift('mp4');

  // H.264 is the floor every transcode lands on, so it is always listed.
  const videoCodecs: string[] = ['h264'];
  if (hevc) videoCodecs.push('hevc');
  if (av1) videoCodecs.push('av1');
  if (vp9) videoCodecs.push('vp9');

  const hdr: VideoDeviceProfile['hdr'] = [];
  if (p.hdrDisplay && (hevc10bit || av1)) hdr.push('hdr10', 'hlg');
  if (p.hdrDisplay && dv) hdr.push('dv');

  const audioCodecs: string[] = ['aac'];
  if (any(p, ['audio/mpeg', 'audio/mp4; codecs="mp3"'])) audioCodecs.push('mp3');
  if (any(p, ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'])) audioCodecs.push('opus');
  if (any(p, ['audio/flac', 'audio/mp4; codecs="flac"'])) audioCodecs.push('flac');
  if (any(p, ['audio/mp4; codecs="ac-3"'])) audioCodecs.push('ac3');
  if (any(p, ['audio/mp4; codecs="ec-3"'])) audioCodecs.push('eac3');
  if (any(p, ['audio/mp4; codecs="dtsc"'])) audioCodecs.push('dts');
  if (any(p, ['audio/mp4; codecs="mlpa"'])) audioCodecs.push('truehd');

  const maxHeight = p.screenPixels >= 3000 ? 2160 : p.screenPixels >= 2200 ? 1440 : 1080;
  return {
    containers,
    videoCodecs,
    hevc10bit,
    hdr,
    audioCodecs,
    maxAudioChannels: p.audioChannels >= 6 ? 6 : 2,
    maxHeight,
  };
}

/** The real probes of this browser. */
export function browserProbes(): ProfileProbes {
  const video = typeof document !== 'undefined' ? document.createElement('video') : null;
  const ms = typeof window !== 'undefined' ? (window as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource : undefined;
  const supports = (mime: string) => {
    try {
      if (ms?.isTypeSupported?.(mime)) return true;
    } catch {
      // Fall through to canPlayType.
    }
    try {
      return Boolean(video?.canPlayType(mime));
    } catch {
      return false;
    }
  };
  let hdrDisplay = false;
  try {
    hdrDisplay = typeof window.matchMedia === 'function' && window.matchMedia('(dynamic-range: high)').matches;
  } catch {
    hdrDisplay = false;
  }
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const screenPixels = typeof screen !== 'undefined' ? Math.max(screen.width || 0, screen.height || 0) * dpr : 1920;
  return { supports, hdrDisplay, screenPixels, audioChannels: audioOutputChannels() };
}

/** Channels the audio output takes (5.1 over HDMI reports 6); 2 when it cannot be read. */
export function audioOutputChannels(): number {
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  if (!Ctx) return 2;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
    const n = ctx.destination.maxChannelCount;
    return Number.isFinite(n) && n > 0 ? n : 2;
  } catch {
    return 2;
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}

/** How sessions may be delivered here: HLS where hls.js (MSE / ManagedMediaSource) or native HLS works. */
export function browserDeliveries(playsHls: () => boolean = browserPlaysHls): VideoDelivery[] {
  return playsHls() ? ['hls', 'progressive'] : ['progressive'];
}

let cached: VideoDeviceProfile | null = null;

/** This browser's profile (probed once). */
export function browserVideoProfile(): VideoDeviceProfile {
  cached ??= buildVideoProfile(browserProbes());
  return cached;
}
