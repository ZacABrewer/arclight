// Geometry of D-pad navigation: from the focused element's box, which box is "next" in a
// direction. Written for this app (no library): a candidate must lie further along the direction
// than the origin; among those, the closest one wins, where distance along the direction counts
// once and sideways misalignment counts several times over (so moving down a column of posters
// stays in the column, and moving right along a row stays in the row). Boxes that share a lane
// with the origin (their sideways ranges overlap) are preferred through that weighting.

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How much sideways distance (outside the lane) costs against forward distance. */
const SIDEWAYS_WEIGHT = 3;
/** Tie-break on centre alignment for boxes in the same lane. */
const ALIGN_WEIGHT = 0.25;

const horizontal = (d: Direction) => d === 'left' || d === 'right';

/** Gap between two ranges (0 when they overlap). */
function gap(a1: number, a2: number, b1: number, b2: number): number {
  if (b2 < a1) return a1 - b2;
  if (b1 > a2) return b1 - a2;
  return 0;
}

/** Whether `c` lies beyond `o` in direction `d` (its centre and its far edge both past the origin's). */
export function isBeyond(o: Box, c: Box, d: Direction): boolean {
  const ocx = (o.left + o.right) / 2;
  const ocy = (o.top + o.bottom) / 2;
  const ccx = (c.left + c.right) / 2;
  const ccy = (c.top + c.bottom) / 2;
  switch (d) {
    case 'right':
      return ccx > ocx + 0.5 && c.right > o.right + 0.5;
    case 'left':
      return ccx < ocx - 0.5 && c.left < o.left - 0.5;
    case 'down':
      return ccy > ocy + 0.5 && c.bottom > o.bottom + 0.5;
    case 'up':
      return ccy < ocy - 0.5 && c.top < o.top - 0.5;
  }
}

/** Lower is closer; Infinity when `c` is not in direction `d` at all. */
export function score(o: Box, c: Box, d: Direction): number {
  if (!isBeyond(o, c, d)) return Infinity;
  let forward: number;
  if (d === 'right') forward = Math.max(0, c.left - o.right);
  else if (d === 'left') forward = Math.max(0, o.left - c.right);
  else if (d === 'down') forward = Math.max(0, c.top - o.bottom);
  else forward = Math.max(0, o.top - c.bottom);
  const sideways = horizontal(d) ? gap(o.top, o.bottom, c.top, c.bottom) : gap(o.left, o.right, c.left, c.right);
  const align = horizontal(d) ? Math.abs((o.top + o.bottom) / 2 - (c.top + c.bottom) / 2) : Math.abs((o.left + o.right) / 2 - (c.left + c.right) / 2);
  return forward + sideways * SIDEWAYS_WEIGHT + align * ALIGN_WEIGHT;
}

/** Index of the best candidate in direction `d`, or -1. */
export function pickNext(origin: Box, candidates: readonly Box[], d: Direction): number {
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    const s = score(origin, c, d);
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  });
  return best;
}

/** Arrow key → direction (also the old Android "DPAD" key names some WebViews send). */
export function directionOf(key: string): Direction | null {
  switch (key) {
    case 'ArrowUp':
    case 'Up':
      return 'up';
    case 'ArrowDown':
    case 'Down':
      return 'down';
    case 'ArrowLeft':
    case 'Left':
      return 'left';
    case 'ArrowRight':
    case 'Right':
      return 'right';
    default:
      return null;
  }
}
