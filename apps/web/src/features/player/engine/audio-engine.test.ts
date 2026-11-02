import { describe, expect, it, vi } from 'vitest';
import { book, flush, makeEngine, part, track, type FakeAudio } from '../test-utils.js';
import { chapterBounds, chapterIndexAt, locate, partIndexAt } from './timeline.js';
import { SleepTimer, rewindOnResumeMs, sleepFade, REWIND_ON_RESUME_MS } from './sleep-timer.js';
import { chooseStream } from './stream.js';

const active = (e: ReturnType<typeof makeEngine>['engine']) => e.activeElement as FakeAudio;

describe('timeline', () => {
  it('maps a book position to its file and the time inside it', () => {
    const b = book();
    expect(locate(b, 0)).toMatchObject({ partIndex: 0, localMs: 0 });
    expect(locate(b, 2_000_000)).toMatchObject({ partIndex: 1, localMs: 200_000 });
    expect(locate(b, 99_999_999)).toMatchObject({ partIndex: 1 });
  });

  it('skips zero-length parts and does not cap unknown lengths', () => {
    // An empty file at the start shares its start with the real first file.
    const parts = [part(1, 0, 0), part(2, 0, 1_000), part(3, 1_000, 1_000), part(4, 2_000, 0)];
    expect(partIndexAt(parts, 0)).toBe(1);
    expect(partIndexAt(parts, 999)).toBe(1);
    expect(partIndexAt(parts, 1_000)).toBe(2);
    // The last part's length is unknown: it holds everything after its start.
    expect(partIndexAt(parts, 50_000)).toBe(3);
    expect(locate({ parts: [part(9, 0, 0)], durationMs: 0 }, 42_000)).toEqual({ partIndex: 0, localMs: 42_000 });
  });

  it('finds chapters and their bounds', () => {
    const b = book();
    expect(chapterIndexAt(b.chapters, 1_300_000)).toBe(1);
    expect(chapterBounds(b.chapters, 2, b.durationMs)).toEqual({ startMs: 2_400_000, endMs: 3_600_000 });
  });
});

