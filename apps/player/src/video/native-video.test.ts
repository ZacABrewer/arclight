import { describe, expect, it, vi } from 'vitest';
import type { PlayableItem, PlaybackProgress, ProgressReport, VideoDeviceProfile, VideoSession, VideoSessionRequest } from '@arclight/shared';
import type { ArclightPlayerPlugin } from '../native/definitions';
import { NativeVideoLauncher, defaultSubtitle, itemSubtitle, startPosition } from './native-video';

const profile = { containers: ['mp4', 'mkv'], videoCodecs: ['h264', 'hevc'] } as unknown as VideoDeviceProfile;

function episode(id: number, over: Partial<PlayableItem> = {}): PlayableItem {
  return {
    itemKey: `episode:${id}`,
    kind: 'episode',
    title: `Episode ${id}`,
    subtitle: null,
    context: 'The Show',
    artworkUrl: `http://server.example.com/art/${id}.jpg`,
    durationMs: 1_000_000,
    parts: [],
    chapters: [{ title: 'Opening', startMs: 0 } as PlayableItem['chapters'][number]],
    albumId: null,
    artistId: null,
    bookId: null,
    replayGain: null,
    seasonNumber: 1,
    episodeNumber: id,
    backdropUrl: 'blob:local-only',
    segments: [{ type: 'intro', startMs: 10_000, endMs: 70_000 }],
    video: {
      mediaFileId: 100 + id,
      versionTag: null,
      container: 'mkv',
      videoCodec: 'hevc',
      videoProfile: null,
      bitDepth: 10,
      width: 3840,
      height: 2160,
      fps: 24,
      dynamicRange: 'hdr10',
      sizeBytes: 1,
      bitrateKbps: null,
      audioTracks: [
        { index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: false },
        { index: 1, codec: 'eac3', channels: 6, language: 'eng', title: null, default: true },
      ],
      subtitleTracks: [
        { id: 'e0', source: 'embedded', codec: 'subrip', language: 'eng', title: null, forced: false, hearingImpaired: false, default: true, text: true },
        { id: 'e1', source: 'embedded', codec: 'hdmv_pgs_subtitle', language: 'deu', title: null, forced: false, hearingImpaired: false, default: false, text: false },
      ],
    },
    ...over,
  } as PlayableItem;
}

function session(req: VideoSessionRequest, over: Partial<VideoSession> = {}): VideoSession {
  const start = req.startMs ?? 0;
  return {
    itemKey: req.itemKey as VideoSession['itemKey'],
    mediaFileId: 101,
    method: 'remux',
    reasons: ['container'] as VideoSession['reasons'],
    url: `http://server.example.com/stream/video/101?s=${start}&sig=x`,
    mimeType: 'video/mp4',
    streamStartMs: start,
    seekable: false,
    durationMs: 1_000_000,
    audioTrack: req.audioTrack ?? 1,
    subtitles: [{ id: 'e0', label: 'English', language: 'eng', forced: false, default: true, url: 'http://server.example.com/sub/e0.vtt' }],
    burnedSubtitle: null,
    expiresAt: '2026-11-02T12:00:00Z',
    ...over,
  };
}

type Handler = (e: unknown) => void;

