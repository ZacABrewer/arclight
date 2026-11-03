import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVideoProfile, type ProfileProbes } from './profile.js';
import { clock, cueTextAt, parseVtt, playerEpisodeLine, playerHeading, resumePoint, segmentAt, upNextFrom, watchedShare } from './format.js';
import { defaultVideoLauncher, getVideoLauncher, openVideo, playHref, playSearch, setVideoLauncher } from './video-launcher.js';

describe('video-launcher', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('builds play search params and hrefs', () => {
    expect(playSearch({})).toEqual({});
    expect(playSearch({ startMs: 61_500.7, mediaFileId: 9 })).toEqual({ t: 61_500, file: 9 });
    expect(playSearch({ restart: true, startMs: 5000 })).toEqual({ restart: 1 });
    expect(playHref('movie:12')).toBe('/player/watch/play/movie:12');
    expect(playHref('episode:4', { startMs: 1000 })).toBe('/player/watch/play/episode:4?t=1000');
  });

  it('uses the router navigate by default', () => {
    const navigate = vi.fn();
    void openVideo('movie:3', { startMs: 2000, navigate });
    expect(navigate).toHaveBeenCalledWith({ to: '/player/watch/play/movie:3', search: { t: 2000 } });
    expect(getVideoLauncher()).toBe(defaultVideoLauncher);
  });

  it('lets the app swap in its own launcher and restore the default', async () => {
    const native = vi.fn(async () => undefined);
    restore = setVideoLauncher(native);
    const navigate = vi.fn();
    await openVideo('episode:8', { restart: true, navigate });
    expect(native).toHaveBeenCalledWith('episode:8', expect.objectContaining({ restart: true }));
    expect(navigate).not.toHaveBeenCalled();
    restore();
    restore = null;
    expect(getVideoLauncher()).toBe(defaultVideoLauncher);
    setVideoLauncher(native);
    setVideoLauncher(null);
    expect(getVideoLauncher()).toBe(defaultVideoLauncher);
  });
});

describe('buildVideoProfile', () => {
  const probes = (yes: string[], over: Partial<ProfileProbes> = {}): ProfileProbes => ({
    supports: (m) => yes.some((y) => m === y || m.includes(`"${y}`)),
    hdrDisplay: false,
    screenPixels: 1920,
    audioChannels: 2,
    ...over,
  });

  it('always lists mp4, h264 and aac', () => {
    const p = buildVideoProfile(probes([]));
    expect(p.containers).toEqual(['mp4']);
    expect(p.videoCodecs).toEqual(['h264']);
    expect(p.audioCodecs).toEqual(['aac']);
    expect(p.maxHeight).toBe(1080);
    expect(p.maxAudioChannels).toBe(2);
    expect(p.hdr).toEqual([]);
  });

  it('adds what the browser says it decodes', () => {
    const p = buildVideoProfile(
      probes(['video/mp4', 'video/webm', 'hvc1.1', 'hvc1.2', 'vp09', 'audio/flac', 'opus', 'ec-3'], { hdrDisplay: true, screenPixels: 3840, audioChannels: 6 }),
    );
    expect(p.containers).toEqual(['mp4', 'webm']);
    expect(p.videoCodecs).toEqual(['h264', 'hevc', 'vp9']);
    expect(p.hevc10bit).toBe(true);
    expect(p.hdr).toEqual(['hdr10', 'hlg']);
    expect(p.audioCodecs).toEqual(['aac', 'opus', 'flac', 'eac3']);
    expect(p.maxHeight).toBe(2160);
    expect(p.maxAudioChannels).toBe(6);
  });

  it('never claims HDR on an SDR display', () => {
    expect(buildVideoProfile(probes(['hvc1.2', 'dvh1'])).hdr).toEqual([]);
  });
});

describe('format helpers', () => {
  it('player titles: the series name over "S1 E3 · Episode name"', () => {
    expect(playerEpisodeLine(1, 3, 'Pilot')).toBe('S1 E3 · Pilot');
    expect(playerEpisodeLine(1, 3, null)).toBe('S1 E3');
    expect(playerEpisodeLine(null, null, 'Pilot')).toBe('Pilot');
    expect(playerHeading({ kind: 'episode', title: 'Pilot', subtitle: 'The Show' })).toBe('The Show');
    expect(playerHeading({ kind: 'episode', title: 'Pilot', subtitle: 'The Show', pause: { title: 'Show Name' } })).toBe('Show Name');
    expect(playerHeading({ kind: 'movie', title: 'A Film', subtitle: null })).toBe('A Film');
  });

  it('offers to resume only between 2 % and 90 %', () => {
    expect(resumePoint(null)).toBeNull();
    expect(resumePoint({ positionMs: 1000, durationMs: 100_000, played: false })).toBeNull();
    expect(resumePoint({ positionMs: 50_000, durationMs: 100_000, played: false })).toBe(50_000);
    expect(resumePoint({ positionMs: 95_000, durationMs: 100_000, played: false })).toBeNull();
    // 90 % is the server's played threshold: nothing left to resume from there.
    expect(resumePoint({ positionMs: 89_999, durationMs: 100_000, played: false })).toBe(89_999);
    expect(resumePoint({ positionMs: 90_000, durationMs: 100_000, played: false })).toBeNull();
    expect(resumePoint({ positionMs: 50_000, durationMs: 100_000, played: true })).toBeNull();
    expect(resumePoint({ positionMs: 50_000, durationMs: 0, played: false }, 100_000)).toBe(50_000);
  });

  it('computes watched share and clock text', () => {
    expect(watchedShare({ positionMs: 25, durationMs: 100, played: false })).toBe(0.25);
    expect(watchedShare(null, true)).toBe(1);
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_723_000)).toBe('1:02:03');
  });

  it('places the up-next card at the credits or 30 s before the end', () => {
    expect(upNextFrom([], 600_000)).toBe(570_000);
    expect(upNextFrom([{ type: 'credits', startMs: 540_000, endMs: 600_000 }], 600_000)).toBe(540_000);
    expect(upNextFrom([{ type: 'credits', startMs: 10_000, endMs: 20_000 }], 600_000)).toBe(570_000);
    expect(segmentAt([{ type: 'intro', startMs: 5000, endMs: 60_000 }], 10_000)?.type).toBe('intro');
    expect(segmentAt([{ type: 'intro', startMs: 5000, endMs: 60_000 }], 59_500)).toBeNull();
  });

  it('parses WebVTT and finds the cues at a time', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE a comment',
      '',
      '1',
      '00:00:01.000 --> 00:00:03.500 align:center',
      '<i>Hello</i> &amp; welcome',
      '',
      '00:02.000 --> 00:04.000',
      'Second line',
      'wraps',
      '',
      '00:00:09.000 --> 00:00:08.000',
      'broken',
    ].join('\r\n');
    const cues = parseVtt(vtt);
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello & welcome' },
      { startMs: 2000, endMs: 4000, text: 'Second line\nwraps' },
    ]);
    expect(cueTextAt(cues, 500)).toBe('');
    expect(cueTextAt(cues, 2500)).toBe('Hello & welcome\nSecond line\nwraps');
    expect(cueTextAt(cues, 3800)).toBe('Second line\nwraps');
  });
});
