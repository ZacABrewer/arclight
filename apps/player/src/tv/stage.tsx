import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { FocusStyle } from '@arclight/shared';
import { onStageScroll, setStageMotion, stageScrolling } from './stage-scroll';

// The TV stage (spec §4.3): every screen is laid out at 1280×720 and scaled to the screen with
// min(w/1280, h/720), centred on black, as the design does. The focus ring is one absolutely
// positioned frame on the stage that follows DOM focus (the design's updateRing).

export const STAGE_W = 1280;
export const STAGE_H = 720;
const RING_OUTSET = 6;

export function stageScaleFor(w: number, h: number): number {
  const s = Math.min(w / STAGE_W, h / STAGE_H);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function useStageScale(): number {
  const [scale, setScale] = useState(() => (typeof window === 'undefined' ? 1 : stageScaleFor(document.documentElement.clientWidth || window.innerWidth, document.documentElement.clientHeight || window.innerHeight)));
  useLayoutEffect(() => {
    const update = () => {
      const s = stageScaleFor(document.documentElement.clientWidth || window.innerWidth, document.documentElement.clientHeight || window.innerHeight);
      setScale((prev) => (Math.abs(prev - s) > 0.001 ? s : prev));
    };
    update();
    const raf = requestAnimationFrame(update);
    const late = window.setTimeout(update, 250);
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(document.documentElement);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, []);
  return scale;
}

export function TvStage({ children, focusStyle, reduceMotion, className }: { children: ReactNode; focusStyle: FocusStyle; reduceMotion: boolean; className?: string | undefined }) {
  const scale = useStageScale();
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => setStageMotion(reduceMotion), [reduceMotion]);
  return (
    <div className="tv-viewport">
      <div ref={stage} className={`tv-stage${className ? ` ${className}` : ''}`} data-tv-stage="" data-tv-scale={scale} style={{ transform: `scale(${scale})` }}>
        {children}
        <FocusRing stage={stage} scale={scale} focusStyle={focusStyle} reduceMotion={reduceMotion} />
      </div>
    </div>
  );
}

function FocusRing({ stage, scale, focusStyle, reduceMotion }: { stage: RefObject<HTMLDivElement | null>; scale: number; focusStyle: FocusStyle; reduceMotion: boolean }) {
  const ring = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const motionRef = useRef(reduceMotion);
  motionRef.current = reduceMotion;

  useEffect(() => {
    const update = () => {
      const r = ring.current;
      const st = stage.current;
      if (!r || !st) return;
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || !st.contains(el) || el === st) {
        r.style.opacity = '0';
        return;
      }
      const s = scaleRef.current || 1;
      const sr = st.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const x = (b.left - sr.left) / s;
      const y = (b.top - sr.top) / s;
      const w = b.width / s;
      const h = b.height / s;
      let rad: number;
      const explicit = el.getAttribute('data-tv-r');
      if (explicit != null) rad = Number(explicit) || 0;
      else {
        const br = getComputedStyle(el).borderTopLeftRadius || '0';
        rad = br.endsWith('%') ? (Math.min(w, h) * parseFloat(br)) / 100 : parseFloat(br) || 0;
      }
      rad = Math.min(rad, Math.min(w, h) / 2);
      r.style.transition = stageScrolling() || motionRef.current ? 'none' : 'transform .16s ease, width .16s ease, height .16s ease, border-radius .16s ease, opacity .12s';
      r.style.opacity = '1';
      r.style.transform = `translate(${x - RING_OUTSET}px, ${y - RING_OUTSET}px)`;
      r.style.width = `${w + 2 * RING_OUTSET}px`;
      r.style.height = `${h + 2 * RING_OUTSET}px`;
      r.style.borderRadius = `${rad + RING_OUTSET}px`;
    };
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    const onFocus = () => {
      update();
      soon(); // and once more after the render the focus caused (a season switch, a category)
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', soon);
    window.addEventListener('resize', soon);
    const off = onStageScroll(update);
    // The design's 1 s tick: images and late rows move things under the ring.
    const tick = window.setInterval(update, 1000);
    const late = window.setTimeout(update, 300);
    update();
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', soon);
      window.removeEventListener('resize', soon);
      off();
      window.clearInterval(tick);
      window.clearTimeout(late);
    };
  }, [stage]);

  return <div ref={ring} className={`tv-ring tv-ring--${focusStyle}`} aria-hidden="true" />;
}
