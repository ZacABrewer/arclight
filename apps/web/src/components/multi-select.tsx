import { cx } from '../lib/cx.js';

export interface MultiSelectOption {
  value: number;
  label: string;
  /** Indent (sub-categories). */
  child?: boolean;
}

export interface MultiSelectProps {
  label: string;
  options: readonly MultiSelectOption[];
  value: readonly number[];
  onChange: (value: number[]) => void;
  /** Summary when nothing is chosen. */
  emptyLabel?: string;
}

/** Checkbox list in a popover; the summary shows how many are chosen. */
export function MultiSelect({ label, options, value, onChange, emptyLabel = 'Any' }: MultiSelectProps) {
  const chosen = new Set(value);
  const summary =
    value.length === 0
      ? emptyLabel
      : value.length <= 2
        ? options
            .filter((o) => chosen.has(o.value))
            .map((o) => o.label)
            .join(', ')
        : `${value.length} selected`;
  return (
    <details className="popover multi-select">
      <summary className="input select" aria-label={`${label}: ${summary}`}>
        {summary}
      </summary>
      <div className="popover-body multi-select-body" role="group" aria-label={label}>
        {value.length > 0 ? (
          <button type="button" className="link-subtle" onClick={() => onChange([])}>
            Clear
          </button>
        ) : null}
        {options.map((o) => (
          <label key={o.value} className={cx('multi-select-option', o.child && 'multi-select-child')}>
            <input
              type="checkbox"
              checked={chosen.has(o.value)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                onChange(on ? [...value, o.value] : value.filter((v) => v !== o.value));
              }}
            />
            {o.label}
          </label>
        ))}
        {options.length === 0 ? <span className="muted">None available</span> : null}
      </div>
    </details>
  );
}
