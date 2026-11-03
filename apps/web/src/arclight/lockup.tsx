import { useId } from 'react';
import { cx } from './cx.js';
import { WORDMARK_LETTERS, WORDMARK_SPAN } from '../../../../design/brand/wordmark.js';

// The Light Slice lockup (design/brand/lockup-dark-bg.svg): the two-chevron mark followed by the
// sliced wordmark, drawn inline so theme packs recolour it. Same geometry as the brand file
// (viewBox 404 x 80, mark scaled .72, wordmark scaled .42 at x 88); the colours are the tokens
// --al-mark-from/to (chevrons) and --al-wordmark-from/to/line (letters and the line in the cut).

const VIEW_W = 404;
const VIEW_H = 80;

export interface LockupProps {
  /** Rendered height in px; the width follows (404:80). 22 in the player header and picker. */
  height?: number | undefined;
  /** Accessible name; without one the lockup is decorative. */
  label?: string | undefined;
  className?: string | undefined;
}

export function Lockup({ height = 22, label, className }: LockupProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const mark = `al-lk-m-${id}`;
  const fill = `al-lk-f-${id}`;
  const line = `al-lk-l-${id}`;
  const cut = `al-lk-c-${id}`;
  const glow = `al-lk-g-${id}`;
  const width = Math.round(((height * VIEW_W) / VIEW_H) * 100) / 100;
  const chevron = { fill: 'none', stroke: `url(#${mark})`, strokeWidth: 13, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <span
      className={cx('al-lockup', className)}
      style={{ display: 'inline-flex', width, height, flex: 'none' }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width={width} height={height} focusable="false" aria-hidden="true">
        <defs>
          <linearGradient id={mark} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: 'var(--al-mark-from, #2f7bff)' }} />
            <stop offset="1" style={{ stopColor: 'var(--al-mark-to, #6ef6ff)' }} />
          </linearGradient>
          <linearGradient id={fill} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={WORDMARK_SPAN} y2="0">
            <stop offset="0" style={{ stopColor: 'var(--al-wordmark-from, #2f7bff)' }} />
            <stop offset="1" style={{ stopColor: 'var(--al-wordmark-to, #6ef6ff)' }} />
          </linearGradient>
          <linearGradient id={line} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={WORDMARK_SPAN} y2="0">
            <stop offset="0" style={{ stopColor: 'var(--al-wordmark-line, #6ef6ff)', stopOpacity: 0 }} />
            <stop offset=".5" style={{ stopColor: 'var(--al-wordmark-line, #6ef6ff)' }} />
            <stop offset="1" style={{ stopColor: 'var(--al-wordmark-line, #6ef6ff)', stopOpacity: 0 }} />
          </linearGradient>
          <mask id={cut} maskUnits="userSpaceOnUse" x="-20" y="0" width="778" height="120">
            <rect x="-20" width="778" height="120" fill="#fff" />
            <rect x="-20" y="55.5" width="778" height="6" fill="#000" />
          </mask>
          <filter id={glow} x="-10%" y="-600%" width="120%" height="1300%">
            <feGaussianBlur stdDeviation="3" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g transform="translate(0 4) scale(.72)">
          <path d="M48,22 L76,50 L48,78" {...chevron} opacity={0.45} />
          <path d="M24,22 L52,50 L24,78" {...chevron} />
        </g>
        <g transform="translate(88 15.06) scale(0.42)">
          <path d={WORDMARK_LETTERS} fill={`url(#${fill})`} mask={`url(#${cut})`} />
          <rect y="57.75" width={WORDMARK_SPAN} height="1.5" fill={`url(#${line})`} filter={`url(#${glow})`} />
        </g>
      </svg>
    </span>
  );
}
