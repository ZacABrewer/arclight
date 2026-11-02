// The "Light Slice" wordmark for the apps (web and mobile Wordmark components): the ARCLIGHT
// letters (Michroma outlines, SIL Open Font License 1.1, see wordmark-path.ts) with a gap cut
// through the middle and a thin light line in the gap, as in intro/wordmark.svg.
// One source for both apps: they import this file, and wordmark-path.ts is generated from
// intro/wordmark.svg by intro/scripts/gen-lockups.mjs.

export { WORDMARK_LETTERS } from './wordmark-path.js';

/** Letter extent in wordmark units (the C and G overshoot the 27..90 cap box slightly). */
export const WORDMARK_BOX = { x: 0, y: 25, width: 740, height: 67 } as const;
export const WORDMARK_VIEWBOX = `${WORDMARK_BOX.x} ${WORDMARK_BOX.y} ${WORDMARK_BOX.width} ${WORDMARK_BOX.height}`;
/** Width / height of the rendered wordmark. */
export const WORDMARK_ASPECT = WORDMARK_BOX.width / WORDMARK_BOX.height;
/** Width the light line and the gradients span. */
export const WORDMARK_SPAN = 738;

/** The slice at full size (intro/wordmark.svg): a 6-unit gap from y 55.5 and a 1.5-unit line at 57.75. */
const CUT = { y: 55.5, height: 6 } as const;
const LINE = { y: 57.75, height: 1.5 } as const;
const CENTRE = CUT.y + CUT.height / 2;

/** Smallest gap and line on screen, in CSS px, so the cut still reads at top-bar size. */
export const MIN_CUT_PX = 2.5;
export const MIN_LINE_PX = 1;

export interface SliceGeometry {
  cutY: number;
  cutHeight: number;
  lineY: number;
  lineHeight: number;
}

/**
 * The gap and line for a wordmark drawn `heightPx` tall (the svg's height). Large, this is the
 * brand geometry. Below about 28 px the 6-unit gap would be under MIN_CUT_PX on screen, and below
 * about 45 px the 1.5-unit line under MIN_LINE_PX, so they are widened to those minimums, still
 * centred where the brand puts them (at 16 px: a 2.5 px gap, about 16% of the cap height instead
 * of 9.5%, with a 1 px line in it).
 */
export function sliceGeometry(heightPx: number): SliceGeometry {
  const unitsPerPx = heightPx > 0 ? WORDMARK_BOX.height / heightPx : 0;
  const cutHeight = Math.max(CUT.height, MIN_CUT_PX * unitsPerPx);
  const lineHeight = Math.max(LINE.height, MIN_LINE_PX * unitsPerPx);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    cutY: round(CENTRE - cutHeight / 2),
    cutHeight: round(cutHeight),
    lineY: round(CENTRE - lineHeight / 2),
    lineHeight: round(lineHeight),
  };
}
