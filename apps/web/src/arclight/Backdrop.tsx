import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { mountBackdrop } from './arclight-motion.js';
import { cx } from './cx.js';
import { useOsReducedMotion } from './hooks/use-media-query.js';
import { useReduceMotionSetting } from './motion-preference.js';

// Port of the generator in "Arclight Backdrop.dc.html" (≈40 lines) to an SVG layer:
// perspective grid floor (radial lines from the vanishing point + horizontals spaced
// (H - vy) * 1.3 / (k + .6)), horizon radial sky, 2px horizon line + bloom, a single spire of
// light at the vanishing point with a core dot and floor reflection, a faint circuit bundle
// top-right at 16%, and the scanline + vignette (from .al-backdrop::after in arclight.css).
// v1.1: the moving layer (arclight-motion.ts) draws on a canvas above the spire; while it runs
// it owns the horizontal floor lines, so the static ones are dropped.

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Stroke opacity of cyan rgba(110,246,255,a). */
  a: number;
}

export interface BackdropGeometry {
  width: number;
  height: number;
  vx: number;
  vy: number;
  radials: Segment[];
  horizontals: Segment[];
  circuit: Segment[];
  nodes: Array<{ x: number; y: number }>;
  spire: { x: number; top: number; height: number; reflectionHeight: number };
}

export interface BackdropOptions {
  /** Vanishing point x as a fraction of width (default .53). */
  vx?: number | undefined;
  /** Horizon y as a fraction of height (default .52). */
  horizon?: number | undefined;
  circuit?: boolean | undefined;
}

/** Pure generator — same maths as the kit's `renderVals()`. */
export function generateBackdrop(W: number, H: number, opts: BackdropOptions = {}): BackdropGeometry {
  const vx = Math.round(W * (opts.vx ?? 0.53));
  const vy = Math.round(H * (opts.horizon ?? 0.52));
  const radials: Segment[] = [];
  const horizontals: Segment[] = [];
  const circuit: Segment[] = [];
  const nodes: Array<{ x: number; y: number }> = [];
  const step = W / 12;
  for (let k = -16; k <= 16; k++) {
    radials.push({ x1: vx, y1: vy, x2: vx + k * step * 1.6, y2: vy + (H - vy) * 1.6, a: k === 0 ? 0.18 : 0.1 });
  }
  for (let k = 1; k <= 34; k++) {
    const y = vy + ((H - vy) * 1.3) / (k + 0.6);
    if (y > H || y <= vy) continue;
    horizontals.push({ x1: 0, y1: y, x2: W, y2: y, a: Number((0.03 + (0.15 * (y - vy)) / (H - vy)).toFixed(3)) });
  }
  if (opts.circuit ?? true) {
    let s = 11;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const n = Math.round(W / 110);
    const ox = W * 0.58;
    for (let i = 0; i < n; i++) {
      let x = ox + i * 26;
      let y = -4;
      const pts: Array<[number, number]> = [[x, y]];
      y += 40 + r() * vy * 0.35;
      pts.push([x, y]);
      const d = 30 + r() * 90;
      x -= d;
      y += d;
      pts.push([x, y]);
      y += 20 + r() * vy * 0.2;
      pts.push([x, y]);
      for (let j = 0; j < pts.length - 1; j++) {
        const [ax, ay] = pts[j]!;
        const [bx, by] = pts[j + 1]!;
        circuit.push({ x1: ax, y1: ay, x2: bx, y2: by, a: 0.16 });
      }
      nodes.push({ x, y });
    }
  }
  const top = Math.round(vy * 0.22);
  return {
    width: W,
    height: H,
    vx,
    vy,
    radials,
    horizontals,
    circuit,
    nodes,
    spire: { x: vx, top, height: vy - top, reflectionHeight: Math.round((H - vy) * 0.45) },
  };
}

function useViewportSize(): { w: number; h: number } {
  const read = () => ({
    w: typeof window === 'undefined' ? 1440 : window.innerWidth || 1440,
    h: typeof window === 'undefined' ? 960 : window.innerHeight || 960,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      // Coalesce resize bursts into one update per frame (a single frame, not a loop).
      frame = requestAnimationFrame(() => setSize(read()));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(frame);
    };
  }, []);
  return size;
}

export interface BackdropProps {
  /** The light spire at the vanishing point. Turn off on dense pages (Details). */
  spire?: boolean | undefined;
  /** The faint circuit bundle top-right. */
  circuit?: boolean | undefined;
  /** Vanishing point x (fraction of width, default .53). Login uses .5. */
  vx?: number | undefined;
  /** Horizon y (fraction of height, default .52). */
  horizon?: number | undefined;
  /**
   * The ambient motion canvas (v1.1: floor drift, light cycles, circuit pulses, horizon sweep,
   * spire rise). On by default; the global "Reduce motion" switch turns it off everywhere.
   */
  motion?: boolean | undefined;
  /** Render inside the parent (absolute) instead of fixed to the viewport (gallery previews). */
  contained?: boolean | undefined;
  /** Fixed size for contained previews; defaults to the viewport. */
  width?: number | undefined;
  height?: number | undefined;
  className?: string | undefined;
}

