import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoHlsRung } from '@arclight/shared';
import { createHlsEngine, hlsConfig, lowerCap, mapLevels, parseEncodeHeader, readBandwidthHint, rungBelow, rungIdFromUrl, sizeCapRung, writeBandwidthHint } from './hls-engine.js';
import type { VideoElementLike } from './playback.js';

// A stand-in for hls.js: records what the engine asks of it and lets the test fire its events.
const fake = vi.hoisted(() => {
  type Handler = (event: string, data: unknown) => void;
  class FakeHls {
    static Events = { MANIFEST_PARSED: 'manifestParsed', LEVEL_SWITCHED: 'levelSwitched', FRAG_LOADED: 'fragLoaded', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
    static supported = true;
    static isSupported() {
      return FakeHls.supported;
    }
    static last: FakeHls | null = null;
    config: unknown;
    handlers = new Map<string, Handler[]>();
    levels: Array<{ height: number; bitrate: number; url: string[]; uri: string }> = [];
    startLevel = -1;
    currentLevel = -1;
    autoLevelCapping = -1;
    bandwidthEstimate = NaN;
    loaded: string | null = null;
    attached: unknown = null;
    startedAt: number | null = null;
    recovered = 0;
    destroyed = false;
    constructor(config: unknown) {
      this.config = config;
      FakeHls.last = this;
    }
    on(event: string, fn: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    }
    emit(event: string, data: unknown) {
      for (const fn of this.handlers.get(event) ?? []) fn(event, data);
    }
    loadSource(url: string) {
      this.loaded = url;
    }
    attachMedia(el: unknown) {
      this.attached = el;
    }
    startLoad(at: number) {
      this.startedAt = at;
    }
    recoverMediaError() {
      this.recovered += 1;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeHls };
});
vi.mock('hls.js', () => ({ default: fake.FakeHls }));

const RUNGS: VideoHlsRung[] = [
  { id: 'src', height: 2160, videoKbps: 36_000, codec: 'copy', range: 'hdr10', level: 0 },
  { id: '1080', height: 1080, videoKbps: 8000, codec: 'h264', range: 'sdr', level: 1 },
  { id: '720', height: 720, videoKbps: 4000, codec: 'h264', range: 'sdr', level: 2 },
  { id: '480', height: 480, videoKbps: 1600, codec: 'h264', range: 'sdr', level: 3 },
];
const url = (rung: string) => `http://localhost/api/v1/stream/hls/abc/${rung}/index.m3u8?u=1&exp=2&sig=s`;
// hls.js sorts levels by height, lowest first.
const LEVELS = [...RUNGS].reverse().map((r) => ({ height: r.height, bitrate: r.videoKbps * 1000, url: [url(r.id)], uri: url(r.id) }));

afterEach(() => {
  fake.FakeHls.last = null;
  fake.FakeHls.supported = true;
});

describe('hls-engine helpers', () => {
  it('builds the §4.7 config with the hint as the first estimate', () => {
    const c = hlsConfig({ startSec: 42, bandwidthKbps: 9000 });
    expect(c).toMatchObject({ startPosition: 42, maxBufferLength: 60, maxMaxBufferLength: 180, backBufferLength: 30, abrEwmaDefaultEstimate: 9_000_000, abrBandWidthFactor: 0.8, abrBandWidthUpFactor: 0.6, autoStartLoad: false, lowLatencyMode: false });
    expect(c.fragLoadPolicy?.default).toMatchObject({ maxTimeToFirstByteMs: 20_000, errorRetry: { maxNumRetry: 6 } });
    expect('abrEwmaDefaultEstimate' in hlsConfig({ startSec: 0, bandwidthKbps: null })).toBe(false);
  });

  it('finds the rung in a media playlist URL and maps sorted levels back to rungs', () => {
    expect(rungIdFromUrl(url('720'), RUNGS)).toBe('720');
    expect(rungIdFromUrl('http://x/stream/hls/abc/999/index.m3u8', RUNGS)).toBeNull();
    expect(rungIdFromUrl(undefined, RUNGS)).toBeNull();
    expect(mapLevels(LEVELS, RUNGS)).toEqual(['480', '720', '1080', 'src']);
    // No rung in the URL (a proxy rewrote it): by height, then bitrate.
    expect(mapLevels([{ height: 720, bitrate: 4_100_000 }, { height: 2160, bitrate: 36_000_000 }], RUNGS)).toEqual(['720', 'src']);
  });

  it('ranks caps (the lower wins) and finds the rung below', () => {
    expect(lowerCap(RUNGS, null, '720')).toBe('720');
    expect(lowerCap(RUNGS, '1080', '720')).toBe('720');
    expect(lowerCap(RUNGS, '480', 'src')).toBe('480');
    expect(lowerCap(RUNGS, null, null)).toBeNull();
    expect(rungBelow(RUNGS, '1080')).toBe('720');
    expect(rungBelow(RUNGS, '480')).toBeNull();
  });

  it('caps to the smallest rung that covers the player', () => {
    expect(sizeCapRung(RUNGS, 1080)).toBe('1080');
    expect(sizeCapRung(RUNGS, 700)).toBe('720');
    expect(sizeCapRung(RUNGS, 2160)).toBe('src');
    expect(sizeCapRung(RUNGS, 4320)).toBe('src');
    expect(sizeCapRung(RUNGS, 0)).toBeNull();
  });

  it('parses the X-Arclight-Encode header', () => {
    expect(parseEncodeHeader('speed=0.92;advice=720')).toEqual({ speed: 0.92, advice: '720' });
    expect(parseEncodeHeader('speed=2.4')).toEqual({ speed: 2.4, advice: null });
    expect(parseEncodeHeader(null)).toEqual({ speed: null, advice: null });
    expect(parseEncodeHeader('advice=;speed=x')).toEqual({ speed: null, advice: null });
  });

  it('keeps the bandwidth hint', () => {
    writeBandwidthHint(12_345.6);
    expect(readBandwidthHint()).toBe(12_346);
    writeBandwidthHint(null);
    expect(readBandwidthHint()).toBe(12_346);
  });
});

function element(): VideoElementLike & { clientHeight: number } {
  const el = Object.assign(new EventTarget(), {
    src: '',
    currentTime: 0,
    paused: true,
    playbackRate: 1,
    volume: 1,
    muted: false,
    error: null,
    clientHeight: 1080,
    play: () => undefined,
    pause: () => undefined,
    load: () => undefined,
    removeAttribute: () => undefined,
  });
  return el;
}

describe('createHlsEngine (hls.js)', () => {
  it('starts on the session rung at the start time, maps level events to rungs and caps ABR', async () => {
    const onRung = vi.fn();
    const onAdvice = vi.fn();
    const onUnsustainable = vi.fn();
    const onFatal = vi.fn();
    const el = element();
    const engine = await createHlsEngine(el, { url: 'http://localhost/master.m3u8', startSec: 300, rungs: RUNGS, startRung: '720', pinned: null, bandwidthKbps: 5000, onRung, onAdvice, onUnsustainable, onFatal });
    const hls = fake.FakeHls.last!;
    expect(engine).toMatchObject({ kind: 'hlsjs', controllable: true, handlesStart: true });
    expect(hls.loaded).toBe('http://localhost/master.m3u8');
    expect(hls.attached).toBe(el);
    expect(hls.startedAt).toBeNull();

    hls.levels = LEVELS;
    hls.emit('manifestParsed', {});
    expect(hls.startLevel).toBe(1);
    expect(hls.startedAt).toBe(300);
    // The player is 1080 lines tall (jsdom devicePixelRatio 1): no point in the 2160 source.
    expect(hls.autoLevelCapping).toBe(2);

    hls.emit('levelSwitched', { level: 3 });
    expect(onRung).toHaveBeenLastCalledWith('src');

    engine.cap('720');
    expect(hls.autoLevelCapping).toBe(1);
    engine.cap(null);
    expect(hls.autoLevelCapping).toBe(2);

    engine.pin('480');
    expect(hls.currentLevel).toBe(0);
    engine.pin(null);
    expect(hls.currentLevel).toBe(-1);

    hls.emit('fragLoaded', { networkDetails: { getResponseHeader: (h: string) => (h === 'x-arclight-encode' ? 'speed=0.9;advice=720' : null) } });
    expect(onAdvice).toHaveBeenCalledWith('720');

    hls.emit('error', { fatal: false, type: 'networkError', response: { code: 409 }, frag: { level: 2 } });
    expect(onUnsustainable).toHaveBeenCalledWith('1080');
    expect(onFatal).not.toHaveBeenCalled();

    // The first fatal media error is recovered in place; the next one goes to the caller.
    hls.emit('error', { fatal: true, type: 'mediaError' });
    expect(hls.recovered).toBe(1);
    expect(onFatal).not.toHaveBeenCalled();
    hls.emit('error', { fatal: true, type: 'mediaError' });
    expect(onFatal).toHaveBeenCalledWith('media');
    hls.emit('error', { fatal: true, type: 'networkError' });
    expect(onFatal).toHaveBeenLastCalledWith('network');

    hls.bandwidthEstimate = 7_654_321;
    expect(engine.bandwidthKbps()).toBe(7654);
    engine.destroy();
    expect(hls.destroyed).toBe(true);
  });

  it('applies a pin given at start once the levels are known', async () => {
    const engine = await createHlsEngine(element(), { url: 'http://localhost/master.m3u8', startSec: 0, rungs: RUNGS, startRung: '480', pinned: '480', bandwidthKbps: null });
    const hls = fake.FakeHls.last!;
    hls.levels = LEVELS;
    hls.emit('manifestParsed', {});
    expect(hls.currentLevel).toBe(0);
    expect(hls.config).not.toHaveProperty('abrEwmaDefaultEstimate');
    engine.destroy();
  });

  it('uses the browser HLS when hls.js is not supported, and fails when neither is', async () => {
    fake.FakeHls.supported = false;
    const el = Object.assign(element(), { canPlayType: (t: string) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : '') });
    const engine = await createHlsEngine(el, { url: 'http://localhost/master.m3u8', startSec: 10, rungs: RUNGS, startRung: '1080', pinned: null, bandwidthKbps: null });
    expect(engine).toMatchObject({ kind: 'native', controllable: false, handlesStart: false });
    expect(el.src).toBe('http://localhost/master.m3u8');
    await expect(createHlsEngine(element(), { url: 'x', startSec: 0, rungs: RUNGS, startRung: null, pinned: null, bandwidthKbps: null })).rejects.toMatchObject({ status: 415 });
  });
});
