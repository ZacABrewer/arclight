// Arclight intro: the timeline maths, with no DOM and no dependencies.
//
// A port of the design file `arclight-intro.jsx` (Arc palette, wordmark on). Everything is a
// pure function of T, the time in seconds from 0 to DURATION, so a frame can be rendered for any
// T in any order (the MP4 renderer steps frame by frame; the app drives T from a clock).
// The tween and easing maths match the design tool's timeline runtime exactly.

/** Easing curves, t in [0, 1] (easeOutBack overshoots). Same formulas as the design runtime. */
export const Easing = {
  easeOutExpo: (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInExpo: (t: number): number => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  easeInOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeOutBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
} as const;

export type Ease = (t: number) => number;

/** Single-segment tween: `from` before `start`, `to` after `end`, eased in between. */
export function animate(o: { from: number; to: number; start: number; end: number; ease: Ease }): (T: number) => number {
  const { from, to, start, end, ease } = o;
  return (T) => {
    if (T <= start) return from;
    if (T >= end) return to;
    return from + (to - from) * ease((T - start) / (end - start));
  };
}

/** The three motion helpers of the design: enter (expo out), draw (cubic in-out), pop (back out). */
export const M = {
  enter: (from: number, to: number, start: number, end: number) => animate({ from, to, start, end, ease: Easing.easeOutExpo }),
  draw: (from: number, to: number, start: number, end: number) => animate({ from, to, start, end, ease: Easing.easeInOutCubic }),
  pop: (from: number, to: number, start: number, end: number) => animate({ from, to, start, end, ease: Easing.easeOutBack }),
};

/** Scenes in order with their lengths in seconds. */
export const SCENES = [
  { name: 'Ignite', dur: 1 },
  { name: 'Strike', dur: 1.4 },
  { name: 'Wordmark', dur: 1.6 },
  { name: 'Dive', dur: 1.6 },
  { name: 'Black', dur: 0.5 },
] as const;

export type SceneName = (typeof SCENES)[number]['name'];

/** Start time of each scene (running sum of the lengths, rounded to ms like the design runtime). */
export const CUES: Readonly<Record<SceneName, number>> = (() => {
  const out = {} as Record<SceneName, number>;
  let t = 0;
  for (const s of SCENES) {
    out[s.name] = Math.round(t * 1000) / 1000;
    t += s.dur;
  }
  return out;
})();

/** Total length in seconds (6.1). */
export const DURATION = Math.round(SCENES.reduce((a, s) => a + s.dur, 0) * 1000) / 1000;

/** The time of the "logo" frame: full lockup on screen, just before the dive. Used for posters and reduced motion. */
export const LOGO_TIME = 3.9;

/** Stage size the choreography is written for. */
export const STAGE_W = 1920;
export const STAGE_H = 1080;

/** Arc palette: blue, cyan, violet. */
export const PALETTE = ['#2f7bff', '#6ef6ff', '#8b6bff'] as const;

/** Length used for the front chevron's stroke-dash draw-on. */
export const CHEV_LEN = 80;

/** Wordmark: letters, font size (px on the stage) and line height. */
export const WORD = 'ARCLIGHT';
export const WORD_FONT_SIZE = 84;
export const WORD_LINE_HEIGHT = 1.2;
/** The wordmark block's left edge on the stage. */
export const WORD_LEFT = 840;

export interface Stripe {
  i: number;
  /** Offset from the centre in stripe units. */
  off: number;
  /** Width in px. */
  w: number;
  /** Palette index. */
  c: number;
  /** Start delay in s. */
  d: number;
}

/** The 44 dive ribbons (deterministic pseudo-random widths, colours and delays). */
export const STRIPES: readonly Stripe[] = Array.from({ length: 44 }, (_, i) => {
  const r = Math.sin(i * 91.7) * 43758.5453;
  const f = r - Math.floor(r);
  return { i, off: i - 21.5, w: 6 + f * 22, c: Math.floor(f * 3) % 3, d: f * 0.25 };
});

/** Linear mix between palette blue and cyan, k in [0, 1], as an rgb() string. */
export function mixColor(k: number, a: string = PALETTE[0], b: string = PALETTE[1]): string {
  const h = (c: string) => [1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16));
  const A = h(a);
  const B = h(b);
  return `rgb(${A.map((v, j) => Math.round(v + ((B[j] ?? 0) - v) * k)).join(',')})`;
}

export interface LetterFrame {
  opacity: number;
  /** Vertical offset in px. */
  y: number;
}

