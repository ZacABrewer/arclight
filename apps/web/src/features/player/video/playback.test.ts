import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressReport, VideoHlsHealth, VideoHlsRung, VideoSession, VideoSessionRequest } from '@arclight/shared';
import type { HlsEngine, HlsEngineOptions } from './hls-engine.js';
import { qualityForRung, rungForQuality, SAFE_PROFILE, STALL_LONG_MS, VideoPlayback, type VideoElementLike } from './playback.js';
import { session, videoItem } from './test-fixtures.js';

class FakeVideo extends EventTarget implements VideoElementLike {
  src = '';
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  volume = 1;
  muted = false;
  error: { code: number } | null = null;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  loads = 0;
  play() {
    this.paused = false;
    this.fire('play');
    this.fire('playing');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.fire('pause');
  }
  load() {
    this.loads += 1;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

const profile = { containers: ['mp4', 'mkv'], videoCodecs: ['h264', 'hevc'], hevc10bit: true, hdr: [], audioCodecs: ['aac', 'eac3'], maxAudioChannels: 6, maxHeight: 2160 };

function setup(sessions: (body: VideoSessionRequest) => VideoSession = () => session()) {
  const requests: VideoSessionRequest[] = [];
  const reports: ProgressReport[] = [];
  const requestSession = vi.fn(async (body: VideoSessionRequest) => {
    requests.push(body);
    return sessions(body);
  });
  const p = new VideoPlayback({
    item: videoItem(),
    profile,
    requestSession,
    sendProgress: async (_key, r) => {
      reports.push(r);
    },
    beacon: () => true,
    deviceId: 'test-device',
  });
  const el = new FakeVideo();
  p.attach(el);
  return { p, el, requests, reports };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let current: VideoPlayback | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

describe('VideoPlayback', () => {
  it('asks for a session with the device profile and plays the direct file, seeking itself', async () => {
    const { p, el, requests, reports } = setup();
    current = p;
    await p.start(120_000);
    expect(requests[0]).toMatchObject({ itemKey: 'movie:7', profile, startMs: 120_000, quality: 'auto' });
    expect(el.src).toContain('/stream/video/501');
    el.fire('loadedmetadata');
    expect(el.currentTime).toBe(120);
    expect(p.getState()).toMatchObject({ status: 'ready', playing: true, positionMs: 120_000 });
    await flush();
    expect(reports[0]).toMatchObject({ event: 'start', playMethod: 'DirectPlay' });
  });

  it('sends no seek report after the item was left mid-request (its stop is the last word)', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const { p, el, reports } = setup((body) => session({ method: 'transcode', reasons: ['audio-codec'], seekable: false, streamStartMs: body.startMs ?? 0 }));
    const inner = (p as unknown as { deps: { requestSession: (b: VideoSessionRequest) => Promise<VideoSession> } }).deps;
    const original = inner.requestSession;
    inner.requestSession = (b) => {
      calls += 1;
      if (calls === 1) return original(b);
      return new Promise<VideoSession>((resolve) => {
        release = () => resolve(session({ method: 'transcode', reasons: ['audio-codec'], seekable: false, streamStartMs: b.startMs ?? 0 }));
      });
    };
    await p.start(0);
    el.fire('loadedmetadata');
    const seeking = p.seek(600_000);
    p.dispose();
    release!();
    await seeking;
    await flush();
    const events = reports.map((r) => r.event);
    expect(events.at(-1)).toBe('stop');
    expect(events).not.toContain('seek');
  });

  it('seeks a seekable stream in place', async () => {
    const { p, el, requests } = setup();
    current = p;
    await p.start(0);
    el.fire('loadedmetadata');
    await p.seek(300_000);
    expect(requests).toHaveLength(1);
    expect(el.currentTime).toBe(300);
    expect(p.getState().positionMs).toBe(300_000);
  });

  it('re-requests a transcode from the new place and keeps the absolute clock', async () => {
    const { p, el, requests, reports } = setup((body) =>
      session({ method: 'transcode', reasons: ['audio-codec'], seekable: false, streamStartMs: body.startMs ?? 0 }),
    );
    current = p;
    await p.start(0);
    el.fire('loadedmetadata');
    await p.seek(240_000);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.startMs).toBe(240_000);
    el.fire('loadedmetadata');
    el.currentTime = 5;
    el.fire('timeupdate');
    expect(p.getState().positionMs).toBe(245_000);
    await flush();
    expect(reports.some((r) => r.event === 'seek' && r.positionMs === 240_000)).toBe(true);
    expect(reports[0]?.playMethod).toBe('Transcode');
  });

  it('sends image subtitles to burn in but draws text subtitles itself', async () => {
    const { p, el, requests } = setup((body) => session({ burnedSubtitle: body.subtitle ?? null }));
    current = p;
    await p.start(0);
    el.fire('loadedmetadata');
    await p.setSubtitle('e0');
    expect(requests).toHaveLength(1);
    expect(p.getState().subtitle).toBe('e0');
    await p.setSubtitle('e1');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.subtitle).toBe('e1');
    await p.setSubtitle(null);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.subtitle).toBeUndefined();
  });

