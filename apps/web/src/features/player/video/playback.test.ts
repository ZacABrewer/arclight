import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressReport, VideoSession, VideoSessionRequest } from '@arclight/shared';
import { SAFE_PROFILE, VideoPlayback, type VideoElementLike } from './playback.js';
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
