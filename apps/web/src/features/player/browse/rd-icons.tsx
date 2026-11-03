// Line icons the music and audiobook pages need beyond the redesign set (redesign/icons.tsx):
// the same 24 px grid, 2 px round strokes and currentColor, so they sit beside RdIcon unnoticed.

const PATHS = {
  shuffle: 'M3 7h3.5c2 0 3.2.9 4.3 2.6l2.4 4.8c1.1 1.7 2.3 2.6 4.3 2.6H21M3 17h3.5c1.4 0 2.4-.4 3.2-1.2M14.3 8.2c.8-.8 1.8-1.2 3.2-1.2H21M18 4l3 3-3 3M18 14l3 3-3 3',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  restart: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
} as const;

export type AudioIconName = keyof typeof PATHS;

export function AudioIcon({ name, size = 22 }: { name: AudioIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
