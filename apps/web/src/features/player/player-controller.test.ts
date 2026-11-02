import { afterEach, describe, expect, it, vi } from 'vitest';
import { REWIND_AFTER_PAUSE_MS } from './engine/sleep-timer.js';
import { LONG_TRACK_MS, resumePosition } from './player-controller.js';
import { book, flush, makeController, progress, track } from './test-utils.js';

afterEach(() => vi.useRealTimers());

describe('resumePosition', () => {
  it('resumes audiobooks and long tracks, not songs or finished items', () => {
    expect(resumePosition(book(), progress('audiobook:7', 600_000, 3_600_000))).toBe(600_000);
    expect(resumePosition(book(), progress('audiobook:7', 600_000, 3_600_000, { played: true }))).toBe(0);
    expect(resumePosition(track(1), progress('track:1', 60_000, 180_000))).toBe(0);
    expect(resumePosition(track(1, { durationMs: LONG_TRACK_MS * 2 }), progress('track:1', 600_000, LONG_TRACK_MS * 2))).toBe(600_000);
  });
});

describe('PlayerController', () => {
  it('plays a list from the chosen index and reports start', async () => {
    const h = makeController([track(1), track(2), track(3)]);
    await h.controller.playItems(['track:1', 'track:2', 'track:3'], { startIndex: 1, source: 'album:1' });
    const s = h.controller.getState();
    expect(s.current?.itemKey).toBe('track:2');
    expect(s.queueIndex).toBe(1);
    expect(s.source).toBe('album:1');
    expect(s.playing).toBe(true);
    expect(h.deps.sendProgress).toHaveBeenCalledWith('track:2', expect.objectContaining({ event: 'start', deviceId: 'device-test' }));
  });

  it('resumes an audiobook from saved progress with its own speed', async () => {
    const h = makeController([book()], { progress: [progress('audiobook:7', 1_900_000, 3_600_000, { prefs: { speed: 1.5 } })] });
    await h.controller.playItem('audiobook:7');
    const s = h.controller.getState();
    expect(s.positionMs).toBe(1_900_000);
    expect(s.speed).toBe(1.5);
    expect(h.active().src).toBe('/stream/201?format=original');
    expect(s.chapterIndex).toBe(1);
  });

  it('advances gaplessly, closing the old report and starting the next', async () => {
    const h = makeController([track(1), track(2)]);
    await h.controller.playItems(['track:1', 'track:2']);
    await flush(); // next item prefetched
    h.active().at(175);
    h.active().fire('ended');
    const s = h.controller.getState();
    expect(s.current?.itemKey).toBe('track:2');
    expect(s.queueIndex).toBe(1);
    const events = h.deps.sendProgress.mock.calls.map(([key, r]) => `${key} ${(r as { event: string }).event}`);
    expect(events).toEqual(['track:1 start', 'track:1 stop', 'track:2 start']);
  });

  it('restarts the item on previous after three seconds, else goes back', async () => {
    const h = makeController([track(1), track(2)]);
    await h.controller.playItems(['track:1', 'track:2'], { startIndex: 1 });
    h.active().fire('loadedmetadata');
    h.active().at(30);
    h.controller.previous();
    expect(h.controller.getState().current?.itemKey).toBe('track:2');
    expect(h.active().currentTime).toBe(0);
    h.controller.previous();
    await flush();
    expect(h.controller.getState().current?.itemKey).toBe('track:1');
  });

  it('pauses when a minutes sleep timer runs out', async () => {
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 0 });
    h.controller.setSleepTimer({ kind: 'minutes', minutes: 5 });
    expect(h.controller.getState().sleepTimer).toMatchObject({ kind: 'minutes', minutes: 5 });
    h.clock.now += 5 * 60_000 + 1;
    h.active().at(300);
    await flush();
    expect(h.controller.getState().playing).toBe(false);
    expect(h.controller.getState().sleepTimer).toBeNull();
    expect(h.deps.sendProgress).toHaveBeenLastCalledWith('audiobook:7', expect.objectContaining({ event: 'pause' }));
  });

  it('pauses at the end of the chapter', async () => {
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 1_100_000 });
    h.active().fire('loadedmetadata');
    h.controller.setSleepTimer({ kind: 'chapter' });
    h.active().at(1_150);
    await flush();
    expect(h.controller.getState().playing).toBe(true);
    h.active().at(1_200);
    await flush();
    expect(h.controller.getState().playing).toBe(false);
  });

  it('rewinds an audiobook a little after a long pause', async () => {
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 600_000 });
    h.active().fire('loadedmetadata');
    h.controller.pause();
    h.clock.now += REWIND_AFTER_PAUSE_MS + 1;
    h.controller.play();
    expect(h.controller.getState().positionMs).toBe(590_000);
    expect(h.controller.getState().playing).toBe(true);

    // A short pause does not rewind.
    h.controller.pause();
    h.clock.now += 1_000;
    h.controller.play();
    expect(h.controller.getState().positionMs).toBe(590_000);
  });

  it('saves the audiobook speed and the queue after a moment', async () => {
    vi.useFakeTimers();
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 0 });
    h.controller.setSpeed(1.75);
    h.controller.setSpeed(2);
    vi.advanceTimersByTime(2_000);
    expect(h.deps.savePrefs).toHaveBeenCalledTimes(1);
    expect(h.deps.savePrefs).toHaveBeenCalledWith('audiobook:7', { speed: 2 });
    expect(h.deps.saveQueue).toHaveBeenCalledWith(expect.objectContaining({ items: ['audiobook:7'], source: 'audiobook:7', deviceId: 'device-test' }));
  });

  it('edits the queue in play order', async () => {
    const h = makeController([track(1), track(2), track(3), track(4)]);
    await h.controller.playItems(['track:1', 'track:2']);
    h.controller.playNext(['track:3']);
    h.controller.addToQueue(['track:4']);
    expect(h.controller.getState().queue.map((e) => e.itemKey)).toEqual(['track:1', 'track:3', 'track:2', 'track:4']);
    h.controller.moveInQueue(3, 1);
    expect(h.controller.getState().queue.map((e) => e.itemKey)).toEqual(['track:1', 'track:4', 'track:3', 'track:2']);
    h.controller.removeFromQueue(2);
    h.controller.toggleShuffle();
    expect(h.controller.getState().shuffle).toBe(true);
    expect(h.controller.getState().current?.itemKey).toBe('track:1');
    h.controller.cycleRepeat();
    expect(h.controller.getState().repeat).toBe('all');
    h.controller.clearQueue();
    expect(h.controller.getState().queue.map((e) => e.itemKey)).toEqual(['track:1']);
  });

  it('restores the saved queue paused, unless something already started', async () => {
    const queue = { items: ['track:1', 'track:2'] as never, index: 1, positionMs: 42_000, shuffle: false, order: null, repeat: 'off' as const, source: 'album:1' };
    const h = makeController([track(1), track(2)], { queue });
    await h.controller.restore();
    const s = h.controller.getState();
    expect(s.current?.itemKey).toBe('track:2');
    expect(s.playing).toBe(false);
    expect(s.positionMs).toBe(42_000);
    expect(h.deps.sendProgress).not.toHaveBeenCalled();

    const late = makeController([track(1), track(2), track(3)], { queue });
    await late.controller.playItem('track:3');
    await late.controller.restore();
    expect(late.controller.getState().current?.itemKey).toBe('track:3');
  });

  it('beacons the place when the tab is hidden or closed', async () => {
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 0 });
    h.controller.onHidden();
    expect(h.deps.beacon).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'progress', itemKey: 'audiobook:7' }));
    h.controller.onPageHide();
    expect(h.deps.beacon).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'stop' }));
  });

  it('shows a load error when the item cannot be fetched', async () => {
    const h = makeController([]);
    await h.controller.playItem('track:99');
    expect(h.controller.getState().error).toBe('load');
    expect(h.controller.getState().loading).toBe(false);
  });
});
