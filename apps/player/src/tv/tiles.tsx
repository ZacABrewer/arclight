import type { ReactNode } from 'react';
import { artBackground } from '@web/features/player/redesign/placeholder';
import { pct, type MetaItem } from './format';

// The template's building blocks at stage size: rows, the three tile shapes, the meta line, the
// kicker and the progress line. Tiles are buttons, so OK on the remote is a click.

export function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tv-row" data-tv-row="">
      <h2 className="tv-row__title">{title}</h2>
      <div className="tv-scroll-x" data-tv-scroll="x">
        <div className="tv-row__track">{children}</div>
      </div>
    </section>
  );
}

function Bar({ fraction }: { fraction: number | null | undefined }) {
  if (fraction == null || fraction <= 0) return null;
  return (
    <span className="tv-art__bar">
      <span style={{ width: pct(fraction) }} />
    </span>
  );
}

interface TileProps {
  id: string;
  title: string;
  sub?: string | null | undefined;
  art: string | null | undefined;
  fraction?: number | null | undefined;
  onOpen: () => void;
  label?: string;
  /** Focus v2's dwell strip: one line shown inside the art after 650 ms on the tile. */
  meta?: string | null | undefined;
  /** A small kind badge at the art's top left (My List: MOVIE / SERIES). */
  badge?: string | null | undefined;
  /** The badge's colour (Discover's status badges); none: the plain dark badge. */
  badgeTone?: 'accent' | 'warn' | 'danger' | null | undefined;
}

/** Wide 16:9 tile, title inside the art over a bottom fade (§9 Q11). Also the browse / search grid
 *  tile. As in the template the art is what takes focus; the sub under it lights up with it. */
export function WideTile({ id, title, sub, art, fraction, onOpen, label, meta, badge, badgeTone, poster }: TileProps & { poster?: boolean }) {
  return (
    <div className={`tv-tile tv-tile--wide${poster ? ' tv-tile--poster' : ''}`}>
      <button type="button" className="tv-art tv-art--text" data-tv-key={id} style={{ background: artBackground(art, title) }} onClick={onOpen} aria-label={label ?? (sub ? `${title}, ${sub}` : title)}>
        {badge ? <span className={`tv-art__badge${badgeTone ? ` tv-art__badge--${badgeTone}` : ''}`}>{badge}</span> : null}
        <span className="tv-art__text">{title}</span>
        {meta ? <span className="tv-art__meta">{meta}</span> : null}
        <Bar fraction={fraction} />
      </button>
      {sub ? <span className="tv-tile__sub">{sub}</span> : null}
    </div>
  );
}

export function SquareTile({ id, title, sub, art, fraction, onOpen, label }: TileProps) {
  return (
    <div className="tv-tile tv-tile--square">
      <button type="button" className="tv-art" data-tv-key={id} style={{ background: artBackground(art, title) }} onClick={onOpen} aria-label={label ?? (sub ? `${title}, ${sub}` : title)}>
        <Bar fraction={fraction} />
      </button>
      <span className="tv-tile__meta">
        <span className="tv-tile__name">{title}</span>
        {sub ? <span className="tv-tile__sub">{sub}</span> : null}
      </span>
    </div>
  );
}

export function RoundTile({ id, title, art, onOpen }: Omit<TileProps, 'sub' | 'fraction'>) {
  return (
    <div className="tv-tile tv-tile--round">
      <button type="button" className="tv-art" data-tv-key={id} style={{ background: artBackground(art, title, 40) }} onClick={onOpen} aria-label={title} />
      <span className="tv-tile__name">{title}</span>
    </div>
  );
}

export function MetaLine({ items }: { items: MetaItem[] }) {
  if (!items.length) return null;
  return (
    <div className="tv-meta">
      {items.map((m, i) => (
        <span key={i} className={m.kind === 'boxed' ? 'tv-meta__boxed' : m.kind === 'chip' ? 'tv-meta__chip' : undefined}>
          {m.text}
        </span>
      ))}
    </div>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return (
    <div className="tv-kicker">
      <span className="tv-kicker__dot" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function ProgressLine({ fraction, label }: { fraction: number | null; label: string | null }) {
  if (fraction == null || !label) return null;
  return (
    <div className="tv-progress">
      <span className="tv-progress__track">
        <span className="tv-progress__fill" style={{ width: pct(fraction), display: 'block' }} />
      </span>
      <span className="tv-progress__label">{label}</span>
    </div>
  );
}

export function PlayIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
      <path d="M1 1l14 8-14 8z" fill="currentColor" />
    </svg>
  );
}

/** The hero title's size step: 60 px for a short title, 48 / 40 for longer ones, so a long
 *  title takes two lines at most instead of pushing the hero off the top of the screen. */
export function titleStep(title: string): 'l' | 'm' | 's' {
  const n = [...title].length;
  return n <= 16 ? 'l' : n <= 30 ? 'm' : 's';
}

/** Title as text in the design's style, or the logo image when there is one (§9 Q10). */
export function HeroTitle({ title, logoUrl }: { title: string; logoUrl: string | null | undefined }) {
  if (logoUrl) return <img className="tv-logo" src={logoUrl} alt={title} />;
  return <h1 className={`tv-title tv-title--${titleStep(title)}`}>{title}</h1>;
}

/** A row's skeleton in its final geometry (Home loading). */
export function SkeletonRow({ count = 5, square }: { count?: number; square?: boolean }) {
  return (
    <section className="tv-row" aria-hidden="true">
      <span className="tv-skel tv-skel--title" />
      <div className="tv-scroll-x">
        <div className="tv-row__track">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className={`tv-tile ${square ? 'tv-tile--square' : 'tv-tile--wide'}`}>
              <span className="tv-art tv-skel" />
              <span className="tv-skel tv-skel--sub" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
