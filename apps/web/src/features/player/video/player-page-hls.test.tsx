import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoHlsRung, VideoSessionRequest } from '@arclight/shared';
import { api, renderBrowse, stubFetch, type Call } from '../browse/test-utils.js';
import { readStoredQuality } from '../redesign/quality.js';
import { session, videoItem } from './test-fixtures.js';

// The player page with an HLS session: hls.js (mocked) plays the master, the quality menu is the
// session's ladder, the badge says "HLS · <rung> · <encoder>", and leaving DELETEs the session.

const fake = vi.hoisted(() => {
  class FakeHls {
    static Events = { MANIFEST_PARSED: 'manifestParsed', LEVEL_SWITCHED: 'levelSwitched', FRAG_LOADED: 'fragLoaded', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
    static isSupported = () => true;
    static last: FakeHls | null = null;
    handlers = new Map<string, Array<(e: string, d: unknown) => void>>();
    levels: Array<{ height: number; bitrate: number; url: string[]; uri: string }> = [];
    startLevel = -1;
    currentLevel = -1;
    autoLevelCapping = -1;
    bandwidthEstimate = 6_000_000;
    destroyed = false;
    constructor() {
      FakeHls.last = this;
    }
    on(e: string, fn: (e: string, d: unknown) => void) {
      this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]);
    }
    emit(e: string, d: unknown) {
      for (const fn of this.handlers.get(e) ?? []) fn(e, d);
    }
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    recoverMediaError() {}
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeHls };
});
vi.mock('hls.js', () => ({ default: fake.FakeHls }));

const RUNGS: VideoHlsRung[] = [
  { id: '1080', height: 1080, videoKbps: 8000, codec: 'h264', range: 'sdr', level: 0 },
  { id: '720', height: 720, videoKbps: 4000, codec: 'h264', range: 'sdr', level: 1 },
  { id: '360', height: 360, videoKbps: 800, codec: 'h264', range: 'sdr', level: 2 },
];
const mediaUrl = (r: string) => `http://localhost/api/v1/stream/hls/h1/${r}/index.m3u8?sig=x`;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  // An MSE browser (Chrome): HLS is offered.
  vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fake.FakeHls.last = null;
});

const ITEM = api(`/item/${encodeURIComponent('movie:7')}`);
const sessions = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.path === api('/video/session')).map((c) => c.body as VideoSessionRequest);

function routes() {
  const master = 'http://localhost/api/v1/stream/hls/h1/master.m3u8?sig=x';
  return {
    [ITEM]: videoItem(),
    [api('/progress')]: { items: [] },
    [`POST ${api('/video/session')}`]: () =>
      session({
        method: 'transcode',
        reasons: ['hdr'],
        url: master,
        mimeType: 'application/vnd.apple.mpegurl',
        delivery: 'hls',
        sessionId: 'h1',
        hls: { masterUrl: master, rungs: RUNGS, startRung: '720', healthUrl: 'http://localhost/api/v1/playback/video/session/h1/health?sig=x' },
      }),
    [api('/video/session/h1/health')]: { encodeSpeed: 4.1, aheadSec: 90, maxSustainableRung: null, hwaccel: 'qsv' },
    [`DELETE ${api('/video/session/h1')}`]: null,
    [`PUT ${api('/progress/movie%3A7')}`]: null,
  };
}

describe('VideoPlayerPage with HLS', () => {
  it('asks for HLS, shows the ladder in the quality menu, pins a rung in place and ends the session on leave', async () => {
    const calls = stubFetch(routes());
    renderBrowse('/player/watch/play/movie:7');
    await waitFor(() => expect(sessions(calls)).toHaveLength(1));
    expect(sessions(calls)[0]).toMatchObject({ deliveries: ['hls', 'progressive'] });
    expect(sessions(calls)[0]?.deviceKey).toBeTruthy();
    await waitFor(() => expect(fake.FakeHls.last).not.toBeNull());
    const hls = fake.FakeHls.last!;
    hls.levels = [...RUNGS].reverse().map((r) => ({ height: r.height, bitrate: r.videoKbps * 1000, url: [mediaUrl(r.id)], uri: mediaUrl(r.id) }));
    hls.emit('manifestParsed', {});
    expect(hls.startLevel).toBe(1);
    hls.emit('levelSwitched', { level: 1 });

    expect(await screen.findByText('HLS · 720p · QSV')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Playback settings' }));
    const quality = within(screen.getByRole('radiogroup', { name: 'Quality' }));
    expect(quality.getAllByRole('radio').map((r) => r.textContent?.replace('✓', ''))).toEqual(['Auto', '1080p', '720p', '360p']);
    expect(quality.getByRole('radio', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(quality.getByRole('radio', { name: /360p/ }));
    expect(hls.currentLevel).toBe(0);
    expect(quality.getByRole('radio', { name: /360p/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(quality.getByRole('radio', { name: /720p/ }));
    expect(hls.currentLevel).toBe(1);
    expect(readStoredQuality(null)).toBe('720p');
    // Pinning is in place: still one session.
    expect(sessions(calls)).toHaveLength(1);

    cleanup();
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === api('/video/session/h1'))).toBe(true));
    expect(hls.destroyed).toBe(true);
  });
});