export interface RibbonFrame {
  /** Centre x on the stage. */
  x: number;
  /** Height in px (centred on y = 540). */
  h: number;
  /** Final opacity (already includes the 0.85 factor of the design). */
  opacity: number;
}

/** Every animated value of one frame. */
export interface IntroFrame {
  T: number;
  /** Background glow and mark opacity. */
  markO: number;
  ignite: { w: number; opacity: number };
  flash: { r: number; opacity: number };
  ribbons: RibbonFrame[];
  mark: {
    /** Horizontal shift of the mark box (it slides left for the wordmark, back for the dive). */
    shiftX: number;
    /** Scale of the mark box: dive zoom times slow drift. */
    scale: number;
    /** Inner pop scale of the svg. */
    pop: number;
    frontDashOffset: number;
    frontOpacity: number;
    backX: number;
    backOpacity: number;
  };
  word: {
    opacity: number;
    /** Letter spacing in em. */
    tracking: number;
    /** Glowing centre line scaleX, 0..1. */
    line: number;
    letters: LetterFrame[];
  };
}

/** All values of the frame at time T (seconds, clamped to 0..DURATION). */
export function introFrame(T0: number): IntroFrame {
  const T = Math.min(Math.max(T0, 0), DURATION);
  const C = CUES;
  const s = C.Strike;

  // Ignite: a line of light grows, then collapses into the strike.
  const grow = M.enter(0, 1500, 0.15, 0.7)(T);
  const shrink = M.draw(1, 0, 0.7, s + 0.15)(T);
  const ignite = { w: grow * shrink, opacity: T > s + 0.2 ? 0 : 1 };

  // Flash: radial burst as the chevron lands.
  const t0 = s + 0.42;
  const flashO = M.enter(0, 1, t0, t0 + 0.12)(T) * M.draw(1, 0, t0 + 0.12, t0 + 1.0)(T);
  const flash = { r: M.enter(200, 900, t0, t0 + 1.0)(T), opacity: flashO * 0.8 };

  // Ribbons: burst outward during the dive, fade before the black.
  const d = C.Dive;
  const ribbons = STRIPES.map((st) => {
    const a = d + 0.35 + st.d;
    const spread = M.enter(4, 70, a, a + 1.2)(T);
    const h = M.enter(0, 1400, a, a + 0.5)(T);
    const o = M.draw(0, 1, a, a + 0.25)(T) * M.draw(1, 0, C.Black - 0.35, C.Black)(T);
    return { x: 960 + st.off * spread, h, opacity: o * 0.85 };
  });

  // Mark.
  const frontDashOffset = M.enter(CHEV_LEN, 0, s, s + 0.5)(T);
  const mark = {
    shiftX: M.draw(0, -420, C.Wordmark - 0.1, C.Wordmark + 0.7)(T) - M.draw(0, -420, C.Dive, C.Dive + 0.6)(T),
    scale:
      M.draw(1, 1, 0, 1)(T) *
      animate({ from: 1, to: 22, start: C.Dive + 0.3, end: C.Black - 0.1, ease: Easing.easeInExpo })(T) *
      M.draw(1, 1.04, s, C.Dive)(T),
    pop: T < s + 0.45 ? 0.92 : M.pop(0.92, 1, s + 0.45, s + 0.9)(T),
    frontDashOffset,
    frontOpacity: frontDashOffset >= CHEV_LEN - 0.01 ? 0 : 1,
    backX: M.enter(-26, 0, s + 0.3, s + 0.85)(T),
    backOpacity: M.draw(0, 0.45, s + 0.3, s + 0.8)(T),
  };
  const markO = T < s ? 0 : M.draw(1, 0, C.Black - 0.5, C.Black - 0.1)(T);

  // Wordmark: letters type in with a stagger while the tracking tightens.
  const w = C.Wordmark;
  const word = {
    opacity: M.draw(1, 0, C.Dive, C.Dive + 0.35)(T),
    tracking: M.enter(0.5, 0.22, w, w + 1.1)(T),
    line: M.enter(0, 1, w + 0.35, w + 1.1)(T),
    letters: [...WORD].map((_, i) => {
      const a = w + 0.05 + i * 0.06;
      return { opacity: M.draw(0, 1, a, a + 0.35)(T), y: M.enter(30, 0, a, a + 0.5)(T) };
    }),
  };

  return { T, markO, ignite, flash, ribbons, mark, word };
}
