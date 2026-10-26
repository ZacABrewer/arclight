import { afterEach, describe, expect, it, vi } from 'vitest';
import { backdropGeometry, mountBackdrop } from './arclight-motion.js';
import { generateBackdrop } from './Backdrop.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('backdropGeometry', () => {
  it('uses the static backdrop seed: circuit paths line up with generateBackdrop', () => {
    for (const [W, H] of [
      [1440, 960],
      [1280, 720],
      [1920, 1080],
    ] as const) {
      const g = backdropGeometry(W, H, { vx: 0.53, vy: 0.52 });
      const s = generateBackdrop(W, H);
      expect(g.vx).toBe(s.vx);
      expect(g.vy).toBe(s.vy);
      expect(g.radials).toHaveLength(s.radials.length);
      const segments = g.circuits.flatMap((c) => c.pts.slice(0, -1).map((p, i) => ({ x1: p[0], y1: p[1], x2: c.pts[i + 1]![0], y2: c.pts[i + 1]![1] })));
      expect(segments).toEqual(s.circuit.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 })));
    }
  });

  it('takes px or 0–1 fractions and drops the circuit when off', () => {
    expect(backdropGeometry(1000, 1000, { vx: 500, vy: 0.6 })).toMatchObject({ vx: 500, vy: 600 });
    expect(backdropGeometry(1000, 1000, { circuit: false }).circuits).toHaveLength(0);
  });
});

function fakeContext() {
  const gradient = { addColorStop: vi.fn() };
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
    globalCompositeOperation: 'source-over',
  };
}

describe('mountBackdrop', () => {
  it('reduced motion: paints one static frame, never loops, and cleans up on destroy', () => {
    const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    class Obs {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor() {
        observers.push(this);
      }
    }
    vi.stubGlobal('ResizeObserver', Obs);
    vi.stubGlobal('IntersectionObserver', Obs);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const ctx = fakeContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const removed = vi.spyOn(document, 'removeEventListener');

    const ctl = mountBackdrop(canvas, { width: 1440, height: 960, reducedMotion: true });
    expect(raf).not.toHaveBeenCalled();
    expect(canvas.width).toBe(1440 * Math.min(window.devicePixelRatio || 1, 1.5));
    // the floor lines are painted (static frame)
    expect(ctx.fillRect).toHaveBeenCalled();

    ctl.destroy();
    expect(observers).toHaveLength(2);
    for (const o of observers) expect(o.disconnect).toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('runs a frame loop when motion is allowed and stops it on destroy', () => {
    class Obs {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Obs);
    vi.stubGlobal('IntersectionObserver', Obs);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42);
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(fakeContext() as unknown as CanvasRenderingContext2D);
    const ctl = mountBackdrop(canvas, { width: 800, height: 600, reducedMotion: false });
    expect(raf).toHaveBeenCalledTimes(1);
    ctl.destroy();
    expect(caf).toHaveBeenCalledWith(42);
  });
});
