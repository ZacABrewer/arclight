import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Checkbox, cx } from '../arclight/index.js';
import './pickers.css';

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

/** Summary text: the empty label, up to two names, or "N selected". */
export function multiSelectSummary(options: readonly MultiSelectOption[], value: readonly number[], emptyLabel = 'Any'): string {
  if (value.length === 0) return emptyLabel;
  if (value.length > 2) return `${value.length} selected`;
  const chosen = new Set(value);
  return options
    .filter((o) => chosen.has(o.value))
    .map((o) => o.label)
    .join(', ');
}

/**
 * Arclight multi-select: a square `.al-selectmenu` button that opens a checkbox list.
 * Keyboard: Enter/Space/↓ open, ↑/↓ move between options, Space toggles, Esc closes.
 */
export function MultiSelect({ label, options, value, onChange, emptyLabel = 'Any' }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const chosen = new Set(value);
  const summary = multiSelectSummary(options, value, emptyLabel);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const focusables = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('.mt-multi__panel input, .mt-multi__panel button') ?? [])];

  const onPanelKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = focusables();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
    items[next]?.focus();
  };

  const toggle = (v: number, on: boolean) => onChange(on ? [...value, v] : value.filter((x) => x !== v));

  return (
    <div ref={rootRef} className="al-selectmenu mt-multi" data-open={open}>
      <button
        ref={buttonRef}
        type="button"
        className="al-selectmenu__button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusables()[0]?.focus());
          }
        }}
      >
        <span className={cx('mt-multi__summary', value.length === 0 && 'mt-multi__summary--empty')}>{summary}</span>
        <span className="al-selectmenu__caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <div id={listId} className="al-listbox mt-multi__panel" role="group" aria-label={label} onKeyDown={onPanelKey}>
          {value.length > 0 ? (
            <button type="button" className="mt-multi__clear" onClick={() => onChange([])}>
              Clear
            </button>
          ) : null}
          {options.map((o) => (
            <Checkbox
              key={o.value}
              className={cx('mt-multi__option', o.child && 'mt-multi__option--child')}
              label={o.label}
              checked={chosen.has(o.value)}
              onChange={(e) => toggle(o.value, e.currentTarget.checked)}
            />
          ))}
          {options.length === 0 ? <span className="mt-multi__none">None available</span> : null}
        </div>
      ) : null}
    </div>
  );
}
