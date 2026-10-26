import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Backdrop, generateBackdrop } from './Backdrop.js';

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
  vi.restoreAllMocks();
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

  it('static by default: no requestAnimationFrame loop', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<Backdrop />);
    expect(raf).not.toHaveBeenCalled();
  });

  it('animate + prefers-reduced-motion: no requestAnimationFrame loop', () => {
    mockReducedMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<Backdrop animate />);
    expect(raf).not.toHaveBeenCalled();
    expect(screen.getByTestId('al-backdrop').hasAttribute('data-animated')).toBe(false);
  });

  it('animate without reduced motion starts the loop and cancels it on unmount', () => {
    mockReducedMotion(false);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 7);
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const { unmount } = render(<Backdrop animate />);
    expect(raf).toHaveBeenCalled();
    expect(screen.getByTestId('al-backdrop').getAttribute('data-animated')).toBe('true');
    unmount();
    expect(caf).toHaveBeenCalledWith(7);
  });

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