describe('AudioEngine', () => {
  it('seeks across the files of a multi-part audiobook', () => {
    const { engine } = makeEngine();
    engine.load(book(), 0, true);
    expect(active(engine).src).toBe('/stream/200?format=original');

    engine.seek(2_000_000);
    expect(active(engine).src).toBe('/stream/201?format=original');
    expect(engine.positionMs).toBe(2_000_000);
    active(engine).fire('loadedmetadata');
    expect(active(engine).currentTime).toBe(200);
    expect(engine.snapshot().partIndex).toBe(1);

    // Same file, direct stream: just move the element clock.
    engine.seek(1_900_000);
    expect(active(engine).src).toBe('/stream/201?format=original');
    expect(active(engine).currentTime).toBe(100);
  });

  it('starts a resumed item at its place', () => {
    const { engine } = makeEngine();
    engine.load(book(), 1_900_000, false);
    expect(engine.isPlaying).toBe(false);
    expect(engine.positionMs).toBe(1_900_000);
    active(engine).fire('loadedmetadata');
    expect(active(engine).currentTime).toBe(100);
  });

  it('preloads the next item on the standby deck and hands off without a gap', () => {
    const { engine, decks } = makeEngine();
    const onAdvance = vi.fn();
    engine.setHooks({ onAdvance });
    const a = track(1);
    const b = track(2);
    engine.load(a, 0, true);
    engine.setNext(b);
    const first = active(engine);
    const standby = decks.find((d) => d !== first)!;
    expect(standby.src).toBe('');

    first.at(170); // 10 s left: inside the preload window
    expect(standby.src).toBe('/stream/102?format=original');
    expect(standby.paused).toBe(true);

    first.fire('ended');
    expect(active(engine)).toBe(standby);
    expect(standby.paused).toBe(false);
    expect(first.src).toBe('');
    expect(engine.current).toBe(b);
    expect(onAdvance).toHaveBeenCalledWith(b);
  });

  it('moves to the next file of the same audiobook without an advance', () => {
    const { engine } = makeEngine();
    const onAdvance = vi.fn();
    engine.setHooks({ onAdvance });
    engine.load(book(), 1_790_000, true);
    active(engine).fire('loadedmetadata');
    active(engine).at(1_795);
    active(engine).fire('ended');
    expect(active(engine).src).toBe('/stream/201?format=original');
    expect(engine.positionMs).toBe(1_800_000);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('ends the queue when nothing comes next', () => {
    const { engine } = makeEngine();
    const onQueueEnd = vi.fn();
    engine.setHooks({ onQueueEnd });
    engine.load(track(1), 0, true);
    active(engine).fire('ended');
    expect(engine.isPlaying).toBe(false);
    expect(onQueueEnd).toHaveBeenCalledOnce();
  });

  it('asks for a transcode when the browser cannot play the file', () => {
    const { engine, decks } = makeEngine();
    decks.forEach((d) => (d.playable = ''));
    engine.load(track(1), 30_000, true);
    expect(active(engine).src).toMatch(/^\/stream\/101\?format=(opus|aac)&startMs=30000$/);
    expect(engine.snapshot().stream?.transcoded).toBe(true);
    // Element time 0 is 30 s into the file.
    active(engine).at(5);
    expect(engine.positionMs).toBe(35_000);
  });

  it('falls back to a transcode when a direct stream fails to decode', async () => {
    const { engine } = makeEngine();
    engine.load(track(1), 0, true);
    active(engine).fire('loadedmetadata');
    active(engine).at(12);
    active(engine).fail(4);
    await flush();
    expect(active(engine).src).toMatch(/format=(opus|aac)&startMs=12000/);
    expect(engine.snapshot().error).toBeNull();
    expect(engine.isPlaying).toBe(true);

    // A transcode that fails too is reported.
    active(engine).fail(4);
    await flush();
    expect(engine.snapshot().error).toBe('unsupported');
    expect(engine.isPlaying).toBe(false);
  });

  it('tells a refused stream from a decode error', async () => {
    const status = { value: 503 };
    const probe = vi.fn(async () => status.value);
    const { engine } = makeEngine({ probe });
    engine.load(track(1), 0, true);
    // Browsers report an HTTP error as "source not supported".
    active(engine).fail(4);
    expect(engine.snapshot().buffering).toBe(true);
    await flush();
    expect(probe).toHaveBeenCalledWith('/stream/101?format=original');
    expect(engine.snapshot().error).toBe('busy');
    expect(active(engine).src).toBe('/stream/101?format=original'); // not flipped to a transcode
    expect(engine.isPlaying).toBe(false);

    status.value = 403;
    engine.play();
    active(engine).fail(4);
    await flush();
    expect(engine.snapshot().error).toBe('network');

    status.value = 0; // the request itself failed
    engine.load(track(1), 0, true);
    active(engine).fail(2);
    await flush();
    expect(engine.snapshot().error).toBe('network');
  });

  it('drops an error probe for a src that was already replaced', async () => {
    let answer: (s: number) => void = () => undefined;
    const { engine } = makeEngine({ probe: () => new Promise<number>((r) => (answer = r)) });
    engine.load(track(1), 0, true);
    active(engine).fail(4);
    engine.load(track(2), 0, true);
    answer(503);
    await flush();
    expect(engine.snapshot().error).toBeNull();
    expect(active(engine).src).toBe('/stream/102?format=original');
  });

  it('does not retry a failed preload; the advance handles it once', async () => {
    const { engine, decks } = makeEngine();
    engine.load(track(1), 0, true);
    engine.setNext(track(2));
    const first = active(engine);
    const standby = decks.find((d) => d !== first)!;
    first.at(170);
    expect(standby.src).toBe('/stream/102?format=original');
    standby.fail(4);
    expect(standby.src).toBe('');
    first.at(171);
    first.at(172);
    // Not retried, and never flipped to a transcode on standby.
    expect(standby.srcHistory.filter((s) => s.startsWith('/stream/102'))).toEqual(['/stream/102?format=original']);

    first.fire('ended');
    expect(active(engine)).toBe(standby);
    expect(standby.src).toBe('/stream/102?format=original');
    standby.fail(4);
    await flush();
    expect(standby.src).toMatch(/^\/stream\/102\?format=(opus|aac)$/);
    expect(engine.snapshot().error).toBeNull();
  });

  it('waits for ended when the length is unknown or longer than the library says', () => {
    vi.useFakeTimers();
    try {
      const onAdvance = vi.fn();
      // Unknown length: no timer handoff, and the position is not clamped.
      const unknown = makeEngine();
      unknown.engine.setHooks({ onAdvance });
      unknown.engine.load(track(1, { durationMs: 0, parts: [part(101, 0, 0)] }), 0, true);
      unknown.engine.setNext(track(2));
      active(unknown.engine).at(600);
      vi.advanceTimersByTime(10_000);
      expect(onAdvance).not.toHaveBeenCalled();
      expect(unknown.engine.positionMs).toBe(600_000);

      // The file runs 20 s past the library's length: a timer would cut it, so wait for ended.
      const longer = makeEngine();
      longer.engine.setHooks({ onAdvance });
      longer.engine.load(track(1), 0, true);
      longer.engine.setNext(track(2));
      active(longer.engine).duration = 200;
      active(longer.engine).at(170);
      active(longer.engine).at(179);
      vi.advanceTimersByTime(5_000);
      expect(onAdvance).not.toHaveBeenCalled();
      active(longer.engine).fire('ended');
      expect(onAdvance).toHaveBeenCalledOnce();

      // A known length that agrees: the precise handoff fires on its own.
      const exact = makeEngine();
      const onExact = vi.fn();
      exact.engine.setHooks({ onAdvance: onExact });
      exact.engine.load(track(1), 0, true);
      exact.engine.setNext(track(2));
      active(exact.engine).duration = 180;
      active(exact.engine).at(170);
      active(exact.engine).at(179);
      vi.advanceTimersByTime(1_500);
      expect(onExact).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for a long-paused transcode again on play', () => {
    const clock = { now: 0 };
    const { engine, decks } = makeEngine({ now: () => clock.now });
    decks.forEach((d) => (d.playable = ''));
    engine.load(track(1), 0, true);
    active(engine).at(20);
    engine.pause();
    clock.now = 10_000;
    engine.play();
    expect(active(engine).src).toMatch(/format=(opus|aac)$/);
    engine.pause();
    clock.now = 100_000;
    engine.play();
    expect(active(engine).src).toMatch(/format=(opus|aac)&startMs=20000$/);
  });

  it('transcodes above the bitrate cap', () => {
    const { engine } = makeEngine({ maxBitrateKbps: () => 320 });
    engine.load(track(1), 0, true);
    expect(active(engine).src).toMatch(/format=(opus|aac)/);
    expect(chooseStream({ bitrateKbps: 256 }, { playable: true, transcodeTo: 'opus', maxBitrateKbps: 320 }).transcoded).toBe(false);
  });

  it('reports a blocked autoplay', async () => {
    const { engine, decks } = makeEngine();
    decks.forEach((d) => (d.rejectPlay = 'NotAllowedError'));
    engine.load(track(1), 0, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.snapshot().error).toBe('blocked');
    expect(engine.isPlaying).toBe(false);
  });

  it('applies speed with pitch kept, and volume, mute and fade to both decks', () => {
    const { engine, decks } = makeEngine();
    engine.load(track(1, { replayGain: { trackGainDb: -6, albumGainDb: null } }), 0, true);
    engine.setSpeed(1.5);
    engine.setVolume(0.5);
    expect(decks.every((d) => d.playbackRate === 1.5 && d.preservesPitch)).toBe(true);
    expect(active(engine).volume).toBe(0.5);
    engine.setReplayGain('track');
    expect(active(engine).volume).toBeCloseTo(0.25, 2); // -6 dB
    engine.setReplayGain('off');
    engine.setFade(0);
    expect(active(engine).volume).toBe(0);
    engine.setFade(1);
    engine.setMuted(true);
    expect(active(engine).volume).toBe(0);
  });
});

describe('sleep timer', () => {
  const ctx = (over: Partial<Parameters<SleepTimer['tick']>[0]> = {}) => ({ now: 0, playing: true, positionMs: 0, durationMs: 3_600_000, speed: 1, chapters: book().chapters, ...over });

  it('counts minutes only while playing', () => {
    const timer = new SleepTimer({ kind: 'minutes', minutes: 1 }, ctx());
    expect(timer.tick(ctx({ now: 30_000 })).remainingMs).toBe(30_000);
    expect(timer.tick(ctx({ now: 90_000, playing: false })).remainingMs).toBe(30_000);
    const end = timer.tick(ctx({ now: 120_000 }));
    expect(end.expired).toBe(true);
    expect(end.fade).toBe(0);
  });

  it('fades over the last ten seconds', () => {
    expect(sleepFade(20_000)).toBe(1);
    expect(sleepFade(5_000)).toBe(0.5);
  });

  it('ends at the end of the chapter, in listening time', () => {
    const timer = new SleepTimer({ kind: 'chapter' }, ctx({ positionMs: 1_000_000 }));
    expect(timer.chapterEndMs).toBe(1_200_000);
    expect(timer.tick(ctx({ positionMs: 1_000_000, speed: 2 })).remainingMs).toBe(100_000);
    expect(timer.tick(ctx({ positionMs: 1_200_000 })).expired).toBe(true);
  });

  it('an end-of-chapter timer runs out when another item plays', () => {
    const timer = new SleepTimer({ kind: 'chapter' }, ctx({ itemKey: 'track:1', chapters: [], durationMs: 180_000, positionMs: 10_000 }));
    expect(timer.tick(ctx({ itemKey: 'track:1', chapters: [], durationMs: 180_000, positionMs: 20_000 })).expired).toBe(false);
    // Position 0 of the next song would otherwise look like a fresh 3 minutes.
    expect(timer.tick(ctx({ itemKey: 'track:2', chapters: [], durationMs: 180_000, positionMs: 0 })).expired).toBe(true);
    // Minutes timers carry on across items.
    const minutes = new SleepTimer({ kind: 'minutes', minutes: 5 }, ctx({ itemKey: 'track:1' }));
    expect(minutes.tick(ctx({ itemKey: 'track:2', now: 1_000 })).expired).toBe(false);
  });

  it('rewinds audiobooks after a long pause only', () => {
    expect(rewindOnResumeMs('audiobook', 0, 6 * 60_000)).toBe(REWIND_ON_RESUME_MS);
    expect(rewindOnResumeMs('audiobook', 0, 60_000)).toBe(0);
    expect(rewindOnResumeMs('track', 0, 60 * 60_000)).toBe(0);
    expect(rewindOnResumeMs('audiobook', null, 60 * 60_000)).toBe(0);
  });
});
