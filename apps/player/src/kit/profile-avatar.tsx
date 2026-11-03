import type { CSSProperties } from 'react';

// A profile's circle: its colour with the initial in the background colour, weight 800 (§4.2).
export function ProfileAvatar({ color, initial, size = 34, className, style }: { color: string; initial: string; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: 'var(--al-pl-bg, #111316)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: Math.round(size * 0.44),
        flex: 'none',
        ...style,
      }}
    >
      {initial}
    </span>
  );
}
