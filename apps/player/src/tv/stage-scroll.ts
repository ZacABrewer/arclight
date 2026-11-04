// Scrolling on the TV stage (spec §4.3, the design's ensureVisible). Every scroller on the stage
// is overflow:hidden and moved only from here, so focus decides what is on screen:
//
//  - [data-tv-scroll="x"] (a row's tiles): keep the focused tile 56 stage px inside both edges;
//  - [data-tv-scroll="y"] (a page): the focused element's row ([data-tv-row], or the element)
//    keeps a top margin of [data-tv-mtop] (default 96, below the header) and 40 at the bottom;
//    anything inside [data-tv-ytop] (the hero / detail buttons) scrolls the page back to the top.
//
// A scroller's content is its first child, and it moves by a translate3d on that child rather
// than scrollTop / scrollLeft: the TV's GPU composites a transform without re-laying out or
// repainting the page, which is what keeps the 200 ms tween smooth on a slow box. Moves are a
// 200 ms ease-out tween, instant on a screen change or with reduce motion; the ring follows on
// every frame (onStageScroll).

const DURATION_MS = 200;
const X_MARGIN = 56;
const Y_TOP = 96;
const Y_BOTTOM = 40;

type Axis = 'x' | 'y';

let reduceMotion = false;
const listeners = new Set<() => void>();
/** The content's current offset (stage px, ≥ 0). Keyed by the content, so a remount starts at 0. */
const offsets = new WeakMap<HTMLElement, { x: number; y: number }>();
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

function contentOf(p: HTMLElement): HTMLElement | null {
  const c = p.firstElementChild;
  return c instanceof HTMLElement ? c : null;
}

/** How far the content can move on an axis (layout px, unaffected by the stage scale). */
function maxOffset(p: HTMLElement, c: HTMLElement, axis: Axis): number {
  const max = axis === 'y' ? c.offsetHeight - p.clientHeight : c.offsetWidth - p.clientWidth;
  return Math.max(0, max);
}

/** The scroller's current offset on an axis. */
export function stageOffset(p: HTMLElement, axis: Axis): number {
  const c = contentOf(p);
  return c ? (offsets.get(c)?.[axis] ?? 0) : 0;
}

/** Whether the stage's page has scrolled off its top (tv.css backs the header solid then). */
export const SCROLLED_ATTR = 'data-tv-scrolled';

function apply(c: HTMLElement, o: { x: number; y: number }): void {
  offsets.set(c, o);
  c.style.transform = o.x || o.y ? `translate3d(${-o.x}px, ${-o.y}px, 0)` : '';
  // The page scroller only (not rows or panes); set on a change, not every frame.
  const p = c.parentElement;
  if (p?.classList.contains('tv-scroll-y')) {
    const stage = p.closest('[data-tv-stage]');
    const scrolled = o.y > 0.5;
    if (stage && stage.hasAttribute(SCROLLED_ATTR) !== scrolled) stage.toggleAttribute(SCROLLED_ATTR, scrolled);
  }
}

function tween(p: HTMLElement, axis: Axis, target: number, instant: boolean): void {
  const c = contentOf(p);
  if (!c) return;
  // A native scroll (focus without preventScroll) would stack on the transform.
  if (p.scrollTop) p.scrollTop = 0;
  if (p.scrollLeft) p.scrollLeft = 0;
  const to = Math.round(Math.max(0, Math.min(maxOffset(p, c, axis), target)));
  const running = tweens.get(c);
  if (running) cancelAnimationFrame(running);
  tweens.delete(c);
  const start = offsets.get(c) ?? { x: 0, y: 0 };
  const from = start[axis];
  if (Math.abs(to - from) < 1) return;
  if (instant || reduceMotion || typeof requestAnimationFrame === 'undefined') {
    apply(c, { ...(offsets.get(c) ?? start), [axis]: to });
    emit();
    return;
  }
  const t0 = performance.now();
  scrollingUntil = Math.max(scrollingUntil, t0 + DURATION_MS + 50);
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / DURATION_MS);
    const e = 1 - Math.pow(1 - k, 3);
    // Re-read the other axis: a row's x tween and the page's y tween run on different contents,
    // but one content can tween both ways.
    apply(c, { ...(offsets.get(c) ?? start), [axis]: from + (to - from) * e });
    emit();
    if (k < 1) tweens.set(c, requestAnimationFrame(step));
    else tweens.delete(c);
  };
  tweens.set(c, requestAnimationFrame(step));
}

/** Put a scroller back at its start, instantly (a new screen's content). */
export function resetStageScroll(p: HTMLElement): void {
  const c = contentOf(p);
  if (!c) return;
  const running = tweens.get(c);
  if (running) cancelAnimationFrame(running);
  tweens.delete(c);
  apply(c, { x: 0, y: 0 });
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
      const r = layoutRect(el);
      const m = X_MARGIN * s;
      let d = 0;
      if (r.left < pr.left + m) d = r.left - (pr.left + m);
      else if (r.right > pr.right - m) d = r.right - (pr.right - m);
      if (d) tween(p, 'x', stageOffset(p, 'x') + d / s, instant);
    } else if (axis === 'y') {
      const ytop = el.closest('[data-tv-ytop]');
      if (ytop && p.contains(ytop)) tween(p, 'y', 0, instant);
      else {
        const row = el.closest<HTMLElement>('[data-tv-row]');
        const t = row && p.contains(row) ? row : el;
        const r = layoutRect(t);
        const pr = p.getBoundingClientRect();
        const mtop = p.getAttribute('data-tv-mtop');
        const top = (mtop != null && mtop !== '' ? Number(mtop) : Y_TOP) * s;
        const bot = Y_BOTTOM * s;
        let d = 0;
        if (r.top < pr.top + top) d = r.top - (pr.top + top);
        else if (r.bottom > pr.bottom - bot) d = r.bottom - (pr.bottom - bot);
        if (d) tween(p, 'y', stageOffset(p, 'y') + d / s, instant);
      }
    }
    p = p.parentElement;
  }
  return true;
}

/** The screen box an element will have once its focus lift (a centred scale) has settled or
 *  undone: the scroll math must not chase a tile mid-lift. */
function layoutRect(el: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  const b = el.getBoundingClientRect();
  const sx = el.offsetWidth ? b.width / el.offsetWidth : 1;
  const sy = el.offsetHeight ? b.height / el.offsetHeight : 1;
  const stage = el.closest('[data-tv-stage]');
  const s = stageScale(stage);
  // b.width = offsetWidth × stage scale × lift; strip the lift around the centre.
  const w = el.offsetWidth ? el.offsetWidth * s : b.width;
  const h = el.offsetHeight ? el.offsetHeight * s : b.height;
  if (Math.abs(sx - s) < 0.001 && Math.abs(sy - s) < 0.001) return b;
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}