  it('switches audio track with a new stream', async () => {
    const { p, el, requests } = setup((body) => session({ audioTrack: body.audioTrack ?? 0 }));
    current = p;
    await p.start(0);
    el.fire('loadedmetadata');
    await p.setAudioTrack(1);
    expect(requests[1]?.audioTrack).toBe(1);
    expect(p.getState().audioTrack).toBe(1);
  });

  it('retries once, then falls back to the safe profile, then reports an error', async () => {
    const { p, el, requests } = setup();
    current = p;
    await p.start(0);
    el.error = { code: 3 };
    el.fire('error');
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.profile).toEqual(profile);
    el.fire('error');
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[2]?.profile).toEqual(SAFE_PROFILE);
    el.fire('error');
    await flush();
    expect(p.getState()).toMatchObject({ status: 'error', error: 'unsupported' });
  });

  it('maps a busy server to the busy error', async () => {
    const { p } = setup(() => {
      throw Object.assign(new Error('busy'), { status: 503 });
    });
    current = p;
    await p.start(0);
    expect(p.getState()).toMatchObject({ status: 'error', error: 'busy' });
  });

  it('reports the end and calls onEnded', async () => {
    const onEnded = vi.fn();
    const reports: ProgressReport[] = [];
    const p = new VideoPlayback({
      item: videoItem(),
      profile,
      requestSession: async () => session(),
      sendProgress: async (_k, r) => {
        reports.push(r);
      },
      beacon: () => true,
      deviceId: 'test-device',
      onEnded,
    });
    current = p;
    const el = new FakeVideo();
    p.attach(el);
    await p.start(0);
    el.fire('loadedmetadata');
    el.fire('ended');
    await flush();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(p.getState().status).toBe('ended');
    expect(reports.map((r) => r.event)).toContain('stop');
  });
});

// ---- HLS sessions (playback design §4.6-4.8) -------------------------------------------

const RUNGS: VideoHlsRung[] = [
  { id: 'src', height: 2160, videoKbps: 36_000, codec: 'copy', range: 'hdr10', level: 0 },
  { id: '1080', height: 1080, videoKbps: 8000, codec: 'h264', range: 'sdr', level: 1 },
  { id: '720', height: 720, videoKbps: 4000, codec: 'h264', range: 'sdr', level: 2 },
  { id: '480', height: 480, videoKbps: 1600, codec: 'h264', range: 'sdr', level: 3 },
  { id: '360', height: 360, videoKbps: 800, codec: 'h264', range: 'sdr', level: 4 },
];

