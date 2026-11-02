import type { ItemKey, PlayQueue, RepeatMode } from '@arclight/shared';

// The play queue as plain data: `items` in the order they were added (the unshuffled list),
// `order` the play sequence (indexes into items; identity while not shuffled) and `pos` the
// place in `order` that is playing. Every function returns a new queue. Positions given to the
// editing functions are positions in the play order, which is what the queue panel shows.

export interface Queue {
  items: ItemKey[];
  order: number[];
  pos: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** "album:12", "playlist:3", "audiobook:7": what the queue was started from. */
  source: string | null;
}

export const EMPTY_QUEUE: Queue = { items: [], order: [], pos: 0, shuffle: false, repeat: 'off', source: null };

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

export type Random = () => number;

/** Fisher-Yates over a copy. */
export function shuffled<T>(list: readonly T[], random: Random = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A fresh queue of `keys`, starting at `startIndex` (an index into keys). */
export function newQueue(keys: readonly ItemKey[], startIndex = 0, opts: { source?: string | null; shuffle?: boolean; repeat?: RepeatMode; random?: Random } = {}): Queue {
  const items = [...keys];
  const start = Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1));
  const base: Queue = { items, order: identity(items.length), pos: start, shuffle: false, repeat: opts.repeat ?? 'off', source: opts.source ?? null };
  return opts.shuffle ? setShuffle(base, true, opts.random) : base;
}

export function currentKey(q: Queue): ItemKey | null {
  const idx = q.order[q.pos];
  return idx === undefined ? null : (q.items[idx] ?? null);
}

/** The keys in play order (what the queue panel lists). */
export function playOrder(q: Queue): ItemKey[] {
  return q.order.map((i) => q.items[i]!).filter(Boolean);
}

/**
 * Where the queue goes next. `auto`: the current item ended by itself (repeat-one replays it;
 * pressing Next skips anyway). null: the end of the queue.
 */
export function nextPos(q: Queue, auto: boolean): number | null {
  if (q.order.length === 0) return null;
  if (auto && q.repeat === 'one') return q.pos;
  if (q.pos + 1 < q.order.length) return q.pos + 1;
  return q.repeat === 'all' ? 0 : null;
}

export function previousPos(q: Queue): number | null {
  if (q.order.length === 0) return null;
  if (q.pos > 0) return q.pos - 1;
  return q.repeat === 'all' ? q.order.length - 1 : null;
}

export function goTo(q: Queue, pos: number): Queue {
  if (pos < 0 || pos >= q.order.length) return q;
  return { ...q, pos };
}

/** Insert right after the current item. */
export function playNext(q: Queue, keys: readonly ItemKey[]): Queue {
  if (keys.length === 0) return q;
  if (q.items.length === 0) return newQueue(keys, 0, { source: null, repeat: q.repeat });
  if (!q.shuffle) {
    const at = q.pos + 1;
    const items = [...q.items.slice(0, at), ...keys, ...q.items.slice(at)];
    return { ...q, items, order: identity(items.length) };
  }
  const added = keys.map((_, i) => q.items.length + i);
  const order = [...q.order.slice(0, q.pos + 1), ...added, ...q.order.slice(q.pos + 1)];
  return { ...q, items: [...q.items, ...keys], order };
}

/** Append to the end. */
export function addToQueue(q: Queue, keys: readonly ItemKey[]): Queue {
  if (keys.length === 0) return q;
  if (q.items.length === 0) return newQueue(keys, 0, { source: null, repeat: q.repeat });
  const added = keys.map((_, i) => q.items.length + i);
  return { ...q, items: [...q.items, ...keys], order: [...q.order, ...added] };
}

/** Remove the entry at play-order position `p`. Removing the current one moves on to the next. */
export function removeAt(q: Queue, p: number): Queue {
  const idx = q.order[p];
  if (idx === undefined) return q;
  const items = q.items.filter((_, i) => i !== idx);
  const order = q.order.filter((_, i) => i !== p).map((i) => (i > idx ? i - 1 : i));
  let pos = q.pos;
  if (p < q.pos) pos -= 1;
  if (pos >= order.length) pos = Math.max(0, order.length - 1);
  return { ...q, items, order, pos };
}

