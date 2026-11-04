import { describe, expect, it, vi } from 'vitest';
import type { PlayableItem, PlaybackProgress, ProgressReport, VideoDeviceProfile, VideoSession, VideoSessionRequest } from '@arclight/shared';
import type { ArclightPlayerPlugin } from '../native/definitions';
import { NativeVideoLauncher, defaultSubtitle, itemSubtitle, itemTitles, safeProfile, startPosition } from './native-video';
import { readBandwidth, writeBandwidth } from './bandwidth';
import { ProfileSettings, type PlayerSeriesDetails } from '@arclight/shared';
import { episodeLine, normLanguage, pauseInfo, preferredSubtitle, seasonsOf, themeFrom, toHex, trickplayOf, videoStrings } from './native-extras';

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
    delivery: 'progressive',
    sessionId: null,
    ...over,
  };
}

type Handler = (e: unknown) => void;

function setup(items: Record<string, PlayableItem>, progress: PlaybackProgress | null = null, extra: Record<string, unknown> = {}) {
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
    ...extra,
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

  it('episodes: the series name is the title, "S1 E3 · Episode name" the line under it', () => {
    // The server's shape: subtitle = the series, context = the code.
    const e3 = episode(3, { title: 'The Long Meridian', subtitle: 'The Show', context: 'S1:E3', seasonNumber: 1, episodeNumber: 3 });
    expect(itemTitles(e3)).toEqual({ title: 'The Show', subtitle: 'S1 E3 · The Long Meridian' });
    // The pause info's names win when present.
    const paused = { ...e3, pause: { title: 'Show (2024)', episodeTitle: 'Meridian' } as PlayableItem['pause'] };
    expect(itemTitles(paused)).toEqual({ title: 'Show (2024)', subtitle: 'S1 E3 · Meridian' });
    // No series name: the episode title stays the title and the line is just the code.
    expect(itemTitles(episode(4, { title: 'Four', subtitle: null, context: 'S1:E4' }))).toEqual({ title: 'Four', subtitle: 'S1 E4' });
  });

  it('movies keep their title over the year', () => {
    const movie = { ...episode(5), kind: 'movie', title: 'A Film', year: 2024, subtitle: null } as PlayableItem;
    expect(itemTitles(movie)).toEqual({ title: 'A Film', subtitle: '2024' });
  });
});