function hlsSession(id: string, over: Partial<VideoSession> = {}): VideoSession {
  const master = `http://localhost/api/v1/stream/hls/${id}/master.m3u8?sig=x`;
  return session({
    method: 'transcode',
    reasons: ['hdr'],
    url: master,
    mimeType: 'application/vnd.apple.mpegurl',
    seekable: true,
    streamStartMs: 0,
    delivery: 'hls',
    sessionId: id,
    hls: { masterUrl: master, rungs: RUNGS, startRung: '1080', healthUrl: `http://localhost/api/v1/playback/video/session/${id}/health?sig=x` },
    ...over,
  });
}

class FakeEngine implements HlsEngine {
  readonly kind = 'hlsjs' as const;
  readonly controllable = true;
  readonly handlesStart = true;
  pins: Array<string | null> = [];
  caps: Array<string | null> = [];
  destroyed = false;
  bw: number | null = 12_000;
  constructor(readonly opts: HlsEngineOptions) {}
  pin(id: string | null) {
    this.pins.push(id);
  }
  cap(id: string | null) {
    this.caps.push(id);
  }
  bandwidthKbps() {
    return this.bw;
  }
  destroy() {
    this.destroyed = true;
  }
}

function setupHls(
  sessions: (body: VideoSessionRequest, n: number) => VideoSession,
  over: { health?: VideoHlsHealth; now?: () => number; quality?: 'auto' | '720p' } = {},
) {
  const requests: VideoSessionRequest[] = [];
  const reports: ProgressReport[] = [];
  const engines: FakeEngine[] = [];
  const ended: string[] = [];
  const stored: Array<number | null> = [];
  const p = new VideoPlayback({
    item: videoItem(),
    profile,
    requestSession: async (body) => {
      requests.push(body);
      return sessions(body, requests.length);
    },
    sendProgress: async (_key, r) => {
      reports.push(r);
    },
    beacon: () => true,
    deviceId: 'test-device',
    deliveries: ['hls', 'progressive'],
    hlsEngine: async (_el, opts) => {
      const e = new FakeEngine(opts);
      engines.push(e);
      return e;
    },
    fetchHealth: async () => over.health ?? { encodeSpeed: 3, aheadSec: 60, maxSustainableRung: null, hwaccel: 'qsv' },
    endSession: (id) => ended.push(id),
    bandwidth: { read: () => 9000, write: (k) => stored.push(k) },
    ...(over.now ? { now: over.now } : {}),
    ...(over.quality ? { initial: { quality: over.quality } } : {}),
  });
  const el = new FakeVideo();
  p.attach(el);
  return { p, el, requests, reports, engines, ended, stored };
}

