// Scrolling on the TV stage (spec §4.3, the design's ensureVisible). Every scroller on the stage
// is overflow:hidden and moved only from here, so focus decides what is on screen:
//
//  - [data-tv-scroll="x"] (a row's tiles): keep the focused tile 56 stage px inside both edges;
//  - [data-tv-scroll="y"] (a page): the focused element's row ([data-tv-row], or the element)
//    keeps a top margin of [data-tv-mtop] (default 96, below the header) and 40 at the bottom;
//    anything inside [data-tv-ytop] (the hero / detail buttons) scrolls the page back to the top.
//
// Moves are a 200 ms ease-out tween, instant on a screen change or with reduce motion.

const DURATION_MS = 200;
const X_MARGIN = 56;
const Y_TOP = 96;
const Y_BOTTOM = 40;

let reduceMotion = false;
const listeners = new Set<() => void>();
const tweens = new WeakMap<HTMLElement, number>();

/** The profile's reduce motion (the stage sets it). */
export function setStageMotion(reduce: boolean): void {
  reduceMotion = reduce;
}

/** Called on every scroll step, so the focus ring can follow. */
export function onStageScroll(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let scrollingUntil = 0;
/** A tween is running (the ring then moves without its own transition). */
export const stageScrolling = (): boolean => performance.now() < scrollingUntil;

const emit = () => listeners.forEach((fn) => fn());

export function stageScale(stage: Element | null): number {
  const s = Number(stage?.getAttribute('data-tv-scale'));
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function tween(p: HTMLElement, prop: 'scrollTop' | 'scrollLeft', target: number, instant: boolean): void {
  const max = prop === 'scrollTop' ? p.scrollHeight - p.clientHeight : p.scrollWidth - p.clientWidth;
  const to = Math.max(0, Math.min(Math.max(0, max), target));
  const running = tweens.get(p);
  if (running) cancelAnimationFrame(running);
  tweens.delete(p);
  const from = p[prop];
  if (Math.abs(to - from) < 1) return;
  if (instant || reduceMotion || typeof requestAnimationFrame === 'undefined') {
    p[prop] = to;
    emit();
    return;
  }
  const t0 = performance.now();
  scrollingUntil = t0 + DURATION_MS + 50;
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / DURATION_MS);
    const e = 1 - Math.pow(1 - k, 3);
    p[prop] = from + (to - from) * e;
    emit();
    if (k < 1) tweens.set(p, requestAnimationFrame(step));
    else tweens.delete(p);
  };
  tweens.set(p, requestAnimationFrame(step));
}

/** Bring `el` into view inside every stage scroller around it. False when it is not on a stage. */
export function ensureVisible(el: HTMLElement, instant = false): boolean {
  const stage = el.closest('[data-tv-stage]');
  if (!stage) return false;
  const s = stageScale(stage);
  let p = el.parentElement;
  while (p && p !== stage) {
    const axis = p.getAttribute('data-tv-scroll');
    if (axis === 'x') {
      const pr = p.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const m = X_MARGIN * s;
      let d = 0;
      if (r.left < pr.left + m) d = r.left - (pr.left + m);
      else if (r.right > pr.right - m) d = r.right - (pr.right - m);
      if (d) tween(p, 'scrollLeft', p.scrollLeft + d / s, instant);
    } else if (axis === 'y') {
      const ytop = el.closest('[data-tv-ytop]');
      if (ytop && p.contains(ytop)) tween(p, 'scrollTop', 0, instant);
      else {
        const row = el.closest<HTMLElement>('[data-tv-row]');
        const t = row && p.contains(row) ? row : el;
        const r = t.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        const mtop = p.getAttribute('data-tv-mtop');
        const top = (mtop != null && mtop !== '' ? Number(mtop) : Y_TOP) * s;
        const bot = Y_BOTTOM * s;
        let d = 0;
        if (r.top < pr.top + top) d = r.top - (pr.top + top);
        else if (r.bottom > pr.bottom - bot) d = r.bottom - (pr.bottom - bot);
        if (d) tween(p, 'scrollTop', p.scrollTop + d / s, instant);
      }
    }
    p = p.parentElement;
  }
  return true;
}
