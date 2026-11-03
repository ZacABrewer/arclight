import { useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../../arclight/cx.js';
import { PlayerLink } from '../browse/kit.js';
import { placeholderArt } from './placeholder.js';

// Tiles (redesign spec §4.2, the template's rows): wide 16:9 with the title inside over a bottom
// fade (§9 Q11), square (albums, books) and round (artists), each with a sub line and an accent
// progress bar. A tile is one link or one button; no chips or badges are drawn on artwork.

interface TileAction {
  /** A player path, or... */
  href?: string | undefined;
  /** ...an action (play an album, start a book). */
  onOpen?: (() => void) | undefined;
  /** Accessible name when the visible text is not enough ("Resume Low Tide"). */
  label?: string | undefined;
}

interface TileBase extends TileAction {
  title: string;
  sub?: string | null | undefined;
  /** Artwork; the placeholder gradient (seeded by the title) shows under it and when it fails. */
  image?: string | null | undefined;
  /** Placeholder seed (defaults to the title) and hue shift (episode stills). */
  seed?: string | undefined;
  shift?: number | undefined;
  /** 0..1; drawn only between 0 and 1. */
  progress?: number | null | undefined;
  className?: string | undefined;
}

function TileShell({ href, onOpen, label, className, children }: TileAction & { className: string; children: ReactNode }) {
  if (href) {
    return (
      <PlayerLink to={href} className={className} aria-label={label}>
        {children}
      </PlayerLink>
    );
  }
  return (
    <button type="button" className={className} aria-label={label} onClick={onOpen}>
      {children}
    </button>
  );
}

export function Art({ image, seed, shift, className, style, children }: { image?: string | null | undefined; seed: string; shift?: number | undefined; className?: string | undefined; style?: CSSProperties | undefined; children?: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = image && failed !== image;
  return (
    <span className={cx('rd-art', className)} style={{ background: placeholderArt(seed, shift), ...style }}>
      {show ? <img src={image} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(image)} /> : null}
      {children}
    </span>
  );
}

export function ProgressBar({ value, className }: { value: number | null | undefined; className?: string | undefined }) {
  if (value === null || value === undefined || !(value > 0)) return null;
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <span className={cx('rd-progress', className)} aria-hidden="true">
      <span style={{ width: `${pct.toFixed(1)}%` }} />
    </span>
  );
}

/** 16:9 tile, title inside (bottom-left, 800) over a fade; sub below. `size`: 'cw' is the phone's wider Continue Watching tile. */
export function WideTile({ title, sub, image, seed, shift, progress, size, className, ...action }: TileBase & { size?: 'cw' | 'grid' | undefined }) {
  return (
    <TileShell {...action} className={cx('rd-tile rd-tile--wide', size === 'cw' && 'rd-tile--cw', size === 'grid' && 'rd-tile--grid', className)}>
      <Art image={image} seed={seed ?? title} shift={shift} className="rd-tile__art">
        <span className="rd-tile__fade" aria-hidden="true" />
        <span className="rd-tile__title">{title}</span>
        <ProgressBar value={progress} className="rd-tile__progress" />
      </Art>
      {sub ? <span className="rd-tile__sub">{sub}</span> : null}
    </TileShell>
  );
}

/** Square tile (albums, audiobooks): title and sub under the art. */
export function SquareTile({ title, sub, image, seed, progress, className, ...action }: TileBase) {
  return (
    <TileShell {...action} className={cx('rd-tile rd-tile--square', className)}>
      <Art image={image} seed={seed ?? title} className="rd-tile__art">
        <ProgressBar value={progress} className="rd-tile__progress" />
      </Art>
      <span className="rd-tile__text">
        <span className="rd-tile__name">{title}</span>
        {sub ? <span className="rd-tile__sub">{sub}</span> : null}
      </span>
    </TileShell>
  );
}

/** Round tile (artists): the name under the circle. */
export function RoundTile({ title, image, seed, className, ...action }: TileBase) {
  return (
    <TileShell {...action} className={cx('rd-tile rd-tile--round', className)}>
      <Art image={image} seed={seed ?? title} shift={40} className="rd-tile__art" />
      <span className="rd-tile__sub rd-tile__sub--center">{title}</span>
    </TileShell>
  );
}