describe('VideoPlayback with HLS', () => {
  it('asks for HLS with a bandwidth hint and device key, and plays the master through the engine', async () => {
    const { p, el, requests, engines } = setupHls(() => hlsSession('s1'));
    current = p;
    await p.start(90_000);
    expect(requests[0]).toMatchObject({ deliveries: ['hls', 'progressive'], deviceKey: 'test-device', bandwidthKbps: 9000, startMs: 90_000 });
    expect(requests[0]?.avoidDirect).toBeUndefined();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.opts).toMatchObject({ url: expect.stringContaining('/master.m3u8'), startSec: 90, startRung: '1080', pinned: null, bandwidthKbps: 9000 });
    // The engine starts at 90 s itself: no seek on loadedmetadata, the element src is not touched.
    el.fire('loadedmetadata');
    expect(el.currentTime).toBe(0);
    expect(el.src).toBe('');
    expect(p.getState()).toMatchObject({ levelControl: true, pinnedRung: null });
  });

  it('seeks locally, forward and backward, with no new session', async () => {
    const { p, el, requests } = setupHls(() => hlsSession('s1'));
    current = p;
    await p.start(0);
    el.fire('playing');
    await p.seek(500_000);
    await p.seek(30_000);
    await p.skip(-10_000);
    expect(requests).toHaveLength(1);
    expect(el.currentTime).toBe(20);
    expect(p.getState().positionMs).toBe(20_000);
    el.currentTime = 25;
    el.fire('timeupdate');
    // Media time: no stream offset is added.
    expect(p.getState().positionMs).toBe(25_000);
  });

  it('pins a quality as a fixed level of the same session, and Auto goes back to ABR', async () => {
    const { p, el, requests, engines } = setupHls(() => hlsSession('s1'));
    current = p;
    await p.start(0);
    el.fire('playing');
    await p.setQuality('720p');
    expect(engines[0]!.pins).toEqual(['720']);
    expect(p.getState()).toMatchObject({ quality: '720p', pinnedRung: '720' });
    await p.setRung('360');
    expect(engines[0]!.pins.at(-1)).toBe('360');
    // 360 has no stored quality value: the setting keeps the last one.
    expect(p.getState()).toMatchObject({ quality: '720p', pinnedRung: '360' });
    await p.setRung(null);
    expect(engines[0]!.pins.at(-1)).toBeNull();
    expect(p.getState()).toMatchObject({ quality: 'auto', pinnedRung: null });
    expect(requests).toHaveLength(1);
  });

  it('starts pinned to the stored quality', async () => {
    const { p, engines } = setupHls(() => hlsSession('s1'), { quality: '720p' });
    current = p;
    await p.start(0);
    expect(engines[0]!.opts).toMatchObject({ pinned: '720', startRung: '720' });
    expect(p.getState().pinnedRung).toBe('720');
  });

  it('caps ABR at the server advice (health and header) and below a rung that got 409', async () => {
    const { p, el, engines } = setupHls(() => hlsSession('s1'), { health: { encodeSpeed: 0.92, aheadSec: 12, maxSustainableRung: '1080', hwaccel: 'none' } });
    current = p;
    await p.start(0);
    el.fire('playing');
    await flush();
    const e = engines[0]!;
    expect(e.caps).toEqual(['1080']);
    expect(p.getState()).toMatchObject({ capRung: '1080', health: { encodeSpeed: 0.92 } });
    e.opts.onAdvice?.('720');
    expect(e.caps.at(-1)).toBe('720');
    // A higher advice never lifts a lower cap.
    e.opts.onAdvice?.('src');
    expect(e.caps.at(-1)).toBe('720');
    e.opts.onUnsustainable?.('720');
    expect(e.caps.at(-1)).toBe('480');
    expect(p.getState().capRung).toBe('480');
  });

  it('moves a pin down when its rung is unsustainable', async () => {
    const { p, el, engines } = setupHls(() => hlsSession('s1'));
    current = p;
    await p.start(0);
    el.fire('playing');
    await p.setRung('1080');
    engines[0]!.opts.onUnsustainable?.('1080');
    expect(p.getState().pinnedRung).toBe('720');
    expect(engines[0]!.pins.at(-1)).toBe('720');
  });

  it('switching audio asks for a new session at the place, ends the old one and keeps the pin', async () => {
    let n = 0;
    const { p, el, requests, engines, ended } = setupHls(() => {
      n += 1;
      return hlsSession(`s${n}`, { audioTrack: n === 1 ? 0 : 1 });
    });
    current = p;
    await p.start(0);
    el.fire('playing');
    await p.setRung('480');
    el.currentTime = 200;
    el.fire('timeupdate');
    await p.setAudioTrack(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ audioTrack: 1, startMs: 200_000, quality: '480p', bandwidthKbps: 12_000 });
    expect(engines[0]!.destroyed).toBe(true);
    expect(ended).toEqual(['s1']);
    expect(engines[1]!.opts).toMatchObject({ startSec: 200, pinned: '480' });
  });

  it('DELETEs the session and keeps the bandwidth estimate when the item is left', async () => {
    const { p, el, engines, ended, stored } = setupHls(() => hlsSession('s9'));
    await p.start(0);
    el.fire('playing');
    p.dispose();
    expect(engines[0]!.destroyed).toBe(true);
    expect(ended).toEqual(['s9']);
    expect(stored).toContain(12_000);
  });

  it('an engine failure asks for the session again from the place', async () => {
    let n = 0;
    const { p, el, requests, engines } = setupHls(() => {
      n += 1;
      return hlsSession(`s${n}`);
    });
    current = p;
    await p.start(0);
    el.fire('playing');
    el.currentTime = 50;
    el.fire('timeupdate');
    // hls.js handles element errors itself.
    el.error = { code: 3 };
    el.fire('error');
    await flush();
    expect(requests).toHaveLength(1);
    engines[0]!.opts.onFatal?.('network');
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.startMs).toBe(50_000);
  });

  it('counts stalls after startup (not seeks, not under 0.5 s) and reports them with the startup time', async () => {
    let now = 1000;
    const { p, el, reports } = setupHls(() => hlsSession('s1'), { now: () => now });
    current = p;
    const started = p.start(0);
    now = 2400;
    await started;
    el.fire('playing');
    expect(p.getState().startupMs).toBe(1400);
    // A rebuffer of 2 s.
    el.fire('waiting');
    now += 2000;
    el.fire('playing');
    // A short one (ignored).
    el.fire('waiting');
    now += 200;
    el.fire('playing');
    // A seek's wait is not a stall.
    await p.seek(300_000);
    el.fire('seeking');
    el.fire('waiting');
    now += 4000;
    el.fire('playing');
    expect(p.getState()).toMatchObject({ stalls: 1, stallMs: 2000 });
    p.pause();
    await flush();
    expect(reports.find((r) => r.event === 'pause')).toMatchObject({ stalls: 1, stallMs: 2000, startupMs: 1400 });
  });
});