/** Move the entry at play-order position `from` to `to`; the current item keeps playing. */
export function moveItem(q: Queue, from: number, to: number): Queue {
  const n = q.order.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return q;
  const playing = q.order[q.pos];
  const order = [...q.order];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  if (q.shuffle) return { ...q, order, pos: order.indexOf(playing!) };
  // Unshuffled, items is the play order: rebuild it and keep order the identity.
  const items = order.map((i) => q.items[i]!);
  return { ...q, items, order: identity(items.length), pos: order.indexOf(playing!) };
}

/** Clear everything but what is playing. */
export function clearUpcoming(q: Queue): Queue {
  const key = currentKey(q);
  if (!key) return { ...EMPTY_QUEUE, repeat: q.repeat };
  return { ...q, items: [key], order: [0], pos: 0 };
}

/** Shuffle on: every other entry in random order after the current one. Off: back to added order. */
export function setShuffle(q: Queue, on: boolean, random: Random = Math.random): Queue {
  if (on) {
    const playing = q.order[q.pos];
    if (playing === undefined) return { ...q, shuffle: true };
    const rest = shuffled(identity(q.items.length).filter((i) => i !== playing), random);
    return { ...q, shuffle: true, order: [playing, ...rest], pos: 0 };
  }
  const playing = q.order[q.pos] ?? 0;
  return { ...q, shuffle: false, order: identity(q.items.length), pos: Math.min(playing, Math.max(0, q.items.length - 1)) };
}

export function setRepeat(q: Queue, repeat: RepeatMode): Queue {
  return { ...q, repeat };
}

export const REPEAT_CYCLE: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

// ---------------------------------------------------------------------------------------
// Server form (GET/PUT /playback/queue)
// ---------------------------------------------------------------------------------------

/**
 * The server keeps `items` unshuffled, `order` (only while shuffled) and `index`. Arclight
 * stores `index` as an index into `items` (the current item), which reads the same shuffled or
 * not.
 */
export function toServerQueue(q: Queue, positionMs: number, deviceId?: string): PlayQueue {
  const { items, index, order } = serverWindow(q);
  return {
    items,
    index,
    positionMs: Math.max(0, Math.floor(positionMs)),
    shuffle: q.shuffle,
    order: q.shuffle ? order : null,
    repeat: q.repeat,
    source: q.source,
    ...(deviceId ? { deviceId } : {}),
  };
}

/** The most a saved queue holds. */
export const MAX_SERVER_QUEUE = 5000;
/** A trimmed queue keeps this much of what already played before the current item. */
const KEEP_BEHIND = 1000;

/**
 * The part of a long queue that is saved: MAX_SERVER_QUEUE entries of the play order around the
 * current item (a little history, mostly what comes next), so the saved index always points at
 * what is playing. Shuffled, the kept items stay in their added order and `order` is renumbered.
 */
function serverWindow(q: Queue): { items: ItemKey[]; index: number; order: number[] } {
  const n = q.order.length;
  const current = q.order[q.pos] ?? 0;
  if (q.items.length <= MAX_SERVER_QUEUE && n <= MAX_SERVER_QUEUE) return { items: [...q.items], index: current, order: [...q.order] };
  const start = Math.min(Math.max(0, q.pos - KEEP_BEHIND), Math.max(0, n - MAX_SERVER_QUEUE));
  const kept = q.order.slice(start, start + MAX_SERVER_QUEUE);
  if (!q.shuffle) {
    // Not shuffled, the order is the items: a plain slice.
    const from = kept[0] ?? 0;
    return { items: q.items.slice(from, from + kept.length), index: current - from, order: kept.map((i) => i - from) };
  }
  const sorted = [...kept].sort((a, b) => a - b);
  const rank = new Map(sorted.map((i, r) => [i, r]));
  return { items: sorted.map((i) => q.items[i]!), index: rank.get(current) ?? 0, order: kept.map((i) => rank.get(i)!) };
}

export function fromServerQueue(s: PlayQueue): Queue {
  const n = s.items.length;
  const valid = s.shuffle && s.order && s.order.length === n && s.order.every((i) => i >= 0 && i < n) && new Set(s.order).size === n;
  const order = valid ? [...s.order!] : identity(n);
  const pos = Math.max(0, order.indexOf(Math.min(s.index, Math.max(0, n - 1))));
  return { items: [...s.items], order, pos, shuffle: Boolean(valid), repeat: s.repeat, source: s.source };
}