describe('NativeVideoLauncher', () => {
  it('asks for a session with the native profile and hands everything to playVideo', async () => {
    const { launcher, plugin, deps, requests, reports } = setup({ 'episode:1': episode(1, { next: 'episode:2' }), 'episode:2': episode(2) });
    await launcher.start();
    expect(plugin.addListener).toHaveBeenCalledTimes(7);
    await launcher.launch('episode:1');
    expect(deps.pauseAudio).toHaveBeenCalled();
    expect(requests[0]).toMatchObject({ itemKey: 'episode:1', profile, audioTrack: 1, quality: 'auto' });
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
    // Enough for native to match the file's own tracks to these in direct play.
    expect((opts.audioTracks as unknown[])[1]).toMatchObject({ index: 1, language: 'eng', codec: 'eac3', channels: 6, title: null });
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

  it('hands a detected recap to the native player with its Skip recap label', async () => {
    const segments: PlayableItem['segments'] = [
      { type: 'recap', startMs: 0, endMs: 42_000 },
      { type: 'intro', startMs: 42_000, endMs: 92_000 },
    ];
    const { launcher, plugin } = setup({ 'episode:1': episode(1, { segments }) });
    await launcher.start();
    await launcher.launch('episode:1');
    expect(plugin.playVideo.mock.calls[0]![0]).toMatchObject({ segments });
    expect(videoStrings().skipRecap).toBe('Skip recap');
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

  it('"Next episode" before the credits (completed: false) saves the place and does not mark played', async () => {
    const { launcher, plugin, deps, emit, reports } = setup({ 'episode:1': episode(1, { next: 'episode:2' }), 'episode:2': episode(2) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoProgress', { itemKey: 'episode:1', positionMs: 120_000, durationMs: 1_000_000, paused: false });
    await emit('videoNext', { itemKey: 'episode:2', completed: false });
    await flush();
    expect(deps.markPlayed).not.toHaveBeenCalled();
    const stops = reports.filter((r) => r.key === 'episode:1' && r.report.event === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.report.positionMs).toBe(120_000);
    expect(plugin.playVideo).toHaveBeenCalledTimes(2);
  });

  it('a close while the next episode loads keeps the player closed (no reopen, no second stop)', async () => {
    const { launcher, plugin, deps, emit, reports } = setup({ 'episode:1': episode(1, { next: 'episode:2' }), 'episode:2': episode(2) });
    await launcher.start();
    await launcher.launch('episode:1');
    let markDone: (() => void) | null = null;
    deps.markPlayed.mockImplementationOnce(() => new Promise<undefined>((resolve) => (markDone = () => resolve(undefined))));
    await emit('videoNext', { itemKey: 'episode:2' });
    // Back pressed on the spinner: the native side closes with the old item's key.
    await emit('videoClosed', { itemKey: 'episode:1', positionMs: 1_000_000, durationMs: 1_000_000, completed: true });
    markDone!();
    await flush();
    await flush();
    expect(plugin.playVideo).toHaveBeenCalledTimes(1);
    expect(reports.filter((r) => r.key === 'episode:1' && r.report.event === 'stop')).toHaveLength(1);
    expect(launcher.playing).toBeNull();
  });

  it('a seek the server refuses closes the player instead of leaving it waiting', async () => {
    const { launcher, plugin, deps, emit } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    deps.requestSession.mockRejectedValueOnce(new Error('busy'));
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 300_000 });
    await flush();
    expect(plugin.replaceVideoStream).not.toHaveBeenCalled();
    expect(plugin.closeVideo).toHaveBeenCalledTimes(1);
    expect(deps.onError).toHaveBeenCalledWith('busy');
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
    expect(handlers.size).toBe(7);
    await launcher.stop();
    expect(handlers.size).toBe(0);
  });

  it('fills the redesign extras: pause info, trickplay, seasons, prefs, theme and strings', async () => {
    const show = {
      seasons: [
        {
          seasonNumber: 1,
          title: 'Season 1',
          episodeCount: 2,
          playedCount: 1,
          episodes: [
            { itemKey: 'episode:1', id: 1, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', overview: 'o', airDate: null, runtimeMinutes: 45, thumbUrl: 'http://server.example.com/t1.jpg', progress: null, played: true },
            { itemKey: 'episode:2', id: 2, seasonNumber: 1, episodeNumber: 2, title: null, overview: null, airDate: null, runtimeMinutes: null, thumbUrl: null, progress: { positionMs: 250, durationMs: 1000, played: false }, played: false },
          ],
        },
      ],
    } as unknown as PlayerSeriesDetails;
    const settings = ProfileSettings.parse({ subtitleSize: 'large', skipIntros: true, focusStyle: 'cyan-glow' });
    const theme = { bg: '#000000', text: '#ffffff', text2: '#cccccc', text3: '#aaaaaa', accent: '#00ffff', primaryBg: '#ffffff', primaryText: '#000000', radiusButton: 0, radiusTile: 0 };
    const item = episode(1, {
      seriesId: 7,
      pause: { title: 'The Show', episodeTitle: 'Pilot', seasonNumber: 1, episodeNumber: 1, year: 2024, certification: 'TV-14', tmdbScore: 8, genres: [], overview: 'Ov', logoUrl: null, backdropUrl: 'http://server.example.com/b.jpg', chips: null },
    } as Partial<PlayableItem>);
    const fetchSeries = vi.fn(async () => show);
    const { launcher, plugin, deps } = setup({ 'episode:1': item }, null, {
      profileSettings: async () => settings,
      fetchSeries,
      theme: () => theme,
    });
    deps.requestSession.mockImplementation(async (req: VideoSessionRequest) =>
      session(req, { trickplay: { mediaFileId: 101, status: 'ready', intervalMs: 10_000, tileWidth: 320, tileHeight: 180, columns: 10, rows: 10, tileCount: 50, sheets: ['http://server.example.com/s0.jpg'] } }),
    );
    await launcher.start();
    await launcher.launch('episode:1');
    expect(fetchSeries).toHaveBeenCalledWith(7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = plugin.playVideo.mock.calls[0]![0] as unknown as Record<string, any>;
    expect(opts.pause).toMatchObject({ title: 'The Show', episodeLine: 'S1 E1 · Pilot', overview: 'Ov', backdropUrl: 'http://server.example.com/b.jpg' });
    expect(opts.pause.meta).toEqual([{ text: '2024' }, { text: 'TV-14', boxed: true }, { text: '17m' }]);
    expect(opts.trickplay).toMatchObject({ intervalMs: 10_000, sheets: ['http://server.example.com/s0.jpg'] });
    expect(opts.seasons[0].episodes[0]).toMatchObject({ title: '1. Pilot', runtime: '45m', progress: 1, played: true });
    expect(opts.seasons[0].episodes[1]).toMatchObject({ progress: 0.25, thumbUrl: null });
    expect(opts.currentSeason).toBe(1);
    expect(opts.prefs).toEqual({ subtitleSize: 'large', skipIntros: true, autoplayNext: true, focusStyle: 'cyan-glow', reduceMotion: false });
    expect(opts.theme).toEqual(theme);
    expect(Object.keys(opts.strings)).toContain('skipCredits');
    // Subtitles off on the profile: none at start (the file's default text track is not forced).
    expect(opts.selectedSubtitle).toBeNull();
  });

  it('videoPickItem stops this episode where it was and opens the picked one', async () => {
    const { launcher, plugin, reports, emit, deps } = setup({ 'episode:1': episode(1), 'episode:3': episode(3) });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoPickItem', { itemKey: 'episode:3', fromItemKey: 'episode:1', positionMs: 300_000 });
    await flush();
    expect(reports.map((r) => [r.key, r.report.event])).toEqual([
      ['episode:1', 'start'],
      ['episode:1', 'stop'],
      ['episode:3', 'start'],
    ]);
    expect(reports[1]!.report.positionMs).toBe(300_000);
    expect(deps.markPlayed).not.toHaveBeenCalled();
    expect((plugin.playVideo.mock.calls[1]![0] as unknown as { itemKey: string }).itemKey).toBe('episode:3');
    expect(launcher.playing?.itemKey).toBe('episode:3');
  });

  it('videoTracksChanged saves the languages to the profile', async () => {
    const save = vi.fn(async (_p: unknown) => undefined);
    const { launcher, emit } = setup({ 'episode:1': episode(1) }, null, { saveProfileSettings: save });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoTracksChanged', { itemKey: 'episode:1', audioTrack: 0, subtitle: 'e1' });
    expect(save).toHaveBeenLastCalledWith({ audioLanguage: 'en', subtitleLanguage: 'de' });
    await emit('videoTracksChanged', { itemKey: 'episode:1', audioTrack: 1, subtitle: null });
    expect(save).toHaveBeenLastCalledWith({ audioLanguage: 'en', subtitleLanguage: null });
    await emit('videoTracksChanged', { itemKey: 'other:1', audioTrack: 1, subtitle: null });
    expect(save).toHaveBeenCalledTimes(2);
    // An audio index the item does not have: no audio language is saved from it.
    await emit('videoTracksChanged', { itemKey: 'episode:1', audioTrack: 7, subtitle: null });
    expect(save).toHaveBeenLastCalledWith({ subtitleLanguage: null });
  });

  it('videoPrefsChanged saves the caption size to the profile', async () => {
    const save = vi.fn(async (_p: unknown) => undefined);
    const { launcher, emit } = setup({ 'episode:1': episode(1) }, null, { saveProfileSettings: save });
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoPrefsChanged', { itemKey: 'episode:1', subtitleSize: 'large' });
    expect(save).toHaveBeenLastCalledWith({ subtitleSize: 'large' });
    // Another item, or a size that is not one of the three: nothing saved.
    await emit('videoPrefsChanged', { itemKey: 'other:1', subtitleSize: 'small' });
    await emit('videoPrefsChanged', { itemKey: 'episode:1', subtitleSize: 'huge' });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('NativeVideoLauncher: HLS (0.24)', () => {
  const hls = {
    masterUrl: 'http://server.example.com/hls/s1/master.m3u8?sig=x',
    rungs: [
      { id: 'src', height: 2160, videoKbps: 40_000, codec: 'copy', range: 'hdr10', level: 0 },
      { id: '1080', height: 1080, videoKbps: 8_000, codec: 'hevc', range: 'hdr10', level: 1 },
    ],
    startRung: '1080',
    healthUrl: 'http://server.example.com/hls/s1/health?sig=x',
  } as VideoSession['hls'];
  const hlsSession = (req: VideoSessionRequest, id = 's1'): VideoSession =>
    session(req, {
      method: 'transcode',
      url: hls!.masterUrl,
      mimeType: 'application/vnd.apple.mpegurl',
      streamStartMs: 0,
      seekable: true,
      delivery: 'hls',
      sessionId: id,
      hls: hls!,
    });

  function hlsSetup(extra: Record<string, unknown> = {}) {
    const saved: number[] = [];
    const ended: string[] = [];
    const t = setup({ 'episode:1': episode(1, { next: 'episode:2' }), 'episode:2': episode(2) }, null, {
      deliveries: ['hls', 'progressive'],
      bandwidth: { get: () => 12_000, set: (k: number) => saved.push(k) },
      endSession: vi.fn(async (id: string) => {
        ended.push(id);
      }),
      ...extra,
    });
    let n = 0;
    t.deps.requestSession.mockImplementation(async (req: VideoSessionRequest) => {
      t.requests.push(req);
      return hlsSession(req, `s${++n}`);
    });
    return { ...t, saved, ended };
  }

  it('asks for HLS with the device key and the bandwidth hint, and hands the session to native', async () => {
    const { launcher, plugin, requests } = hlsSetup();
    await launcher.start();
    await launcher.launch('episode:1');
    expect(requests[0]).toMatchObject({ deliveries: ['hls', 'progressive'], deviceKey: 'device-1', bandwidthKbps: 12_000 });
    expect(requests[0]!.avoidDirect).toBeUndefined();
    expect(plugin.playVideo.mock.calls[0]![0]).toMatchObject({
      url: hls!.masterUrl,
      seekable: true,
      streamStartMs: 0,
      delivery: 'hls',
      sessionId: 's1',
      hls: { startRung: '1080', healthUrl: hls!.healthUrl },
      quality: 'auto',
      bandwidthKbps: 12_000,
    });
  });

  it('an older build (no deliveries) asks as before', async () => {
    const { launcher, requests, plugin } = setup({ 'episode:1': episode(1) });
    await launcher.start();
    await launcher.launch('episode:1');
    expect(requests[0]!.deliveries).toBeUndefined();
    expect(requests[0]!.deviceKey).toBeUndefined();
    expect((plugin.playVideo.mock.calls[0]![0] as { delivery?: string }).delivery).toBeUndefined();
  });

  it('puts the stall / startup counts into the reports and keeps the measured bandwidth', async () => {
    const { launcher, emit, reports, saved } = hlsSetup();
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoProgress', { itemKey: 'episode:1', positionMs: 20_000, durationMs: 1_000_000, paused: false, stalls: 1, stallMs: 900, startupMs: 1400, bandwidthKbps: 30_000 });
    expect(reports.at(-1)!.report).toMatchObject({ event: 'progress', stalls: 1, stallMs: 900, startupMs: 1400 });
    expect(saved).toEqual([30_000]);
    await emit('videoClosed', { itemKey: 'episode:1', positionMs: 30_000, durationMs: 1_000_000, completed: false, stalls: 2, stallMs: 1500, startupMs: 1400, bandwidthKbps: 25_000 });
    expect(reports.at(-1)!.report).toMatchObject({ event: 'stop', stalls: 2, stallMs: 1500 });
    expect(saved).toEqual([30_000, 25_000]);
  });

  it('ends the HLS session on close, up next and an episode picked in the panel', async () => {
    const { launcher, emit, ended } = hlsSetup();
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoNext', { itemKey: 'episode:2' });
    await flush();
    expect(ended).toEqual(['s1']);
    await emit('videoPickItem', { itemKey: 'episode:1', fromItemKey: 'episode:2', positionMs: 5_000 });
    await flush();
    expect(ended).toEqual(['s1', 's2']);
    await emit('videoClosed', { itemKey: 'episode:1', positionMs: 1_000, durationMs: 1_000_000, completed: false });
    expect(ended).toEqual(['s1', 's2', 's3']);
  });

  it('direct play that keeps stalling: a converted stream on Auto, with avoidDirect', async () => {
    const { launcher, plugin, deps, emit, ended } = hlsSetup();
    // Direct play first.
    deps.requestSession.mockImplementationOnce(async (req: VideoSessionRequest) => session(req, { method: 'direct', seekable: true, streamStartMs: 0 }));
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 200_000, audioTrack: 1, subtitle: 'e0', avoidDirect: true });
    await flush();
    expect(deps.requestSession.mock.calls.at(-1)![0]).toMatchObject({ avoidDirect: true, startMs: 200_000, deliveries: ['hls', 'progressive'] });
    expect(plugin.replaceVideoStream.mock.calls[0]![0]).toMatchObject({ delivery: 'hls', sessionId: 's1', seekable: true, positionMs: 200_000 });
    // The direct-play session had no HLS session to end.
    expect(ended).toEqual([]);
  });

  it('a pinned quality ignores the stall fallback', async () => {
    const { launcher, plugin, deps, emit } = hlsSetup({ quality: () => '1080p' });
    await launcher.start();
    await launcher.launch('episode:1');
    const asked = deps.requestSession.mock.calls.length;
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 200_000, avoidDirect: true });
    await flush();
    expect(deps.requestSession.mock.calls.length).toBe(asked);
    expect(plugin.replaceVideoStream).not.toHaveBeenCalled();
    expect(plugin.playVideo.mock.calls[0]![0]).toMatchObject({ quality: '1080p' });
  });

  it('a failed direct stream: a safe converted stream, also on a pinned quality', async () => {
    const { launcher, plugin, deps, emit } = hlsSetup({ quality: () => '1080p' });
    deps.requestSession.mockImplementationOnce(async (req: VideoSessionRequest) => session(req, { method: 'direct', seekable: true, streamStartMs: 0 }));
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 5_000, avoidDirect: true, failed: true });
    await flush();
    const req = deps.requestSession.mock.calls.at(-1)![0] as VideoSessionRequest;
    expect(req).toMatchObject({ avoidDirect: true, startMs: 5_000, quality: '1080p', deliveries: ['hls', 'progressive'] });
    expect(req.profile).toMatchObject({ containers: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'], hdr: [], hevc10bit: false, maxAudioChannels: 2 });
    expect(plugin.replaceVideoStream.mock.calls[0]![0]).toMatchObject({ delivery: 'hls', positionMs: 5_000 });
  });

  it('a failed HLS stream falls back to progressive and ends the HLS session', async () => {
    const { launcher, plugin, deps, emit, ended } = hlsSetup();
    await launcher.start();
    await launcher.launch('episode:1');
    deps.requestSession.mockImplementationOnce(async (req: VideoSessionRequest) => session(req));
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 30_000, avoidDirect: true, failed: true });
    await flush();
    const req = deps.requestSession.mock.calls.at(-1)![0] as VideoSessionRequest;
    expect(req.deliveries).toEqual(['progressive']);
    expect(req.deviceKey).toBeUndefined();
    expect(plugin.replaceVideoStream.mock.calls[0]![0]).toMatchObject({ seekable: false, streamStartMs: 30_000 });
    expect(ended).toEqual(['s1']);
  });

  it('a failed stream whose new session cannot be had closes the player with the reason', async () => {
    const { launcher, plugin, deps, emit } = hlsSetup();
    await launcher.start();
    await launcher.launch('episode:1');
    deps.requestSession.mockImplementationOnce(async () => {
      throw new Error('busy');
    });
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 30_000, avoidDirect: true, failed: true });
    await flush();
    expect(plugin.closeVideo).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith('busy');
    expect(plugin.replaceVideoStream).not.toHaveBeenCalled();
  });

  it('an audio change under HLS replaces the session and ends the old one', async () => {
    const { launcher, plugin, emit, ended } = hlsSetup();
    await launcher.start();
    await launcher.launch('episode:1');
    await emit('videoSeekRequest', { itemKey: 'episode:1', positionMs: 60_000, audioTrack: 0 });
    await flush();
    expect(plugin.replaceVideoStream.mock.calls[0]![0]).toMatchObject({ sessionId: 's2', selectedAudio: 0 });
    expect(ended).toEqual(['s1']);
  });
});

describe('safeProfile', () => {
  it('keeps what every player decodes and caps the rest', () => {
    const full: VideoDeviceProfile = {
      containers: ['mp4', 'mkv'],
      videoCodecs: ['h264', 'hevc', 'av1'],
      hevc10bit: true,
      hdr: ['hdr10', 'dv'],
      audioCodecs: ['aac', 'eac3', 'dts'],
      maxAudioChannels: 8,
      maxHeight: 2160,
      maxBitrateKbps: 80_000,
    };
    expect(safeProfile(full)).toEqual({
      containers: ['mp4'],
      videoCodecs: ['h264'],
      hevc10bit: false,
      hdr: [],
      audioCodecs: ['aac'],
      maxAudioChannels: 2,
      maxHeight: 1080,
      maxBitrateKbps: 80_000,
    });
    expect(safeProfile({ ...full, maxAudioChannels: 1, maxHeight: 720 })).toMatchObject({ maxAudioChannels: 1, maxHeight: 720 });
  });
});

describe('bandwidth hint storage', () => {
  function mem(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      get length() {
        return m.size;
      },
    } as Storage;
  }

  it('keeps one estimate per account and network type, and ignores nonsense', () => {
    const s = mem();
    expect(readBandwidth('other', s, 'a1')).toBeNull();
    writeBandwidth('other', 25_000.4, s, 'a1');
    writeBandwidth('cellular', 4_000, s, 'a1');
    expect(readBandwidth('other', s, 'a1')).toBe(25_000);
    expect(readBandwidth('cellular', s, 'a1')).toBe(4_000);
    expect(readBandwidth('other', s, 'a2')).toBeNull();
    writeBandwidth('other', 0, s, 'a1');
    writeBandwidth('other', Number.NaN, s, 'a1');
    writeBandwidth('other', 20_000_000, s, 'a1');
    expect(readBandwidth('other', s, 'a1')).toBe(25_000);
    s.setItem('arclight.bandwidth.a1.other', 'junk');
    expect(readBandwidth('other', s, 'a1')).toBeNull();
    expect(readBandwidth('other', null, 'a1')).toBeNull();
  });
});

describe('native extras', () => {
  it('the countdown string keeps its unit, like the native default (strings.xml)', () => {
    expect(videoStrings().nextIn).toBe('Next episode in {s}s');
  });

  it('builds the episode line and skips pause info without data', () => {
    expect(episodeLine({ seasonNumber: 2, episodeNumber: 5, episodeTitle: 'The Long Meridian' })).toBe('S2 E5 · The Long Meridian');
    expect(episodeLine({ seasonNumber: null, episodeNumber: null, episodeTitle: null })).toBeNull();
    expect(pauseInfo(episode(1))).toBeUndefined();
  });

  it('passes trickplay only when ready', () => {
    expect(trickplayOf(null)).toBeNull();
    expect(trickplayOf({ mediaFileId: 1, status: 'pending', intervalMs: 1, tileWidth: 1, tileHeight: 1, columns: 1, rows: 1, tileCount: 1, sheets: [] })).toBeNull();
  });

  it('turns computed colours into hex, translucent ones as #aarrggbb', () => {
    expect(toHex('rgb(17, 19, 22)')).toBe('#111316');
    expect(toHex('rgba(255, 255, 255, 0.5)')).toBe('#80ffffff');
    expect(toHex('#6EF6FF')).toBe('#6ef6ff');
    expect(toHex('#fff')).toBe('#ffffff');
    expect(toHex('color(srgb 1 0 0)')).toBe('#ff0000');
    expect(toHex('oklch(0.5 0.1 20)')).toBeNull();
    const theme = themeFrom((tok) => (tok === '--al-pl-bg' ? 'rgb(0, 0, 0)' : 'nonsense'), () => Number.NaN);
    expect(theme.bg).toBe('#000000');
    expect(theme.accent).toBe('#6ef6ff');
    expect(theme.radiusButton).toBe(8);
  });

  it('matches languages across 639-1 and 639-2 and prefers full subtitles in the profile language', () => {
    expect(normLanguage('ger')).toBe('de');
    expect(normLanguage('und')).toBeNull();
    expect(preferredSubtitle(episode(1), ProfileSettings.parse({ subtitleLanguage: 'en' }), 1)).toBe('e0');
    const base = episode(1);
    const forcedOnly = episode(1, {
      video: { ...base.video!, subtitleTracks: [{ id: 'f', source: 'embedded', codec: 'subrip', language: 'eng', title: null, forced: true, hearingImpaired: false, default: false, text: true }] },
    } as Partial<PlayableItem>);
    expect(preferredSubtitle(forcedOnly, ProfileSettings.parse({}), 1)).toBe('f');
  });

  it('names specials and keeps season numbers', () => {
    const rows = seasonsOf({ seasons: [{ seasonNumber: 0, title: 'Specials', episodeCount: 0, playedCount: 0, episodes: [] }] } as unknown as PlayerSeriesDetails);
    expect(rows[0]!.seasonNumber).toBe(0);
  });
});
