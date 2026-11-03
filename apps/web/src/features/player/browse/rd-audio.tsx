import { useId, type ReactNode } from 'react';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { RdIcon } from '../redesign/icons.js';
import { useLayout } from '../redesign/layout.js';
import { RdPage } from '../redesign/pages/common.js';
import { artBackground } from '../redesign/placeholder.js';
import { Art } from '../redesign/tiles.js';
import { AudioIcon, type AudioIconName } from './rd-icons.js';
import './rd-audio.css';

// The redesign frame for the music and audiobook pages (features spec §5.1, the template's Music
// and Books screens): the page head (title 40/800 and a muted count), full-bleed tile rows, tile
// grids for the long lists and the title-page structure for album, artist, playlist and book
// pages: a blurred backdrop, the art at the left, the title block, the primary action and the
// secondary icon buttons. Phones stack the art over the title and label the actions.

/** The page container; every audio page carries `rd-music` so the shared list and track styles apply. */
export function AudioPage({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <RdPage className={cx('rd-music', className)}>{children}</RdPage>;
}

/** Page head: title, the muted count line, actions beside the title and (children) the section chips. */
export function AudioHead({ title, sub, actions, children }: { title: string; sub?: string | null | undefined; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="rd-music-head">
      <div className="rd-music-head__line">
        <h1 className="rd-music-head__title">{title}</h1>
        {actions ? <div className="rd-music-head__actions">{actions}</div> : null}
      </div>
      {sub ? <p className="rd-music-head__sub">{sub}</p> : null}
      {children}
    </header>
  );
}

/** A padded block under the head (filters, grids, track lists), optionally titled. */
export function AudioSection({ title, children, className }: { title?: string | undefined; children: ReactNode; className?: string | undefined }) {
  const id = useId();
  return (
    <section className={cx('rd-music-section', className)} aria-labelledby={title ? id : undefined}>
      {title ? (
        <h2 className="rd-music-section__title" id={id}>
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

/** Empty, not-found and prompt states (no alert role: nothing failed). */
export function AudioNotice({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rd-empty rd-music-notice">
      <p className="rd-empty__title">{title}</p>
      {children ? <p className="rd-empty__body">{children}</p> : null}
      {action}
    </div>
  );
}

/** "Showing 60 of 240" and Load more under a paged grid. */
export function AudioLoadMore({ shown, total, hasMore, loading, onMore }: { shown: number; total: number; hasMore: boolean; loading: boolean; onMore: () => void }) {
  const t = useT();
  return (
    <div className="rd-music-more">
      <p className="rd-music-more__count" aria-live="polite">
        {t('player.browse.showing', { shown, total })}
      </p>
      {hasMore ? (
        <button type="button" className="rd-btn rd-btn--secondary" disabled={loading} aria-busy={loading || undefined} onClick={onMore}>
          {t('player.browse.loadMore')}
        </button>
      ) : null}
    </div>
  );
}

export interface DetailActionProps {
  icon: AudioIconName;
  label: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  danger?: boolean | undefined;
  'data-download-state'?: string | undefined;
}

/** A secondary action: a square icon button on wide screens, the icon over its label on phones. */
export function DetailAction({ icon, label, onClick, disabled, busy, danger, ...data }: DetailActionProps) {
  const portrait = useLayout() === 'portrait';
  if (portrait) {
    return (
      <button type="button" className={cx('rd-action', danger && 'rd-music-action--danger')} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick} {...data}>
        <AudioIcon name={icon} />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={cx('rd-btn rd-btn--secondary rd-btn--square', danger && 'rd-music-action--danger')}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
      {...data}
    >
      <AudioIcon name={icon} />
    </button>
  );
}

/** The primary action (Play, Resume, Pause, Play all); full width on phones. */
export function PrimaryAction({ label, playing = false, onClick, disabled, busy }: { label: string; playing?: boolean; onClick: () => void; disabled?: boolean | undefined; busy?: boolean | undefined }) {
  const portrait = useLayout() === 'portrait';
  return (
    <button type="button" className={cx('rd-btn rd-btn--primary', portrait && 'rd-btn--block')} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
      <RdIcon name={playing ? 'pause' : 'play'} size={18} />
      {label}
    </button>
  );
}

export interface AudioDetailProps {
  kicker?: string | null | undefined;
  title: string;
  /** Artwork; also the blurred backdrop. */
  image?: string | null | undefined;
  /** Replaces the cover (the playlist mosaic). */
  cover?: ReactNode;
  round?: boolean | undefined;
  /** Lines under the title (artist, year, counts, format). */
  lines?: ReactNode;
  primary: ReactNode;
  actions?: ReactNode;
  /** Under the buttons (progress, overview). */
  extra?: ReactNode;
  children?: ReactNode;
}

/** The title page of an album, artist, playlist or audiobook. */
export function AudioDetail({ kicker, title, image, cover, round = false, lines, primary, actions, extra, children }: AudioDetailProps) {
  const id = useId();
  const portrait = useLayout() === 'portrait';
  return (
    <AudioPage className={cx('rd-music-detail', portrait ? 'rd-music-detail--portrait' : 'rd-music-detail--wide')}>
      <section className="rd-music-detail__hero" aria-labelledby={id}>
        <div className="rd-music-detail__backdrop" aria-hidden="true">
          <span className="rd-music-detail__blur" style={{ background: artBackground(image, title) }} />
          <span className="rd-music-detail__fade" />
        </div>
        <div className="rd-music-detail__top">
          {cover ?? <Art image={image} seed={title} shift={round ? 40 : 0} className={cx('rd-music-detail__cover', round && 'is-round')} />}
          <div className="rd-music-detail__body">
            {kicker ? (
              <div className="rd-kicker">
                <span className="rd-kicker__dot" aria-hidden="true" />
                {kicker}
              </div>
            ) : null}
            <h1 className="rd-music-detail__title" id={id}>
              {title}
            </h1>
            {lines}
            {portrait ? (
              <>
                {primary}
                {actions ? <div className="rd-actions rd-music-detail__actions">{actions}</div> : null}
              </>
            ) : (
              <div className="rd-detail__buttons">
                {primary}
                {actions}
              </div>
            )}
            {extra}
          </div>
        </div>
      </section>
      <div className="rd-music-detail__content">{children}</div>
    </AudioPage>
  );
}
