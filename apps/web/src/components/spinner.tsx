import { cx } from '../lib/cx.js';

export function Spinner({ label = 'Loading', size = 'md', inline = false }: { label?: string; size?: 'sm' | 'md' | 'lg'; inline?: boolean }) {
  return (
    <span className={cx('spinner-wrap', inline && 'spinner-inline')} role="status" aria-live="polite">
      <span className={`spinner spinner-${size}`} aria-hidden="true" />
      <span className={inline ? 'sr-only' : 'spinner-label'}>{label}</span>
    </span>
  );
}

/** Centered block spinner for a whole page or card body. */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner label={label} />
    </div>
  );
}
