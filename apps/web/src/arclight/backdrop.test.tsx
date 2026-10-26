import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Backdrop, generateBackdrop } from './Backdrop.js';
import { mountBackdrop } from './arclight-motion.js';
import { setReduceMotion } from './motion-preference.js';

const { destroy } = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock('./arclight-motion.js', () => ({ mountBackdrop: vi.fn(() => ({ destroy })) }));

function mockReducedMotion(reduce: boolean) {
  const mql = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(mql) });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setReduceMotion('system');
  // @ts-expect-error — remove the mock so other tests see jsdom's default (no matchMedia)
  delete window.matchMedia;
});

describe('generateBackdrop', () => {
  it('ports the kit generator: 33 radials, horizontals below the horizon, circuit bundle', () => {
    const g = generateBackdrop(1440, 960);
    expect(g.vx).toBe(763);
    expect(g.vy).toBe(499);
    expect(g.radials).toHaveLength(33);
    expect(g.radials[16]!.a).toBe(0.18); // centre line is brighter
    expect(g.horizontals.length).toBeGreaterThan(20);
    for (const h of g.horizontals) {
      expect(h.y1).toBeGreaterThan(g.vy);
      expect(h.y1).toBeLessThanOrEqual(960);
    }
    // spacing shrinks toward the horizon (perspective)
    const ys = g.horizontals.map((h) => h.y1);
    expect(ys[0]! - ys[1]!).toBeGreaterThan(ys[5]! - ys[6]!);
    const n = Math.round(1440 / 110);
    expect(g.nodes).toHaveLength(n);
    expect(g.circuit).toHaveLength(n * 3);
    expect(g.spire.top).toBe(Math.round(g.vy * 0.22));
  });

  it('is deterministic and honours circuit=false and custom vanishing point', () => {
    expect(generateBackdrop(800, 600)).toEqual(generateBackdrop(800, 600));
    const g = generateBackdrop(1000, 1000, { circuit: false, vx: 0.5, horizon: 0.6 });
    expect(g.circuit).toHaveLength(0);
    expect(g.vx).toBe(500);
    expect(g.vy).toBe(600);
  });
});

describe('<Backdrop>', () => {
  it('is a decorative fixed layer with spire and circuit by default', () => {
    render(<Backdrop />);
    const root = screen.getByTestId('al-backdrop');
    expect(root.className).toContain('al-backdrop');
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('al-backdrop-spire')).toBeTruthy();
    expect(screen.getByTestId('al-backdrop-circuit')).toBeTruthy();
  });

  it('drops the spire and circuit when turned off', () => {
    render(<Backdrop spire={false} circuit={false} />);
    expect(screen.queryByTestId('al-backdrop-spire')).toBeNull();
    expect(screen.queryByTestId('al-backdrop-circuit')).toBeNull();
  });

  it('without canvas support (jsdom) keeps the static floor and mounts nothing', () => {
    render(<Backdrop />);
    expect(mountBackdrop).not.toHaveBeenCalled();
    expect(screen.getByTestId('al-backdrop-floor')).toBeTruthy();
    expect(screen.getByTestId('al-backdrop').hasAttribute('data-motion-live')).toBe(false);
  });
});

describe('<Backdrop> motion layer (v1.1)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as CanvasRenderingContext2D);
  });

  it('mounts the canvas after the spire, drops the static floor and destroys on unmount', () => {
    mockReducedMotion(false);
    const { unmount } = render(<Backdrop width={1440} height={960} />);
    const canvas = screen.getByTestId('al-backdrop-motion');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.className).toBe('al-backdrop__motion');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('al-backdrop-spire').compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mountBackdrop).toHaveBeenCalledTimes(1);
    expect(mountBackdrop).toHaveBeenCalledWith(canvas, {
      width: 1440,
      height: 960,
      vx: 0.53,
      vy: 0.52,
      spire: true,
      circuit: true,
      speed: 1,
      reducedMotion: false,
    });
    // The canvas draws the floor; radials, circuit and spire stay static.
    expect(screen.queryByTestId('al-backdrop-floor')).toBeNull();
    expect(screen.getByTestId('al-backdrop-circuit')).toBeTruthy();
    expect(screen.getByTestId('al-backdrop').getAttribute('data-motion-live')).toBe('true');
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('passes the spire/circuit props and the vanishing point, remounting when they change', () => {
    const { rerender } = render(<Backdrop width={800} height={600} vx={0.5} horizon={0.6} spire={false} circuit={false} />);
    expect(mountBackdrop).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ vx: 0.5, vy: 0.6, spire: false, circuit: false }));
    rerender(<Backdrop width={800} height={600} vx={0.5} horizon={0.6} spire circuit={false} />);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(mountBackdrop).toHaveBeenCalledTimes(2);
    expect(mountBackdrop).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ spire: true }));
  });

  it('under prefers-reduced-motion still mounts, asking the module for one static frame', () => {
    mockReducedMotion(true);
    render(<Backdrop />);
    expect(mountBackdrop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reducedMotion: true }));
  });

  it('motion={false} renders no canvas and keeps the static floor', () => {
    render(<Backdrop motion={false} />);
    expect(screen.queryByTestId('al-backdrop-motion')).toBeNull();
    expect(mountBackdrop).not.toHaveBeenCalled();
    expect(screen.getByTestId('al-backdrop-floor')).toBeTruthy();
  });

  it('the "Reduce motion" switch destroys the canvas and sets data-motion="off" on the root', () => {
    mockReducedMotion(false);
    render(<Backdrop />);
    expect(mountBackdrop).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);

    act(() => setReduceMotion('on'));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('al-backdrop-motion')).toBeNull();
    expect(screen.getByTestId('al-backdrop-floor')).toBeTruthy();
    expect(document.documentElement.getAttribute('data-motion')).toBe('off');

    act(() => setReduceMotion('system'));
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
    expect(mountBackdrop).toHaveBeenCalledTimes(2);
  });

  it('"Reduce motion" off keeps the canvas running even when the OS asks to reduce', () => {
    mockReducedMotion(true);
    act(() => setReduceMotion('off'));
    render(<Backdrop />);
    expect(mountBackdrop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reducedMotion: false }));
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
  });
});

describe('<Backdrop> layout', () => {
  it('re-lays out on resize', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const { container } = render(<Backdrop />);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 800 600');
  });
});
