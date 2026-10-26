import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  /** Shows a ✕ button (tag pickers). */
  onRemove?: (() => void) | undefined;
  /** Accessible name for the remove button; defaults to "Remove <text>". */
  removeLabel?: string | undefined;
}

/** `.al-tag` — user tags ("family", "anime ✕"). */
export function Tag({ children, onRemove, removeLabel, className, ...rest }: TagProps) {
  return (
    <span className={cx('al-tag', className)} {...rest}>
      {children}
      {onRemove ? (
        <button
          type="button"
          className="al-tag__remove"
          aria-label={removeLabel ?? `Remove ${typeof children === 'string' ? children : 'tag'}`}
          onClick={onRemove}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}

/** `.al-quality` — mono quality label ("UHD-2160", "WEB-DL 1080p"). */
export function QualityTag({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return (
    <span className={cx('al-quality', className)} {...rest}>
      {children}
    </span>
  );
}

export interface ScoreTagProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Custom format name ("DV", "HDR10", "x265 HD"). */
  name: string;
  score: number;
  /** Scores at or above this read as high (cyan). Default 100. */
  highAt?: number | undefined;
}

/** Signed score with a real minus sign: +150, −10000. */
export function formatScore(score: number): string {
  if (score > 0) return `+${score}`;
  if (score < 0) return `−${Math.abs(score)}`;
  return '0';
}

/** `.al-score` — custom format score ("DV +150", "x265 HD −10000"). */
export function ScoreTag({ name, score, highAt = 100, className, ...rest }: ScoreTagProps) {
  const tier = score < 0 ? 'neg' : score >= highAt ? 'high' : 'normal';
  return (
    <span className={cx('al-score', tier === 'neg' && 'al-score--neg', tier === 'high' && 'al-score--high', className)} data-tier={tier} {...rest}>
      {name} {formatScore(score)}
    </span>
  );
}

export type Protocol = 'torrent' | 'usenet';

const PROTOCOL_CODES: Record<Protocol, string> = { torrent: 'TOR', usenet: 'NZB' };

/** `.al-proto` — TOR / NZB. Same prop as the old ProtocolBadge. */
export function ProtocolBadge({ protocol, className }: { protocol: Protocol; className?: string | undefined }) {
  return (
    <span className={cx('al-proto', className)} title={protocol === 'torrent' ? 'Torrent' : 'Usenet'}>
      {PROTOCOL_CODES[protocol]}
    </span>
  );
}

/** Small cyan count badge (Filter <2>). */
export function CountBadge({ children }: { children: ReactNode }) {
  return <span className="al-count-badge">{children}</span>;
}
