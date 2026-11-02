import type { PlayableChapter, PlayableItem, PlayablePart } from '@arclight/shared';

// One item, one timeline: an audiobook spread over many files plays as a single position from 0
// to durationMs. These helpers map between that global position and (part, local offset).

/** Index of the part that holds `globalMs` (clamped to the item). */
export function partIndexAt(parts: readonly PlayablePart[], globalMs: number): number {
  let index = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.startMs <= globalMs) index = i;
    else break;
  }
  return index;
}

export interface TimelinePoint {
  partIndex: number;
  /** Offset inside that part's file. */
  localMs: number;
}

/** Where `globalMs` falls: part and offset inside it. */
export function locate(item: Pick<PlayableItem, 'parts' | 'durationMs'>, globalMs: number): TimelinePoint {
  const ms = clamp(globalMs, 0, Math.max(0, item.durationMs));
  const partIndex = partIndexAt(item.parts, ms);
  const part = item.parts[partIndex]!;
  return { partIndex, localMs: clamp(ms - part.startMs, 0, Math.max(0, part.durationMs)) };
}

/** Global position of a local offset in a part. */
export function globalPosition(part: Pick<PlayablePart, 'startMs' | 'durationMs'>, localMs: number): number {
  return part.startMs + clamp(localMs, 0, Math.max(0, part.durationMs));
}

/** Index of the chapter playing at `globalMs`, or -1 when the item has none. */
export function chapterIndexAt(chapters: readonly PlayableChapter[], globalMs: number): number {
  let index = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.startMs <= globalMs) index = i;
    else break;
  }
  return chapters.length > 0 && index === -1 ? 0 : index;
}

/** The chapter's [start, end) on the book timeline (end clamped to the book). */
export function chapterBounds(chapters: readonly PlayableChapter[], index: number, durationMs: number): { startMs: number; endMs: number } | null {
  const ch = chapters[index];
  if (!ch) return null;
  const next = chapters[index + 1];
  const end = next ? next.startMs : ch.startMs + ch.durationMs;
  return { startMs: ch.startMs, endMs: Math.min(Math.max(end, ch.startMs), durationMs || end) };
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
