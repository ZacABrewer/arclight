// Arclight ambient motion — typed port of design/arclight-kit/handoff/arclight-motion.js (v1.1).
// Keep the algorithm identical to the kit file; re-port on kit updates.
// mountBackdrop(canvas, opts) draws the moving layer of the backdrop on a <canvas>
// that sits above the static floor/spire and below the scanline + vignette.
//   - floor: horizontal grid lines drift toward the viewer (replaces the static horizontals)
//   - light cycles: comet trails running out from the vanishing point along radial lines
//   - circuit pulses: packets running down the top-right circuit bundle, node flashes on arrival
//   - horizon sweep + spire rise + core breathing
// Pauses offscreen / in hidden tabs. Under prefers-reduced-motion it paints one static frame.

type Point = [number, number];

export interface MotionPath {
  pts: Point[];
  seg: number[];
  len: number;
}

export interface MotionRadial {
  k: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MotionGeometry {
  W: number;
  H: number;
  vx: number;
  vy: number;
  radials: MotionRadial[];
  circuits: MotionPath[];
  spireTop: number;
}

export interface MotionGeometryOptions {
  /** Vanishing point x: px, or a 0–1 fraction of the width (default .53). */
  vx?: number | undefined;
  /** Horizon y: px, or a 0–1 fraction of the height (default .52). */
  vy?: number | undefined;
  circuit?: boolean | undefined;
}

export interface BackdropMotionOptions extends MotionGeometryOptions {
  spire?: boolean | undefined;
  floor?: boolean | undefined;
  speed?: number | undefined;
  /** Fixed drawing size; defaults to the canvas's client size. */
  width?: number | undefined;
  height?: number | undefined;
  maxDpr?: number | undefined;
  /** Overrides the prefers-reduced-motion check (true = one static frame). */
  reducedMotion?: boolean | undefined;
}

export interface BackdropMotion {
  destroy(): void;
}

const CY = '110,246,255',
  WH = '233,253,255';
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export function backdropGeometry(W: number, H: number, o: MotionGeometryOptions = {}): MotionGeometry {
  const px = (v: number | undefined, ref: number, def: number) => (v == null ? Math.round(ref * def) : v <= 1 ? Math.round(ref * v) : v);
  const vx = px(o.vx, W, 0.53),
    vy = px(o.vy, H, 0.52);
  const step = W / 12,
    radials: MotionRadial[] = [];
  for (let k = -16; k <= 16; k++) radials.push({ k, x1: vx, y1: vy, x2: vx + k * step * 1.6, y2: vy + (H - vy) * 1.6 });
  const circuits: MotionPath[] = [];
  if (o.circuit !== false) {
    // same seeded generator as Arclight Backdrop.dc.html (and generateBackdrop) — paths line up with the static traces
    let s = 11;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const n = Math.round(W / 110),
      ox = W * 0.58;
    for (let i = 0; i < n; i++) {
      let x = ox + i * 26,
        y = -4;
      const pts: Point[] = [[x, y]];
      y += 40 + r() * vy * 0.35;
      pts.push([x, y]);
      const d = 30 + r() * 90;
      x -= d;
      y += d;
      pts.push([x, y]);
      y += 20 + r() * vy * 0.2;
      pts.push([x, y]);
      circuits.push(withLengths(pts));
    }
  }
  return { W, H, vx, vy, radials, circuits, spireTop: Math.round(vy * 0.22) };
}

export const floorY = (g: MotionGeometry, u: number) => g.vy + ((g.H - g.vy) * 1.3) / (u + 0.6);

function withLengths(pts: Point[]): MotionPath {
  const seg: number[] = [];
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
    seg.push(l);
    len += l;
  }
  return { pts, seg, len };
}
function pointAt(p: MotionPath, d: number): Point {
  d = Math.max(0, Math.min(p.len, d));
  for (let i = 0; i < p.seg.length; i++) {
    const l = p.seg[i]!;
    if (d <= l) {
      const f = d / l;
      return [lerp(p.pts[i]![0], p.pts[i + 1]![0], f), lerp(p.pts[i]![1], p.pts[i + 1]![1], f)];
    }
    d -= l;
  }
  return p.pts[p.pts.length - 1]!;
}
function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  g.addColorStop(0, `rgba(${WH},${a})`);
  g.addColorStop(0.25, `rgba(${CY},${a * 0.6})`);
  g.addColorStop(1, `rgba(${CY},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 4, 0, Math.PI * 2);
  ctx.fill();
}

interface Cycle {
  r: MotionRadial;
  p: number;
  dur: number;
}
interface Packet {
  c: MotionPath;
  d: number;
  v: number;
}
interface Flash {
  x: number;
  y: number;
  life: number;
}

export function mountBackdrop(canvas: HTMLCanvasElement, opts: BackdropMotionOptions = {}): BackdropMotion {
  // The caller checks support first; a missing 2D context is a programming error here.
  const ctx = canvas.getContext('2d')!;
  const reduce = opts.reducedMotion ?? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const speed = opts.speed ?? 1,
    spire = opts.spire !== false,
    floor = opts.floor !== false;
  let g: MotionGeometry | null = null,
    W = 0,
    H = 0,
    raf = 0,
    last = 0,
    t = 0,
    onscreen = true,
    alive = true;
  const cycles: Cycle[] = [],
    packets: Packet[] = [],
    flashes: Flash[] = [];
  let nextCycle = 0.6,
    nextPacket = 0.4,
    nextSweep = 2.2,
    nextRise = 3.2,
    sweep: { p: number } | null = null,
    rise: { p: number } | null = null;

  function resize() {
    W = opts.width ?? canvas.clientWidth;
    H = opts.height ?? canvas.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr ?? 1.5);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    g = backdropGeometry(W, H, opts);
    draw();
  }

  function update(dt: number) {
    if (!g) return;
    const s = dt * speed;
    if ((nextCycle -= s) <= 0 && cycles.length < 2) {
      const k = (Math.random() < 0.5 ? -1 : 1) * Math.round(rnd(2, 11));
      cycles.push({ r: g.radials.find((x) => x.k === k)!, p: 0, dur: rnd(3.2, 5) });
      nextCycle = rnd(2.4, 5.5);
    }
    if (g.circuits.length && (nextPacket -= s) <= 0 && packets.length < 3) {
      packets.push({ c: g.circuits[Math.floor(Math.random() * g.circuits.length)]!, d: -10, v: rnd(90, 150) });
      nextPacket = rnd(0.9, 2.6);
    }
    if (!sweep && (nextSweep -= s) <= 0) {
      sweep = { p: 0 };
      nextSweep = rnd(6, 11);
    }
    if (spire && !rise && (nextRise -= s) <= 0) {
      rise = { p: 0 };
      nextRise = rnd(4, 7.5);
    }
    for (let i = cycles.length - 1; i >= 0; i--) if ((cycles[i]!.p += s / cycles[i]!.dur) >= 1) cycles.splice(i, 1);
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i]!,
        was = k.d;
      k.d += k.v * s;
      if (was < k.c.len && k.d >= k.c.len) {
        const e = k.c.pts[k.c.pts.length - 1]!;
        flashes.push({ x: e[0], y: e[1], life: 1 });
      }
      if (k.d - 40 > k.c.len) packets.splice(i, 1);
    }
    for (let i = flashes.length - 1; i >= 0; i--) if ((flashes[i]!.life -= s * 1.6) <= 0) flashes.splice(i, 1);
    if (sweep && (sweep.p += s / 2.4) >= 1) sweep = null;
    if (rise && (rise.p += s / 1.8) >= 1) rise = null;
  }

  function draw() {
    if (!g) return;
    ctx.clearRect(0, 0, W, H);
    if (floor) {
      const ph = reduce ? 0 : (t * 0.22 * speed) % 1;
      for (let k = 1; k <= 35; k++) {
        const y = floorY(g, k - ph);
        if (y > H + 1 || y <= g.vy + 0.5) continue;
        ctx.fillStyle = `rgba(${CY},${(0.03 + (0.15 * (y - g.vy)) / (H - g.vy)).toFixed(3)})`;
        ctx.fillRect(0, Math.round(y), W, 1);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const c of cycles) {
      const r = c.r,
        f = Math.pow(c.p, 2.1) * 0.68,
        ft = Math.max(0, f - (0.04 + 0.22 * f));
      const hx = lerp(r.x1, r.x2, f),
        hy = lerp(r.y1, r.y2, f),
        tx = lerp(r.x1, r.x2, ft),
        ty = lerp(r.y1, r.y2, ft);
      const a = Math.min(1, c.p * 6);
      const gr = ctx.createLinearGradient(tx, ty, hx, hy);
      gr.addColorStop(0, `rgba(${CY},0)`);
      gr.addColorStop(0.7, `rgba(${CY},${0.45 * a})`);
      gr.addColorStop(1, `rgba(${WH},${0.95 * a})`);
      ctx.strokeStyle = gr;
      ctx.lineWidth = 1 + 2.2 * f;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      glowDot(ctx, hx, hy, 1 + 2 * f, 0.8 * a);
    }
    for (const k of packets) {
      const h = pointAt(k.c, k.d),
        tl = pointAt(k.c, k.d - 40);
      const gr = ctx.createLinearGradient(tl[0], tl[1], h[0], h[1]);
      gr.addColorStop(0, `rgba(${CY},0)`);
      gr.addColorStop(1, `rgba(${WH},.85)`);
      ctx.strokeStyle = gr;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(tl[0], tl[1]);
      let acc = 0;
      for (let i = 0; i < k.c.seg.length; i++) {
        acc += k.c.seg[i]!;
        if (acc > k.d - 40 && acc < k.d) ctx.lineTo(k.c.pts[i + 1]![0], k.c.pts[i + 1]![1]);
      }
      ctx.lineTo(h[0], h[1]);
      ctx.stroke();
    }
    for (const f of flashes) {
      ctx.strokeStyle = `rgba(${WH},${0.9 * f.life})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      glowDot(ctx, f.x, f.y, 2.5, 0.35 * f.life);
    }
    if (sweep) {
      const e = 1 - Math.pow(1 - sweep.p, 2),
        a = Math.sin(Math.PI * sweep.p),
        off = e * W * 0.48;
      for (const x of [g.vx - off, g.vx + off]) {
        const gr = ctx.createLinearGradient(x - 90, 0, x + 90, 0);
        gr.addColorStop(0, `rgba(${WH},0)`);
        gr.addColorStop(0.5, `rgba(${WH},${0.8 * a})`);
        gr.addColorStop(1, `rgba(${WH},0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(x - 90, g.vy - 1, 180, 2);
      }
    }
    if (spire) {
      const b = reduce ? 0.14 : 0.12 + 0.07 * Math.sin(t * 1.7);
      const gr = ctx.createRadialGradient(g.vx, g.vy, 0, g.vx, g.vy, 46);
      gr.addColorStop(0, `rgba(${CY},${b})`);
      gr.addColorStop(1, `rgba(${CY},0)`);
      ctx.fillStyle = gr;
      ctx.fillRect(g.vx - 46, g.vy - 46, 92, 92);
      if (rise) {
        const y = lerp(g.vy, g.spireTop, Math.pow(rise.p, 0.8)),
          a = Math.sin(Math.PI * rise.p);
        const lg = ctx.createLinearGradient(0, y, 0, y + 70);
        lg.addColorStop(0, `rgba(${WH},${0.9 * a})`);
        lg.addColorStop(1, `rgba(${CY},0)`);
        ctx.fillStyle = lg;
        ctx.fillRect(g.vx - 1, y, 2, 70);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now: number) {
    if (!alive) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    t += dt * speed;
    if (g) {
      update(dt);
      draw();
    }
    raf = requestAnimationFrame(frame);
  }
  const play = () => {
    if (!alive || reduce || raf || !onscreen || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  };
  const pause = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => {
    onscreen = e?.isIntersecting ?? onscreen;
    if (onscreen) play();
    else pause();
  });
  io.observe(canvas);
  const vis = () => (document.hidden ? pause() : play());
  document.addEventListener('visibilitychange', vis);
  resize();
  play();

  return {
    destroy() {
      alive = false;
      pause();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', vis);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
