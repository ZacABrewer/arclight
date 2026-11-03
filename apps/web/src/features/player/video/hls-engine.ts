import type { VideoHlsRung } from '@arclight/shared';
import type HlsType from 'hls.js';
import type { ErrorData, FragLoadedData, HlsConfig, Level, LevelSwitchedData } from 'hls.js';
import { browserName, readStored, writeStored } from '../device.js';
import type { VideoElementLike } from './playback.js';

// HLS for the web video player (playback design §4.7): hls.js where the browser has Media Source
// Extensions (Chrome, Firefox, Edge), the browser's own HLS where it has none (Safari on iOS).
// hls.js is loaded with a dynamic import, so its chunk is only fetched for an HLS session.
//
// The engine maps hls.js levels to the session's ladder rungs (hls.js sorts levels by height, so
// the master playlist order is not its index order; the rung id is in each level's URL), pins a
// rung or lets ABR pick, caps ABR at the best rung the server can sustain (health advice, the
// X-Arclight-Encode header, a 409 RUNG_UNSUSTAINABLE), and hands its bandwidth estimate back so
// the next session starts on a fitting rung.

export interface HlsEngineEvents {
  /** The rung now playing (null: not known yet / native HLS). */
  onRung?: (rungId: string | null) => void;
  /** The server advised a cap (`X-Arclight-Encode: speed=0.92;advice=720`). */
  onAdvice?: (rungId: string) => void;
  /** A segment of this rung got 409 RUNG_UNSUSTAINABLE. */
  onUnsustainable?: (rungId: string) => void;
  /** Playback cannot go on with this engine (the caller asks for a new session). */
  onFatal?: (kind: 'network' | 'media' | 'other') => void;
}

export interface HlsEngineOptions extends HlsEngineEvents {
  url: string;
  /** Media time to start at, seconds. */
  startSec: number;
  /** The session's rungs, best first. */
  rungs: readonly VideoHlsRung[];
  /** Rung to start on (a pin, or the session's startRung). */
  startRung: string | null;
  /** Rung pinned by the user (ABR off); null: Auto. */
  pinned: string | null;
  /** Throughput hint for the first ABR estimate. */
  bandwidthKbps: number | null;
}

export interface HlsEngine {
  readonly kind: 'hlsjs' | 'native';
  /** Levels can be pinned and capped (false for the browser's own HLS). */
  readonly controllable: boolean;
  /** The engine seeks to `startSec` itself (the caller must not seek on loadedmetadata). */
  readonly handlesStart: boolean;
  /** Pin a rung (null: Auto / ABR). */
  pin(rungId: string | null): void;
  /** Never let ABR go above this rung (null: no cap). */
  cap(rungId: string | null): void;
  /** Smoothed throughput, kbit/s; null before the first segment. */
  bandwidthKbps(): number | null;
  destroy(): void;
}

export type HlsEngineFactory = (el: VideoElementLike, opts: HlsEngineOptions) => Promise<HlsEngine>;

// ---- pure helpers (tested) -------------------------------------------------------------

/** The hls.js config for a session (§4.7). Player-size capping is done by the engine (see `sizeCapRung`). */
export function hlsConfig(opts: { startSec: number; bandwidthKbps: number | null }): Partial<HlsConfig> {
  const retry = {
    maxTimeToFirstByteMs: 20_000,
    maxLoadTimeMs: 60_000,
    timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 },
    errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
  };
  return {
    autoStartLoad: false,
    startPosition: Math.max(0, opts.startSec),
    maxBufferLength: 60,
    maxMaxBufferLength: 180,
    maxBufferSize: 150e6,
    backBufferLength: 30,
    ...(opts.bandwidthKbps && opts.bandwidthKbps > 0 ? { abrEwmaDefaultEstimate: opts.bandwidthKbps * 1000 } : {}),
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.6,
    abrEwmaFastVoD: 3,
    abrEwmaSlowVoD: 9,
    // hls.js's own player-size capping rewrites autoLevelCapping every second, which would
    // undo the server's advice; the engine combines both caps itself instead.
    capLevelToPlayerSize: false,
    startFragPrefetch: true,
    testBandwidth: true,
    fragLoadPolicy: { default: retry },
    lowLatencyMode: false,
    enableWorker: true,
  };
}