function setup(items: Record<string, PlayableItem>, progress: PlaybackProgress | null = null) {
  const handlers = new Map<string, Handler>();
  const plugin = {
    addListener: vi.fn(async (name: string, fn: Handler) => {
      handlers.set(name, fn);
      return { remove: vi.fn(async () => handlers.delete(name)) };
    }),
    playVideo: vi.fn(async (_o: unknown) => undefined),
    replaceVideoStream: vi.fn(async (_o: unknown) => undefined),
    closeVideo: vi.fn(async () => undefined),
  };
  const reports: Array<{ key: string; report: ProgressReport }> = [];
  const requests: VideoSessionRequest[] = [];
  const deps = {
    plugin: plugin as unknown as ArclightPlayerPlugin,
    profile: vi.fn(async () => profile),
    fetchItem: vi.fn(async (key: string) => {
      const it = items[key];
      if (!it) throw new Error('not found');
      return it;
    }),
    fetchProgress: vi.fn(async () => progress),
    requestSession: vi.fn(async (req: VideoSessionRequest) => {
      requests.push(req);
      return session(req);
    }),
    sendProgress: vi.fn(async (key: string, report: ProgressReport) => {
      reports.push({ key, report });
    }),
    markPlayed: vi.fn(async () => undefined),
    pauseAudio: vi.fn(),
    refresh: vi.fn(),
    onError: vi.fn(),
    deviceId: 'device-1',
    now: () => new Date('2026-11-02T10:00:00Z'),
  };
  const launcher = new NativeVideoLauncher(deps);
  const emit = async (name: string, e: unknown) => {
    handlers.get(name)?.(e);
    await vi.waitFor(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { launcher, plugin, deps, reports, requests, emit, handlers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('start position and labels', () => {
  const ep = episode(1);
  it('restart → 0, an explicit time wins, else a resume point between 2% and 90%', () => {
    const saved = { positionMs: 300_000, durationMs: 1_000_000, played: false } as PlaybackProgress;
    expect(startPosition({ restart: true }, saved, 1_000_000)).toBe(0);
    expect(startPosition({ startMs: 42_500.7 }, saved, 1_000_000)).toBe(42_500);
    expect(startPosition({}, saved, 1_000_000)).toBe(300_000);
    expect(startPosition({}, { ...saved, positionMs: 5_000 }, 1_000_000)).toBe(0);
    expect(startPosition({}, { ...saved, positionMs: 950_000 }, 1_000_000)).toBe(0);
    expect(startPosition({}, null, 1_000_000)).toBe(0);
  });

  it('starts with the default text subtitle; image subtitles never by default', () => {
    expect(defaultSubtitle(ep)).toBe('e0');
    const noText = episode(2, { video: { ...ep.video!, subtitleTracks: [ep.video!.subtitleTracks[1]!] } });
    expect(defaultSubtitle(noText)).toBeNull();
  });

  it('episode subtitle line carries the code and the show', () => {
    expect(itemSubtitle(ep)).toContain('The Show');
  });

  it('does not repeat a server subtitle that is only the episode code', () => {
    const line = itemSubtitle(episode(3, { subtitle: 'S1:E3', context: null }));
    expect(line).toBeTruthy();
    expect(line!.replace(/[^a-z0-9]/gi, '').toLowerCase()).toBe('s1e3');
  });
});

describe('NativeVideoLauncher', () => {
  it('asks for a session with the native profile and hands everything to playVideo', async () => {
    const { launcher, plugin, deps, requests, reports } = setup({ 'episode:1': episode(1, { next: 'episode:2' }), 'episode:2': episode(2) });
    await launcher.start();
    expect(plugin.addListener).toHaveBeenCalledTimes(4);
    await launcher.launch('episode:1');
    expect(deps.pauseAudio).toHaveBeenCalled();
    expect(requests[0]).toMatchObject({ itemKey: 'episode:1', profile, audioTrack: 1 });
    // Text subtitles are side-loaded, never sent for burning in.
    expect(requests[0]!.subtitle).toBeUndefined();
    const opts = plugin.playVideo.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({
      itemKey: 'episode:1',
      url: expect.stringContaining('/stream/video/101'),
      mimeType: 'video/mp4',
      streamStartMs: 0,
      startPositionMs: 0,
      seekable: false,
      selectedSubtitle: 'e0',
      selectedAudio: 1,
      chapters: [{ title: 'Opening', startMs: 0 }],
      segments: [{ type: 'intro', startMs: 10_000, endMs: 70_000 }],
      artworkUrl: 'http://server.example.com/art/1.jpg',
      next: { itemKey: 'episode:2', title: 'Episode 2' },
    });
    expect(opts.backdropUrl).toBeUndefined(); // only http(s) URLs reach the native side
    expect((opts.audioTracks as unknown[]).length).toBe(2);
    expect((opts.subtitles as Array<{ id: string }>)[0]!.id).toBe('e0');
    expect(reports.map((r) => r.report.event)).toEqual(['start']);
    expect(reports[0]!.report).toMatchObject({ deviceId: 'device-1', playMethod: 'Transcode', clientTime: '2026-11-02T10:00:00.000Z' });
    expect(launcher.playing).toMatchObject({ itemKey: 'episode:1', method: 'remux' });
  });

  it('resumes from the saved place and starts the stream there', async () => {
    const { launcher, plugin, requests } = setup({ 'episode:1': episode(1) }, { positionMs: 400_000, durationMs: 1_000_000, played: false } as PlaybackProgress);
    await launcher.start();
    await launcher.launch('episode:1');
    expect(requests[0]!.startMs).toBe(400_000);
    expect(plugin.playVideo.mock.calls[0]![0]).toMatchObject({ startPositionMs: 400_000, streamStartMs: 400_000 });
  });

  it('answers a seek request with a new session and replaceVideoStream; the latest seek wins', async () => {
    const { launcher, plugin, deps, emit, reports } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    let release: (() => void) | null = null;
    deps.requestSession.mockImplementationOnce(
      (req: VideoSessionRequest) =>
        new Promise<VideoSession>((resolve) => {
          release = () => resolve(session(req));
        }),
    );
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 100_000 });
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 600_000, audioTrack: 0 });
    release!();
    await flush();
    expect(plugin.replaceVideoStream).toHaveBeenCalledTimes(1);
    expect(plugin.replaceVideoStream.mock.calls[0]![0]).toMatchObject({ positionMs: 600_000, streamStartMs: 600_000, selectedAudio: 0 });
    expect(typeof (plugin.replaceVideoStream.mock.calls[0]![0] as { streamInfo?: unknown }).streamInfo).toBe('string');
    const last = deps.requestSession.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ startMs: 600_000, audioTrack: 0 });
    expect(reports.at(-1)!.report).toMatchObject({ event: 'seek', positionMs: 600_000 });
  });

  it('asks the server to burn in an image subtitle picked in the player', async () => {
    const { launcher, deps, emit } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 50_000, subtitle: 'e1' });
    expect(deps.requestSession.mock.calls.at(-1)![0]).toMatchObject({ subtitle: 'e1', startMs: 50_000 });
  });

  it('reports progress, and a pause once', async () => {
    const { launcher, emit, reports } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoProgress', { itemKey: 'episode:1', positionMs: 20_000, durationMs: 1_000_000, paused: false });
    await emit('videoProgress', { itemKey: 'episode:1', positionMs: 25_000, durationMs: 1_000_000, paused: true });
    await emit('videoProgress', { itemKey: 'episode:1', positionMs: 25_000, durationMs: 1_000_000, paused: true });
    await emit('videoProgress', { itemKey: 'other:1', positionMs: 1, durationMs: 1, paused: false });
    expect(reports.map((r) => r.report.event)).toEqual(['start', 'progress', 'pause']);
    expect(reports[1]!.report.positionMs).toBe(20_000);
  });

  it('up next: stops and marks this one played, then loads the next in place', async () => {
    const { launcher, plugin, deps, emit, reports } = setup({ 'episode:1': episode(1, { next: 'episode:2' }), 'episode:2': episode(2) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoNext', { itemKey: 'episode:2' });
    await flush();
    expect(deps.markPlayed).toHaveBeenCalledWith('episode:1');
    expect(reports.find((r) => r.key === 'episode:1' && r.report.event === 'stop')!.report.positionMs).toBe(1_000_000);
    expect(plugin.playVideo).toHaveBeenCalledTimes(2);
    expect(plugin.playVideo.mock.calls[1]![0]).toMatchObject({ itemKey: 'episode:2' });
    expect(launcher.playing?.itemKey).toBe('episode:2');
    expect(deps.refresh).toHaveBeenCalled();
  });

  it('closes the player when the next item cannot load', async () => {
    const { launcher, plugin, deps, emit } = setup({ 'episode:1': episode(1, { next: 'episode:9' }) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoNext', { itemKey: 'episode:9' });
    await flush();
    expect(plugin.closeVideo).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalled();
  });

  it('on close: final report, played when completed, refresh', async () => {
    const { launcher, deps, emit, reports } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoClosed', { itemKey: 'episode:1', positionMs: 990_000, durationMs: 1_000_000, completed: true });
    expect(reports.at(-1)!.report).toMatchObject({ event: 'stop', positionMs: 990_000 });
    expect(deps.markPlayed).toHaveBeenCalledWith('episode:1');
    expect(deps.refresh).toHaveBeenCalled();
    expect(launcher.playing).toBeNull();
  });

  it('a close with an error shows the message and does not mark played', async () => {
    const { launcher, deps, emit } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoClosed', { itemKey: 'episode:1', positionMs: 1_000, durationMs: 1_000_000, completed: false, error: 'decoder' });
    expect(deps.markPlayed).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it('a failed start surfaces the error and rethrows', async () => {
    const { launcher, deps } = setup({});
    await launcher.start();
    await expect(launcher.launch('episode:5')).rejects.toThrow('not found');
    expect(deps.onError).toHaveBeenCalledWith('not found');
  });

  it('stop() removes the listeners', async () => {
    const { launcher, handlers } = setup({});
    await launcher.start();
    expect(handlers.size).toBe(4);
    await launcher.stop();
    expect(handlers.size).toBe(0);
  });
});