describe('direct play guard (§4.8)', () => {
  it('switches to HLS at the place after two rebuffers within 60 s, once', async () => {
    let now = 0;
    const { p, el, requests, engines } = setupHls((body) => (body.avoidDirect ? hlsSession('h1') : session()), { now: () => now });
    current = p;
    await p.start(0);
    el.fire('loadedmetadata');
    el.fire('playing');
    expect(requests[0]?.avoidDirect).toBeUndefined();
    el.currentTime = 100;
    el.fire('timeupdate');
    now = 10_000;
    el.fire('waiting');
    now = 11_000;
    el.fire('playing');
    expect(requests).toHaveLength(1);
    now = 50_000;
    el.fire('waiting');
    now = 51_000;
    el.fire('playing');
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ avoidDirect: true, startMs: 100_000, deliveries: ['hls', 'progressive'] });
    expect(engines).toHaveLength(1);
  });

  it('switches after one rebuffer longer than 3 s', async () => {
    vi.useFakeTimers();
    try {
      const { p, el, requests } = setupHls((body) => (body.avoidDirect ? hlsSession('h1') : session()));
      current = p;
      await p.start(0);
      el.fire('loadedmetadata');
      el.fire('playing');
      el.fire('waiting');
      await vi.advanceTimersByTimeAsync(STALL_LONG_MS + 10);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.avoidDirect).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays on direct play when a quality is pinned', async () => {
    vi.useFakeTimers();
    try {
      const { p, el, requests } = setupHls(() => session(), { quality: '720p' });
      current = p;
      await p.start(0);
      el.fire('loadedmetadata');
      el.fire('playing');
      el.fire('waiting');
      await vi.advanceTimersByTimeAsync(STALL_LONG_MS * 3);
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rung and quality mapping', () => {
  it('maps qualities to rungs and back', () => {
    expect(rungForQuality('auto', RUNGS)).toBeNull();
    expect(rungForQuality('original', RUNGS)).toBe('src');
    expect(rungForQuality('original', RUNGS.slice(1))).toBe('1080');
    expect(rungForQuality('1080p', RUNGS)).toBe('1080');
    expect(rungForQuality('720p', RUNGS.filter((r) => r.id !== '720'))).toBe('480');
    expect(rungForQuality('480p', [RUNGS[1]!])).toBe('1080');
    expect(qualityForRung('src')).toBe('original');
    expect(qualityForRung('720')).toBe('720p');
    expect(qualityForRung('2160')).toBeNull();
    expect(qualityForRung(null)).toBe('auto');
  });
});
