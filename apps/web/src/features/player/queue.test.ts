import { describe, expect, it } from 'vitest';
import type { ItemKey } from '@arclight/shared';
import {
  addToQueue,
  clearUpcoming,
  currentKey,
  fromServerQueue,
  goTo,
  moveItem,
  newQueue,
  nextPos,
  playNext,
  playOrder,
  previousPos,
  removeAt,
  setRepeat,
  setShuffle,
  shuffled,
  toServerQueue,
  REPEAT_CYCLE,
} from './queue.js';

const k = (...ids: number[]) => ids.map((id) => `track:${id}` as ItemKey);
/** A deterministic "random" that walks through a list. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('queue', () => {
  it('starts at the chosen item', () => {
    const q = newQueue(k(1, 2, 3), 1, { source: 'album:5' });
    expect(currentKey(q)).toBe('track:2');
    expect(q.source).toBe('album:5');
    expect(playOrder(q)).toEqual(k(1, 2, 3));
  });

  it('walks forward and back, honouring repeat', () => {
    let q = newQueue(k(1, 2, 3), 2);
    expect(nextPos(q, false)).toBeNull();
    q = setRepeat(q, 'all');
    expect(nextPos(q, false)).toBe(0);
    q = goTo(q, 0);
    expect(previousPos(q)).toBe(2);
    q = setRepeat(q, 'one');
    expect(nextPos(q, true)).toBe(0); // ended by itself: replay
    expect(nextPos(q, false)).toBe(1); // pressed Next: skip anyway
    expect(REPEAT_CYCLE.off).toBe('all');
    expect(REPEAT_CYCLE.all).toBe('one');
    expect(REPEAT_CYCLE.one).toBe('off');
  });

  it('shuffles everything but the current item after it, and restores the order', () => {
    const q = newQueue(k(1, 2, 3, 4, 5), 2);
    const s = setShuffle(q, true, seq(0, 0, 0, 0));
    expect(s.shuffle).toBe(true);
    expect(currentKey(s)).toBe('track:3');
    expect(s.pos).toBe(0);
    expect(new Set(playOrder(s))).toEqual(new Set(k(1, 2, 3, 4, 5)));
    expect(playOrder(s)).not.toEqual(k(1, 2, 3, 4, 5));
    const off = setShuffle(s, false);
    expect(playOrder(off)).toEqual(k(1, 2, 3, 4, 5));
    expect(currentKey(off)).toBe('track:3');
    expect(shuffled([1, 2, 3], () => 0.999)).toEqual([1, 2, 3]);
  });

  it('inserts with play next and appends with add to queue', () => {
    let q = newQueue(k(1, 2, 3), 0);
    q = playNext(q, k(9));
    expect(playOrder(q)).toEqual(k(1, 9, 2, 3));
    q = addToQueue(q, k(8));
    expect(playOrder(q)).toEqual(k(1, 9, 2, 3, 8));
    expect(currentKey(q)).toBe('track:1');

    const shuffledQ = playNext(setShuffle(newQueue(k(1, 2, 3), 0), true, seq(0)), k(9));
    expect(playOrder(shuffledQ)[1]).toBe('track:9');
  });

  it('moves entries while the current one keeps playing', () => {
    const q = newQueue(k(1, 2, 3, 4), 1);
    const moved = moveItem(q, 3, 0);
    expect(playOrder(moved)).toEqual(k(4, 1, 2, 3));
    expect(currentKey(moved)).toBe('track:2');
    expect(moved.pos).toBe(2);
    expect(moveItem(q, 0, 9)).toBe(q);

    const s = setShuffle(q, true, seq(0, 0, 0));
    const sm = moveItem(s, 1, 3);
    expect(currentKey(sm)).toBe('track:2');
    expect(playOrder(sm)[3]).toBe(playOrder(s)[1]);
  });

  it('removes entries and clears what is upcoming', () => {
    const q = newQueue(k(1, 2, 3, 4), 2);
    const before = removeAt(q, 0);
    expect(playOrder(before)).toEqual(k(2, 3, 4));
    expect(currentKey(before)).toBe('track:3');
    const current = removeAt(q, 2);
    expect(currentKey(current)).toBe('track:4');
    const last = removeAt(newQueue(k(1, 2), 1), 1);
    expect(currentKey(last)).toBe('track:1');
    expect(playOrder(clearUpcoming(q))).toEqual(k(3));
  });

  it('round-trips the server form', () => {
    const q = setShuffle(newQueue(k(1, 2, 3, 4), 1, { source: 'playlist:2' }), true, seq(0.5, 0.1, 0.9));
    const server = toServerQueue(q, 12_345.6, 'dev');
    expect(server.items).toEqual(k(1, 2, 3, 4));
    expect(server.index).toBe(1); // index into items
    expect(server.order).toEqual(q.order);
    expect(server.positionMs).toBe(12_345);
    const back = fromServerQueue(server);
    expect(playOrder(back)).toEqual(playOrder(q));
    expect(currentKey(back)).toBe('track:2');

    // A broken order falls back to unshuffled.
    const broken = fromServerQueue({ ...server, order: [0, 0, 1, 2] });
    expect(broken.shuffle).toBe(false);
    expect(currentKey(broken)).toBe('track:2');
  });
});
