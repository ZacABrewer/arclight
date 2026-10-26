import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.js';
import { STATUS_STYLES, resolveStatus, statusLabel, type StatusKey } from '../tokens.js';

/**
 * Generic chip tones, for states outside the media vocabulary (Requested / Approved /
 * Available, log levels, indexer health). Each maps onto an existing `.al-chip[data-status]`
 * rule so no new colours appear: accent = cyan, neutral = grey, muted = faded grey,
 * warn = orange, danger = red, default = the plain cyan-outline chip.
 */
export type ChipTone = 'default' | 'accent' | 'neutral' | 'muted' | 'warn' | 'danger';

const TONE_ATTR: Record<ChipTone, string | undefined> = {
  default: undefined,
  accent: 'monitored',
  neutral: 'queued',
  muted: 'unmonitored',
  warn: 'missing',
  danger: 'failed',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone | undefined;
  /** fill = solid 6px square (default), ring = hollow, none = no dot. */
  dot?: 'fill' | 'ring' | 'none' | undefined;
  /** 26px height used in Details headers. */
  large?: boolean | undefined;
  children: ReactNode;
}

/** `.al-chip`. Chips always carry a label — status is never shown by colour alone. */
export function Chip({ tone = 'default', dot = 'fill', large, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cx('al-chip', dot === 'ring' && 'al-chip--ring', dot === 'none' && 'al-chip--nodot', large && 'al-chip--lg', className)}
      data-status={TONE_ATTR[tone]}
      data-tone={tone}
      {...rest}
    >
      {children}
    </span>
  );
}

type StatusInput = StatusKey | (string & {});

interface StatusChipBase extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Override the label text (rare: "Import failed · sample only", "Downloading 68%"). */
  label?: string | undefined;
  /**
   * Force the dot shape. Default follows tokens.json (ring for Unaired / Unmonitored /
   * Cutoff unmet, filled otherwise).
   */
  dot?: 'fill' | 'ring' | undefined;
  large?: boolean | undefined;
}

/** Failed and Stalled must say why: "Failed · sample only", "Stalled · no peers". */
export type StatusChipProps =
  | (StatusChipBase & { status: 'failed' | 'stalled'; cause: string })
  | (StatusChipBase & { status: StatusInput; cause?: string | undefined });

/**
 * Status chip using the exact vocabulary: Downloaded · Downloading · Importing · Monitored ·
 * Unmonitored · Unaired · Queued · Paused · Waiting for air date · Missing · Cutoff unmet ·
 * Stalled · Failed. `status` takes a key (`cutoffUnmet`) or a label ("Cutoff unmet").
 */
export function StatusChip({ status, cause, label, dot, large, className, ...rest }: StatusChipProps) {
  const key = resolveStatus(status);
  if (!key) {
    // Unknown status: show the text in a neutral chip rather than inventing a colour.
    return (
      <Chip tone="neutral" large={large} className={className} {...rest}>
        {label ?? status}
      </Chip>
    );
  }
  const style = STATUS_STYLES[key];
  // Ring statuses are already drawn hollow by arclight.css; the class only forces a ring
  // onto a normally filled status.
  const forceRing = dot === 'ring' && style.dot === 'fill';
  return (
    <span
      className={cx('al-chip', forceRing && 'al-chip--ring', large && 'al-chip--lg', className)}
      data-dot={dot ?? style.dot}
      data-status={style.attr}
      data-status-key={key}
      data-live={style.live || undefined}
      {...rest}
    >
      {label ?? statusLabel(key, cause)}
    </span>
  );
}
