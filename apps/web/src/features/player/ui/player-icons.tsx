import type { SVGProps } from 'react';
import { cx } from '../../../arclight/index.js';

// Transport icons the kit's set does not have, drawn in the same idiom (24 px artboard, 1.5 px
// stroke, square caps, currentColor). Original line drawings.

const PATHS = {
  play: 'M7 4.5v15L19.5 12z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  next: 'M5 5l10 7-10 7zM18.5 5v14',
  previous: 'M19 5L9 12l10 7zM5.5 5v14',
  shuffle: 'M3 7h4l9 10h5M3 17h4l2.5-2.8M13.5 9.8 16 7h5M18 4l3 3-3 3M18 14l3 3-3 3',
  repeat: 'M4 11V8h14M15 5l3 3-3 3M20 13v3H6M9 19l-3-3 3-3',
  repeatOne: 'M4 11V8h14M15 5l3 3-3 3M20 13v3H6M9 19l-3-3 3-3M11.5 10.5 12.5 10v4',
  back30: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M9 10.5h2v4M13.5 10.5h1.8v4h-1.8z',
  forward30: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4M9 10.5h2v4M13.5 10.5h1.8v4h-1.8z',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  bookmark: 'M7 4h10v16l-5-4-5 4z',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z',
  queue: 'M4 6h12M4 11h12M4 16h7M15 14v6l5-3z',
  chapters: 'M5 5h14M5 10h14M5 15h9M5 20h6',
  expand: 'M5 15l7-7 7 7',
} as const;

export type PlayerIconName = keyof typeof PATHS;

export function PlayerIcon({
  name,
  size = 20,
  label,
  className,
  ...rest
}: Omit<SVGProps<SVGSVGElement>, 'name'> & { name: PlayerIconName; size?: number; label?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={cx('al-icon', 'pl-icon', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-icon={name}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
