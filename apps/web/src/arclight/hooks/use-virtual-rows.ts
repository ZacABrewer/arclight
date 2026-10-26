import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface VirtualRowsOptions {
  count: number;
  /** Fixed row height in px (44 dense / 62 rich). */
  rowHeight: number;
  /** The scrolling element. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number | undefined;
  /** Viewport height used before the element is measured (and in jsdom). */
  initialHeight?: number | undefined;
  enabled?: boolean | undefined;
}

export interface VirtualRange {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

/** Pure range maths, exported for tests. */
export function computeVirtualRange(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan: number): VirtualRange {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.min(count - 1, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const visible = Math.ceil(viewport / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/**
 * Fixed-height row virtualisation for long tables (logs, history, releases). Returns the
 * slice to render and the spacer heights above/below it.
 */
export function useVirtualRows({ count, rowHeight, scrollRef, overscan = 8, initialHeight = 600, enabled = true }: VirtualRowsOptions): VirtualRange {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(initialHeight);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (el.clientHeight > 0) setViewport(el.clientHeight);
  }, [scrollRef]);

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [enabled, measure, scrollRef]);

  if (!enabled) return { start: 0, end: count, padTop: 0, padBottom: 0 };
  return computeVirtualRange(count, rowHeight, scrollTop, viewport, overscan);
}