/** The motion layer needs a 2D canvas plus the observers it pauses/resizes with (jsdom has neither). */
function canvasMotionSupported(canvas: HTMLCanvasElement): boolean {
  if (typeof ResizeObserver === 'undefined' || typeof IntersectionObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') return false;
  try {
    return !!canvas.getContext('2d');
  } catch {
    return false;
  }
}

/** `<Backdrop>` — fixed, z 0, pointer-events none, aria-hidden. */
export function Backdrop({ spire = true, circuit = true, vx, horizon, motion = true, contained, width, height, className }: BackdropProps) {
  const viewport = useViewportSize();
  const W = width ?? viewport.w;
  const H = height ?? viewport.h;
  const reduceSetting = useReduceMotionSetting();
  const osReduced = useOsReducedMotion();
  const geo = useMemo(() => generateBackdrop(W, H, { vx, horizon, circuit }), [W, H, vx, horizon, circuit]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // "Reduce motion" on = no canvas at all; off = run it even when the OS asks to reduce;
  // system = mount it and let the module paint one static frame under prefers-reduced-motion.
  const withCanvas = motion && reduceSetting !== 'on';
  const reducedMotion = reduceSetting === 'off' ? false : osReduced;
  // True once the canvas draws the floor, so the static horizontals step aside.
  const [live, setLive] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!withCanvas || !canvas || !canvasMotionSupported(canvas)) return;
    // Same size and fractions as the SVG layer, so the drawn floor and circuit pulses line up
    // with the static radials and traces (the SVG is stretched the same way).
    const ctl = mountBackdrop(canvas, {
      width: W,
      height: H,
      vx: vx ?? 0.53,
      vy: horizon ?? 0.52,
      spire,
      circuit,
      speed: 1,
      reducedMotion,
    });
    setLive(true);
    return () => {
      ctl.destroy();
      setLive(false);
    };
  }, [withCanvas, W, H, vx, horizon, spire, circuit, reducedMotion]);

  const skyPos = `${Math.round((geo.vx / W) * 100)}% ${Math.round((geo.vy / H) * 100)}%`;
  const rootStyle: CSSProperties = {
    background: `radial-gradient(70% 38% at ${skyPos}, var(--al-horizon) 0%, var(--al-deep) 50%, var(--al-void) 85%)`,
    ...(contained ? { position: 'absolute' } : null),
  };
  const floorLive = withCanvas && live;

  return (
    <div className={cx('al-backdrop', className)} style={rootStyle} aria-hidden="true" data-testid="al-backdrop" data-motion-live={floorLive || undefined}>
      <svg className="al-backdrop__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" focusable="false">
        <g stroke="rgb(110,246,255)" strokeWidth={1}>
          {geo.radials.map((s, i) => (
            <line key={`r${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} strokeOpacity={s.a} />
          ))}
        </g>
        {floorLive ? null : (
          <g stroke="rgb(110,246,255)" strokeWidth={1} shapeRendering="crispEdges" data-testid="al-backdrop-floor">
            {geo.horizontals.map((s, i) => (
              <line key={`h${i}`} x1={0} y1={s.y1} x2={W} y2={s.y2} strokeOpacity={s.a} />
            ))}
          </g>
        )}
        {circuit ? (
          <g data-testid="al-backdrop-circuit">
            <g stroke="rgb(110,246,255)" strokeWidth={1} strokeOpacity={0.16} fill="none">
              {geo.circuit.map((s, i) => (
                <line key={`c${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
              ))}
            </g>
            {geo.nodes.map((n, i) => (
              <circle key={`n${i}`} cx={n.x} cy={n.y} r={3} fill="#000" stroke="rgb(110,246,255)" strokeOpacity={0.35} strokeWidth={1} />
            ))}
          </g>
        ) : null}
      </svg>
      <div className="al-horizon" style={{ top: geo.vy - 1 }} />
      <div className="al-backdrop__bloom" style={{ top: geo.vy - 60 }} />
      {spire ? (
        <div data-testid="al-backdrop-spire">
          <div className="al-backdrop__spire" style={{ left: geo.spire.x - 1, top: geo.spire.top, height: geo.spire.height }} />
          <div className="al-backdrop__reflection" style={{ left: geo.spire.x - 6, top: geo.vy, height: geo.spire.reflectionHeight }} />
          <div className="al-backdrop__core" style={{ left: geo.spire.x - 7, top: geo.vy - 7 }} />
        </div>
      ) : null}
      {/* v1.1 motion layer: after the spire, below the scanline + vignette (.al-backdrop::after). */}
      {withCanvas ? <canvas ref={canvasRef} className="al-backdrop__motion" aria-hidden="true" data-testid="al-backdrop-motion" /> : null}
    </div>
  );
}
