import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

// Virtualisation for rows of different heights (wrapped names and descriptions): every
// rendered row reports its measured height, unmeasured rows use the estimate. Offsets are
// prefix sums; the first visible row is found by binary search.

export interface MeasuredRange {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

/** Pure maths, exported for tests. `heights[i]` is the known or estimated height of row i. */
export function measuredRange(heights: readonly number[], scrollTop: number, viewport: number, overscan: number): MeasuredRange & { offsets: number[] } {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) offsets[i + 1] = (offsets[i] as number) + (heights[i] as number);
  const total = offsets[heights.length] as number;
  if (heights.length === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, offsets };
  // first row whose bottom is below scrollTop
  let lo = 0;
  let hi = heights.length - 1;
  const top = Math.max(0, scrollTop);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid + 1] as number) <= top) lo = mid + 1;
    else hi = mid;
  }
  let last = lo;
  while (last < heights.length - 1 && (offsets[last + 1] as number) < top + viewport) last++;
  const start = Math.max(0, lo - overscan);
  const end = Math.min(heights.length, last + 1 + overscan);
  return { start, end, padTop: offsets[start] as number, padBottom: total - (offsets[end] as number), offsets };
}

export interface MeasuredRowsOptions {
  keys: readonly string[];
  estimate: number;
  scrollRef: RefObject<HTMLElement | null>;
  overscan?: number;
  /** Viewport before measurement (and in jsdom). */
  initialHeight?: number;
}

export function useMeasuredRows({ keys, estimate, scrollRef, overscan = 6, initialHeight = 600 }: MeasuredRowsOptions) {
  const sizes = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(initialHeight);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (el.clientHeight > 0) setViewport(el.clientHeight);
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      ro?.disconnect();
    };
  }, [scrollRef, sync]);

  // One observer for every rendered row; a changed height triggers one re-layout.
  const rowObserver = useMemo(
    () =>
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((items) => {
            let changed = false;
            for (const item of items) {
              const key = (item.target as HTMLElement).dataset['rowKey'];
              const h = Math.round((item.target as HTMLElement).getBoundingClientRect().height);
              if (key && h > 0 && sizes.current.get(key) !== h) {
                sizes.current.set(key, h);
                changed = true;
              }
            }
            if (changed) setVersion((v) => v + 1);
          })
        : null,
    [],
  );
  useEffect(() => () => rowObserver?.disconnect(), [rowObserver]);

  /** Ref callback for a row element carrying `data-row-key`. */
  const measure = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const key = el.dataset['rowKey'];
      const h = Math.round(el.getBoundingClientRect().height);
      if (key && h > 0 && sizes.current.get(key) !== h) sizes.current.set(key, h);
      rowObserver?.observe(el);
    },
    [rowObserver],
  );

  const heights = useMemo(() => keys.map((k) => sizes.current.get(k) ?? estimate), [keys, estimate, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const range = measuredRange(heights, scrollTop, viewport, overscan);

  /** Scroll so row i is fully visible. */
  const scrollToIndex = useCallback(
    (i: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = range.offsets[i] ?? 0;
      const bottom = range.offsets[i + 1] ?? top;
      const height = el.clientHeight || viewport;
      let next: number | null = null;
      if (top < el.scrollTop) next = top;
      else if (bottom > el.scrollTop + height) next = bottom - height;
      if (next === null) return;
      el.scrollTop = next;
      // Render the new window now; the scroll event (if any) confirms it.
      setScrollTop(next);
    },
    [range.offsets, scrollRef, viewport],
  );

  // Re-sync after a layout change so a shrinking list never leaves the viewport past the end.
  useLayoutEffect(() => {
    sync();
  }, [keys.length, sync]);

  return { ...range, measure, scrollToIndex };
}
