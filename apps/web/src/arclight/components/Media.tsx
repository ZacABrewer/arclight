import { useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../cx.js';

interface FrameProps {
  /** Image URL (TMDB). Missing or failing → stripe fallback with the title. */
  src?: string | null | undefined;
  /** Used as alt text and as the fallback label. */
  title: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Overlays inside the frame (check box, progress). */
  children?: ReactNode;
  loading?: 'lazy' | 'eager' | undefined;
}

function FrameImage({ src, title, loading = 'lazy' }: Pick<FrameProps, 'src' | 'title' | 'loading'>) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="al-frame-fallback" data-testid="al-frame-fallback">
        <span className="al-frame-fallback__title">{title}</span>
      </div>
    );
  }
  return <img src={src} alt={title} loading={loading} decoding="async" onError={() => setFailed(true)} />;
}

export interface PosterProps extends FrameProps {
  /** Selection mode: outlined in cyan (no glow on artwork). */
  selected?: boolean | undefined;
  /** Episode/file completion bar along the bottom edge (0–100). */
  progress?: number | undefined;
  /** cyan (default) · warn (missing episodes) · muted (unmonitored). */
  progressTone?: 'default' | 'warn' | 'muted' | undefined;
  /** Width in px; height follows 2:3. */
  width?: number | string | undefined;
}

/** 2:3 poster frame: square 1px line-2 border, sheen on top, stripe fallback. */
export function Poster({ src, title, selected, progress, progressTone = 'default', width, className, style, children, loading }: PosterProps) {
  return (
    <div className={cx('al-poster', className)} data-selected={selected || undefined} style={{ width, ...style }}>
      <FrameImage src={src} title={title} loading={loading} />
      {children}
      {progress !== undefined ? (
        <div className="al-poster__progress" data-tone={progressTone === 'default' ? undefined : progressTone} aria-hidden="true">
          <span style={{ '--p': `${Math.min(100, Math.max(0, progress))}%` } as CSSProperties} />
        </div>
      ) : null}
    </div>
  );
}

export interface BackdropFrameProps extends FrameProps {
  /** Details header: fade to black on the left (92% → 20%) and the bottom. */
  fade?: boolean | undefined;
  /** Fill the parent (Details header) instead of keeping 16:9. */
  bleed?: boolean | undefined;
}

/** 16:9 backdrop frame. Named BackdropFrame to keep `Backdrop` for the scene layer. */
export function BackdropFrame({ src, title, fade, bleed, className, style, children, loading }: BackdropFrameProps) {
  return (
    <div className={cx('al-backdrop-frame', fade && 'al-backdrop-frame--fade', bleed && 'al-backdrop-frame--bleed', className)} style={style}>
      <FrameImage src={src} title={title} loading={loading} />
      {children}
    </div>
  );
}

export interface PosterCardProps extends PosterProps {
  /** Mono text right of the title ("18/24"). */
  count?: ReactNode | undefined;
  /** warn colours the count (missing episodes). */
  countTone?: 'default' | 'warn' | undefined;
  /** Caption under the title ("2022 · Apple TV+"). */
  meta?: ReactNode | undefined;
  /** Poster-level overlay, e.g. the select checkbox: <Checkbox …/> */
  overlay?: ReactNode | undefined;
  onClick?: (() => void) | undefined;
  href?: string | undefined;
}

/** Library grid cell (Page 02): poster + title row with mono count + meta line. */
export function PosterCard({ count, countTone = 'default', meta, overlay, onClick, href, title, ...poster }: PosterCardProps) {
  const inner = (
    <>
      <Poster title={title} {...poster}>
        {overlay ? <div className="al-poster__check">{overlay}</div> : null}
      </Poster>
      <div className="al-poster-card__title-row">
        <span className="al-poster-card__title">{title}</span>
        {count !== undefined ? (
          <span className="al-num" style={{ fontSize: 11, color: countTone === 'warn' ? 'var(--al-warn-text)' : 'var(--al-text-4)' }}>
            {count}
          </span>
        ) : null}
      </div>
      {meta ? <div className="al-poster-card__meta">{meta}</div> : null}
    </>
  );
  if (href) {
    return (
      <a className="al-poster-card" href={href} onClick={onClick} style={{ color: 'inherit', textDecoration: 'none' }}>
        {inner}
      </a>
    );
  }
  return (
    <div className="al-poster-card" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      {inner}
    </div>
  );
}