/** The rung id in a media playlist URL (`.../stream/hls/<session>/<rung>/index.m3u8?...`). */
export function rungIdFromUrl(url: string | undefined, rungs: readonly VideoHlsRung[]): string | null {
  if (!url) return null;
  const m = /\/([^/?#]+)\/index\.m3u8(?:[?#]|$)/.exec(url);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  return rungs.some((r) => r.id === id) ? id : null;
}

/** For each hls.js level (its index order), the rung it plays; by URL, else by height and bitrate. */
export function mapLevels(levels: ReadonlyArray<Pick<Level, 'height' | 'bitrate'> & { url?: string[]; uri?: string }>, rungs: readonly VideoHlsRung[]): Array<string | null> {
  const used = new Set<string>();
  const out = levels.map((l) => {
    const id = rungIdFromUrl(l.uri ?? l.url?.[0], rungs);
    if (id) used.add(id);
    return id;
  });
  return out.map((id, i) => {
    if (id) return id;
    const l = levels[i]!;
    const byHeight = rungs.filter((r) => !used.has(r.id) && r.height === l.height);
    const pick = byHeight.length > 1 ? byHeight.reduce((a, b) => (Math.abs(a.videoKbps * 1000 - l.bitrate) <= Math.abs(b.videoKbps * 1000 - l.bitrate) ? a : b)) : byHeight[0];
    if (!pick) return null;
    used.add(pick.id);
    return pick.id;
  });
}

/** Position of a rung in the ladder (0 = best); -1 when it is not offered. */
export function rungRank(rungs: readonly VideoHlsRung[], id: string | null): number {
  return id === null ? -1 : rungs.findIndex((r) => r.id === id);
}

/** The next rung below `id` (null when it is the lowest). */
export function rungBelow(rungs: readonly VideoHlsRung[], id: string): string | null {
  const i = rungRank(rungs, id);
  return i >= 0 && i + 1 < rungs.length ? rungs[i + 1]!.id : null;
}

/** The lower (worse) of two caps; null = no cap. */
export function lowerCap(rungs: readonly VideoHlsRung[], a: string | null, b: string | null): string | null {
  const ra = rungRank(rungs, a);
  const rb = rungRank(rungs, b);
  if (ra < 0) return rb < 0 ? null : b;
  if (rb < 0) return a;
  return ra >= rb ? a : b;
}

/**
 * The smallest rung at least as tall as the player (hls.js `capLevelToPlayerSize`): there is
 * no point fetching 2160 lines for a 1080-line screen. null: no cap (size unknown).
 */
export function sizeCapRung(rungs: readonly VideoHlsRung[], playerHeightPx: number): string | null {
  if (!(playerHeightPx > 0) || rungs.length === 0) return null;
  const fits = rungs.filter((r) => r.height >= playerHeightPx * 0.9);
  // Best first: the last one that still fits is the smallest that covers the player.
  return fits.length ? fits[fits.length - 1]!.id : rungs[0]!.id;
}

/** `X-Arclight-Encode: speed=0.92;advice=720` → { speed: 0.92, advice: '720' }. */
export function parseEncodeHeader(value: string | null | undefined): { speed: number | null; advice: string | null } {
  const out = { speed: null as number | null, advice: null as string | null };
  if (!value) return out;
  for (const part of value.split(';')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k || v === undefined || v === '') continue;
    if (k === 'speed') {
      const n = Number(v);
      if (Number.isFinite(n)) out.speed = n;
    } else if (k === 'advice') out.advice = v;
  }
  return out;
}

// ---- bandwidth hint (per server and network type, §4.7) ------------------------------------

const BANDWIDTH_KEY = 'arclight.video.bandwidth.';

function networkType(): string {
  const c = typeof navigator !== 'undefined' ? (navigator as { connection?: { type?: string; effectiveType?: string } }).connection : undefined;
  return (c?.type && c.type !== 'unknown' ? c.type : c?.effectiveType) || 'any';
}

/** Last measured throughput on this kind of network (storage is per origin, so per server). */
export function readBandwidthHint(): number | null {
  const n = Number(readStored(BANDWIDTH_KEY + networkType()));
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

export function writeBandwidthHint(kbps: number | null): void {
  if (kbps === null || !Number.isFinite(kbps) || kbps < 1) return;
  writeStored(BANDWIDTH_KEY + networkType(), String(Math.round(Math.min(kbps, 10_000_000))));
}

// ---- engines ---------------------------------------------------------------------------

/** Can this browser play HLS at all (hls.js on MSE / ManagedMediaSource, or natively)? */
export function browserPlaysHls(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as { MediaSource?: { isTypeSupported?: (t: string) => boolean }; ManagedMediaSource?: { isTypeSupported?: (t: string) => boolean } };
  const mse = w.ManagedMediaSource ?? w.MediaSource;
  try {
    if (mse?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')) return true;
  } catch {
    // Fall through to native HLS.
  }
  return nativeHls();
}

function nativeHls(el?: { canPlayType?: (t: string) => string }): boolean {
  try {
    const v = el ?? (typeof document !== 'undefined' ? document.createElement('video') : null);
    return !!v?.canPlayType?.('application/vnd.apple.mpegurl');
  } catch {
    return false;
  }
}

/** The browser's own HLS (Safari without MSE): no level control; the server's 409 is the safety net. */
function nativeEngine(el: VideoElementLike, opts: HlsEngineOptions): HlsEngine {
  el.src = opts.url;
  el.load();
  opts.onRung?.(null);
  return {
    kind: 'native',
    controllable: false,
    handlesStart: false,
    pin: () => undefined,
    cap: () => undefined,
    bandwidthKbps: () => null,
    destroy: () => undefined,
  };
}

function hlsJsEngine(Hls: typeof HlsType, el: HTMLMediaElement, opts: HlsEngineOptions): HlsEngine {
  const hls = new Hls(hlsConfig(opts));
  const rungs = opts.rungs;
  let levelRung: Array<string | null> = [];
  let adviceCap: string | null = null;
  let pinned = opts.pinned;
  let mediaErrors = 0;
  let destroyed = false;

  const levelOf = (id: string | null) => (id === null ? -1 : levelRung.indexOf(id));
  const playerHeight = () => {
    const h = (el as HTMLElement).clientHeight || 0;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return h * dpr;
  };
  const applyCap = () => {
    if (destroyed || !levelRung.length) return;
    const capId = lowerCap(rungs, adviceCap, sizeCapRung(rungs, playerHeight()));
    hls.autoLevelCapping = levelOf(capId);
  };

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    levelRung = mapLevels(hls.levels, rungs);
    const start = levelOf(opts.startRung);
    if (start >= 0) hls.startLevel = start;
    applyCap();
    if (pinned !== null && levelOf(pinned) >= 0) hls.currentLevel = levelOf(pinned);
    hls.startLoad(Math.max(0, opts.startSec));
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_e: unknown, data: LevelSwitchedData) => opts.onRung?.(levelRung[data.level] ?? null));
  hls.on(Hls.Events.FRAG_LOADED, (_e: unknown, data: FragLoadedData) => {
    const xhr = data.networkDetails as { getResponseHeader?: (h: string) => string | null } | null;
    let header: string | null = null;
    try {
      header = xhr?.getResponseHeader?.('x-arclight-encode') ?? null;
    } catch {
      header = null;
    }
    const { advice } = parseEncodeHeader(header);
    if (advice) opts.onAdvice?.(advice);
  });
  hls.on(Hls.Events.ERROR, (_e: unknown, data: ErrorData) => {
    if (data.response?.code === 409 && data.frag) {
      const id = levelRung[data.frag.level] ?? null;
      if (id) opts.onUnsustainable?.(id);
    }
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrors === 0) {
      // The first decode hiccup is usually recoverable in place (hls.js guidance).
      mediaErrors += 1;
      hls.recoverMediaError();
      return;
    }
    opts.onFatal?.(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'media' : 'other');
  });

  const onResize = () => applyCap();
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);

  hls.loadSource(opts.url);
  hls.attachMedia(el);

  return {
    kind: 'hlsjs',
    controllable: true,
    handlesStart: true,
    pin(id) {
      pinned = id;
      if (!levelRung.length) return;
      hls.currentLevel = levelOf(id);
    },
    cap(id) {
      adviceCap = id;
      applyCap();
    },
    bandwidthKbps() {
      const bps = hls.bandwidthEstimate;
      return Number.isFinite(bps) && bps > 0 ? Math.round(bps / 1000) : null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
      hls.destroy();
    },
  };
}

/**
 * The real factory: Safari uses its own HLS (Apple's player, best there); every other browser
 * gets hls.js (lazy chunk) on Media Source Extensions, or native HLS when it has no MSE.
 */
export const createHlsEngine: HlsEngineFactory = async (el, opts) => {
  if (browserName() === 'Safari' && nativeHls(el as unknown as HTMLVideoElement)) return nativeEngine(el, opts);
  const { default: Hls } = await import('hls.js');
  if (Hls.isSupported()) return hlsJsEngine(Hls, el as unknown as HTMLMediaElement, opts);
  if (nativeHls(el as unknown as HTMLVideoElement)) return nativeEngine(el, opts);
  throw Object.assign(new Error('HLS is not supported in this browser'), { status: 415 });
};
