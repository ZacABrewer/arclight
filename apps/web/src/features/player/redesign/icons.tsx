import type { CSSProperties } from 'react';

// Line icons for the redesign (24 px grid, 2 px strokes) plus the design's solid play glyph.
// Colours come from currentColor so every theme recolours them.

const STROKE: Record<string, string> = {
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  tv: 'M3 6h18v12H3zM8 21h8M12 18v3',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  list: 'M5 7h14M5 12h14M5 17h9M17 15v6M14 18h6',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
  book: 'M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 2h13v-4',
  settings:
    'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  back: 'M19 12H5M11 6l-6 6 6 6',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  restart: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  episodes: 'M4 6h16M4 12h16M4 18h10',
  signOut: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  exitFullscreen: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};

export type RdIconName = keyof typeof STROKE | 'play' | 'pause' | 'next' | 'previous';

export function RdIcon({ name, size = 22, className, style }: { name: RdIconName; size?: number; className?: string; style?: CSSProperties }) {
  if (name === 'play') {
    // The design's glyph: 16x18 solid triangle.
    return (
      <svg width={(size * 16) / 18} height={size} viewBox="0 0 16 18" aria-hidden="true" focusable="false" className={className} style={style}>
        <path d="M1 1l14 8-14 8z" fill="currentColor" />
      </svg>
    );
  }
  if (name === 'pause') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} style={style}>
        <rect x="6" y="4" width="4.5" height="16" rx="1" fill="currentColor" />
        <rect x="13.5" y="4" width="4.5" height="16" rx="1" fill="currentColor" />
      </svg>
    );
  }
  if (name === 'next' || name === 'previous') {
    const d = name === 'next' ? 'M12 2h2v12h-2zM2 2l9 6-9 6z' : 'M2 2h2v12H2zM14 2L5 8l9 6z';
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} style={style}>
        <path d={d} fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      <path d={STROKE[name]} />
    </svg>
  );
}
