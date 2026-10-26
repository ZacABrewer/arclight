import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../cx.js';
import { t } from '../../i18n/index.js';

export interface EmptyStateProps {
  /** Object + state: "No series yet", "No movies yet". */
  title: string;
  /** One line on what to do: "Add one or import a folder." */
  children?: ReactNode;
  /** Primary action (and optionally a secondary one): "Add series" / "Import folder". */
  action?: ReactNode | undefined;
  /** Replace the outline diamond. */
  icon?: ReactNode | undefined;
  size?: 'md' | 'lg' | undefined;
  className?: string | undefined;
}

/** `.al-empty` — dashed outline, diamond, title, hint, actions. Same props as the old EmptyState. */
export function EmptyState({ title, children, action, icon, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cx('al-empty', size === 'lg' && 'al-empty--lg', className)}>
      {icon ?? <span className="al-empty__icon" aria-hidden="true" />}
      <p className="al-empty__title">{title}</p>
      {children ? <div className="al-empty__body">{children}</div> : null}
      {action ? <div className="al-empty__actions">{action}</div> : null}
    </div>
  );
}

export interface SkeletonProps {
  width?: number | string | undefined;
  height?: number | string | undefined;
  /** Render N lines (70% / 90% / 50% …) instead of one block. */
  lines?: number | undefined;
  /** 2:3 poster or 16:9 backdrop placeholder. */
  shape?: 'block' | 'poster' | 'backdrop' | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

const LINE_WIDTHS = ['70%', '90%', '50%', '80%', '60%'];

/** `.al-skeleton` — shimmer 1.4 s (static under reduced motion). */
export function Skeleton({ width = '100%', height = 12, lines, shape = 'block', className, style }: SkeletonProps) {
  if (lines && lines > 0) {
    return (
      <div className={cx('al-skeleton-lines', className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="al-skeleton" style={{ width: LINE_WIDTHS[i % LINE_WIDTHS.length], height: i === 0 ? 12 : 10 }} />
        ))}
      </div>
    );
  }
  const aspect = shape === 'poster' ? '2 / 3' : shape === 'backdrop' ? '16 / 9' : undefined;
  return (
    <div
      className={cx('al-skeleton', className)}
      aria-hidden="true"
      style={{ width, height: aspect ? undefined : height, aspectRatio: aspect, ...style }}
    />
  );
}

export interface ErrorBlockProps {
  /** What failed, plainly: "Couldn't reach TMDB". */
  title: string;
  /** The cause: "Request timed out after 10 s." */
  children?: ReactNode;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | undefined;
  className?: string | undefined;
}

/** `.al-error` — red-outlined error block with a cause and a Retry link. */
export function ErrorBlock({ title, children, onRetry, retryLabel = t('arclight.states.retry'), className }: ErrorBlockProps) {
  return (
    <div className={cx('al-error', className)} role="alert">
      <p className="al-error__title">{title}</p>
      {children ? <div className="al-error__body">{children}</div> : null}
      {onRetry ? (
        <div>
          <button type="button" className="al-link" onClick={onRetry} style={{ fontSize: 12 }}>
            {retryLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export interface BannerProps {
  tone?: 'info' | 'warn' | 'danger' | undefined;
  children: ReactNode;
  action?: ReactNode | undefined;
  className?: string | undefined;
}

/** Inline banner (Login "Your session expired. Sign in to continue." = warn). */
export function Banner({ tone = 'info', children, action, className }: BannerProps) {
  return (
    <div className={cx('al-banner', className)} data-tone={tone === 'info' ? undefined : tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <span>{children}</span>
      {action ? <span className="al-banner__action">{action}</span> : null}
    </div>
  );
}
