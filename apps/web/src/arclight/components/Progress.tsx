import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../cx.js';

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function pctLabel(v: number): string {
  return `${Math.round(v)}%`;
}

export interface MeterProps {
  /** 0–100. */
  value: number;
  /** warn = orange (low disk), danger = red. */
  tone?: 'default' | 'warn' | 'danger' | undefined;
  /**
   * The value is changing right now (a live transfer). Glow is applied only while live AND
   * active (value < 100) — rule 1, glow = live. Storage / season meters are never live.
   */
  live?: boolean | undefined;
  /** Accessible name. */
  label?: string | undefined;
  className?: string | undefined;
  /** Optional mono text to the right ("8/10 · 248 GB", "0.9 TB free"). */
  valueText?: ReactNode | undefined;
}

/** True when a meter should glow. Exported for tests and for custom bars. */
export function meterIsLive(value: number, live: boolean | undefined): boolean {
  return !!live && clamp(value) < 100;
}

/** `.al-meter` — flat 2px bar (storage, season completion, quotas). */
export function Meter({ value, tone = 'default', live, label, className, valueText }: MeterProps) {
  const v = clamp(value);
  const bar = (
    <div
      className={cx('al-meter', tone === 'warn' && 'al-meter--warn', tone === 'danger' && 'al-meter--danger', meterIsLive(v, live) && 'al-meter--live', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
      style={{ '--p': `${v}%` } as CSSProperties}
    >
      <span />
    </div>
  );
  if (valueText === undefined) return bar;
  return (
    <div className="al-meter-row">
      {bar}
      <span className="al-meter-row__label" data-tone={tone === 'warn' ? 'warn' : undefined}>
        {valueText}
      </span>
    </div>
  );
}

export type TrailState = 'active' | 'paused' | 'stalled' | 'failed' | 'complete' | 'queued';

export interface TrailProps {
  /** 0–100. */
  value: number;
  /**
   * active = glowing trail + pulsing head (the only state that glows); paused = dim with grey
   * head; stalled = orange; failed = red; complete = flat cyan, no head; queued = empty.
   */
  state?: TrailState | undefined;
  /** Show the mono percentage to the right (queue rows). */
  showValue?: boolean | undefined;
  /** Replace the percentage text ("Queued"). */
  valueText?: ReactNode | undefined;
  label?: string | undefined;
  className?: string | undefined;
}

/** `.al-trail` — light-trail progress for queue rows. */
export function Trail({ value, state = 'active', showValue = false, valueText, label, className }: TrailProps) {
  const v = state === 'queued' ? 0 : clamp(value);
  const dataState = state === 'complete' || state === 'queued' ? undefined : state;
  const trail = (
    <div
      className={cx('al-trail', className)}
      data-state={dataState}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-valuetext={state === 'active' ? undefined : `${pctLabel(v)}, ${state}`}
      aria-label={label}
      style={{ '--p': `${v}%` } as CSSProperties}
    >
      <i />
    </div>
  );
  if (!showValue && valueText === undefined) return trail;
  return (
    <div className="al-trail-row">
      {trail}
      <span className="al-trail-row__pct" data-state={state}>
        {valueText ?? pctLabel(v)}
      </span>
    </div>
  );
}

export interface RingProps {
  /** 0–100. One ring per view: overall season completion or a large upload. */
  value: number;
  size?: number | undefined;
  /** Centre text; defaults to the percentage. Pass null for none. */
  children?: ReactNode;
  label?: string | undefined;
  className?: string | undefined;
}

/** `.al-ring` — identity ring progress (84px, conic, dashed inner ring, mono centre). */
export function Ring({ value, size = 84, children, label, className }: RingProps) {
  const v = clamp(value);
  return (
    <div
      className={cx('al-ring-wrap', className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
    >
      <div className="al-ring" style={{ '--p': v } as CSSProperties} />
      <div className="al-ring-wrap__inner" aria-hidden="true" />
      {children === null ? null : <div className="al-ring-wrap__label">{children ?? pctLabel(v)}</div>}
    </div>
  );
}

/** `.al-live` — the connection dot. Breathes while up; orange and still when down. */
export function LiveDot({ down = false, label }: { down?: boolean | undefined; label?: string | undefined }) {
  return (
    <span
      className="al-live"
      data-state={down ? 'down' : undefined}
      style={{ display: 'inline-block', flex: 'none' }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
