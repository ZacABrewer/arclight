import { useId } from 'react';
import { cx } from '../cx.js';
import { WORDMARK_ASPECT, WORDMARK_BOX, WORDMARK_LETTERS, WORDMARK_SPAN, WORDMARK_VIEWBOX, sliceGeometry } from '../../../../../design/brand/wordmark.js';

export interface WordmarkProps {
  /** Rendered height in px (the letters' box); the width follows. */
  height?: number | undefined;
  /** Accessible name; without one the wordmark is decorative (aria-hidden). */
  label?: string | undefined;
  className?: string | undefined;
}

/**
 * The "Light Slice" wordmark (design/brand/wordmark.ts: Michroma outlines, SIL OFL 1.1) as
 * inline SVG. Colours come from the theme: the letters run --al-wordmark-from -> --al-wordmark-to
 * and the line in the cut is --al-wordmark-line (styles/arclight/arclight.css for Tron,
 * packs.css for theme packs), so every pack recolours it.
 */
export function Wordmark({ height = 16, label, className }: WordmarkProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fill = `al-wm-f-${id}`;
  const line = `al-wm-l-${id}`;
  const cut = `al-wm-c-${id}`;
  const glow = `al-wm-g-${id}`;
  const slice = sliceGeometry(height);
  const width = Math.round(height * WORDMARK_ASPECT * 100) / 100;
  const { x, y, width: w, height: h } = WORDMARK_BOX;
  return (
    <span
      className={cx('al-wordmark', className)}
      style={{ width, height }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox={WORDMARK_VIEWBOX} width={width} height={height} focusable="false" aria-hidden="true">
        <defs>
          <linearGradient id={fill} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={WORDMARK_SPAN} y2="0">
            <stop offset="0" style={{ stopColor: 'var(--al-wordmark-from)' }} />
            <stop offset="1" style={{ stopColor: 'var(--al-wordmark-to)' }} />
          </linearGradient>
          <linearGradient id={line} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={WORDMARK_SPAN} y2="0">
            <stop offset="0" style={{ stopColor: 'var(--al-wordmark-line)', stopOpacity: 0 }} />
            <stop offset=".5" style={{ stopColor: 'var(--al-wordmark-line)' }} />
            <stop offset="1" style={{ stopColor: 'var(--al-wordmark-line)', stopOpacity: 0 }} />
          </linearGradient>
          <mask id={cut} maskUnits="userSpaceOnUse" x={x - 20} y={y} width={w + 40} height={h}>
            <rect x={x - 20} y={y} width={w + 40} height={h} fill="#fff" />
            <rect x={x - 20} y={slice.cutY} width={w + 40} height={slice.cutHeight} fill="#000" />
          </mask>
          <filter id={glow} x="-10%" y="-600%" width="120%" height="1300%">
            <feGaussianBlur stdDeviation="3" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path d={WORDMARK_LETTERS} fill={`url(#${fill})`} mask={`url(#${cut})`} />
        <rect className="al-wordmark__line" y={slice.lineY} width={WORDMARK_SPAN} height={slice.lineHeight} fill={`url(#${line})`} filter={`url(#${glow})`} />
      </svg>
    </span>
  );
}
