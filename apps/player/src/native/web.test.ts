import { describe, expect, it } from 'vitest';
import { ArclightPlayerWeb, browserVideoProfile } from './web';

const fakeVideo = (supported: string[]) => ({
  canPlayType: (type: string) => (supported.includes(type) ? ('probably' as const) : ('' as const)),
});

describe('browserVideoProfile', () => {
  it('is conservative when the browser reports nothing', () => {
    expect(browserVideoProfile(fakeVideo([]))).toEqual({
      containers: ['mp4', 'mov'],
      videoCodecs: ['h264'],
      hevc10bit: false,
      hdr: [],
      audioCodecs: ['aac', 'mp3'],
      maxAudioChannels: 2,
      maxHeight: 1080,
    });
    expect(browserVideoProfile(null).videoCodecs).toEqual(['h264']);
  });

  it('adds what canPlayType confirms', () => {
    const p = browserVideoProfile(
      fakeVideo([
        'video/webm',
        'video/webm; codecs="vp9"',
        'video/mp4; codecs="hvc1.1.6.L93.B0"',
        'video/mp4; codecs="hvc1.2.4.L153.B0"',
        'video/mp4; codecs="av01.0.05M.08"',
        'audio/webm; codecs="opus"',
        'audio/flac',
        'audio/mp4; codecs="ec-3"',
      ]),
    );
    expect(p.containers).toEqual(['mp4', 'mov', 'webm', 'mkv']);
    expect(p.videoCodecs).toEqual(['h264', 'hevc', 'av1', 'vp9']);
    expect(p.hevc10bit).toBe(true);
    expect(p.audioCodecs).toEqual(['aac', 'mp3', 'opus', 'flac', 'eac3']);
  });

  it('survives a canPlayType that throws', () => {
    const p = browserVideoProfile({
      canPlayType: () => {
        throw new Error('nope');
      },
    });
    expect(p.containers).toEqual(['mp4', 'mov']);
  });
});

describe('ArclightPlayerWeb video methods', () => {
  it('reports a non-TV device and leaves playback to the web player', async () => {
    const web = new ArclightPlayerWeb();
    const info = await web.getDeviceInfo();
    expect(info.isTv).toBe(false);
    expect(info.videoProfile.maxAudioChannels).toBe(2);
    await expect(web.playVideo()).rejects.toThrow(/Android/);
    await expect(web.replaceVideoStream()).rejects.toThrow(/Android/);
    await expect(web.closeVideo()).resolves.toBeUndefined();
  });
});
