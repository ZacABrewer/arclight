import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { prefersReducedMotion } from '../hooks/use-media-query.js';
import { MOTION } from '../tokens.js';

export interface DerezzProps {
  /** Start the delete animation (after the user confirmed). */
  active: boolean;
  /** Fires when the animation ends — remove the item from the list here. */
  onDone?: (() => void) | undefined;
  children: ReactNode;
  className?: string | undefined;
  as?: 'div' | 'li' | undefined;
}

/**
 * Derezz delete (320 ms ease-in): the row/card splits into scanlines, slides 6px and fades.
 * Confirmed deletes only. Under reduced motion `onDone` fires immediately. The copy never
 * says "derezz" — that is the animation's name, not UI vocabulary.
 */
export function Derezz({ active, onDone, children, className, as: As = 'div' }: DerezzProps) {
  const done = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!active) {
      done.current = false;
      return;
    }
    const finish = () => {
      if (done.current) return;
      done.current = true;
      doneRef.current?.();
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    // Safety net when animationend never fires (hidden tab, CSS missing).
    const t = setTimeout(finish, MOTION.derezz + 80);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <As
      className={cx(active && 'al-derezz', className)}
      aria-hidden={active || undefined}
      onAnimationEnd={(e) => {
        if (!active || e.target !== e.currentTarget || done.current) return;
        done.current = true;
        doneRef.current?.();
      }}
    >
      {active ? <ScanFilter /> : null}
      {children}
    </As>
  );
}

/** The `#al-scan` SVG filter referenced by arclight.css's al-derezz keyframes. */
export function ScanFilter() {
  return (
    <svg className="al-derezz-defs" aria-hidden="true" focusable="false">
      <filter id="al-scan">
        <feTurbulence type="fractalNoise" baseFrequency="0 0.9" numOctaves="1" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
