import { describe, expect, it, vi } from 'vitest';
import { book, makeEngine, track, type FakeAudio } from '../test-utils.js';
import { chapterBounds, chapterIndexAt, locate } from './timeline.js';
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

  it('falls back to a transcode when a direct stream fails to decode', () => {
    const { engine } = makeEngine();
    engine.load(track(1), 0, true);
    active(engine).fire('loadedmetadata');
    active(engine).at(12);
    active(engine).fail(4);
    expect(active(engine).src).toMatch(/format=(opus|aac)&startMs=12000/);
    expect(engine.snapshot().error).toBeNull();
    expect(engine.isPlaying).toBe(true);

    // A transcode that fails too is reported.
    active(engine).fail(4);
    expect(engine.snapshot().error).toBe('unsupported');
    expect(engine.isPlaying).toBe(false);
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

  it('rewinds audiobooks after a long pause only', () => {
    expect(rewindOnResumeMs('audiobook', 0, 6 * 60_000)).toBe(REWIND_ON_RESUME_MS);
    expect(rewindOnResumeMs('audiobook', 0, 60_000)).toBe(0);
    expect(rewindOnResumeMs('track', 0, 60 * 60_000)).toBe(0);
    expect(rewindOnResumeMs('audiobook', null, 60 * 60_000)).toBe(0);
  });
});
