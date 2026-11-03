import type { CSSProperties } from 'react';
import { cx } from '../../../arclight/cx.js';

// A profile's circle (redesign spec §4.2): its colour with the initial in the page colour,
// weight 800. Sizes: 34 header, 32 phone top bar, 132 picker, 96 phone picker.

export interface ProfileAvatarProps {
  color: string;
  initial: string;
  size?: number | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

export function ProfileAvatar({ color, initial, size = 34, className, style }: ProfileAvatarProps) {
  // The design: 15 px in the 34 px header circle, 52 px in the 132 px picker circle.
  const font = Math.round(size * (size >= 80 ? 0.395 : 0.44));
  return (
    <span
      className={cx('rd-avatar', className)}
      aria-hidden="true"
      style={{ width: size, height: size, background: color, fontSize: font, ...style }}
    >
      {initial.slice(0, 2)}
    </span>
  );
}
