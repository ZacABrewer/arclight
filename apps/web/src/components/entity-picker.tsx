import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/cx.js';

export interface EntityOption {
  id: number;
  label: string;
  /** Secondary text (year, path). Also searched. */
  detail?: string | undefined;
}

export interface EntityPickerProps {
  options: readonly EntityOption[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  'aria-label': string;
  disabled?: boolean;
  /** Most matches shown at once. */
  limit?: number;
}

/** Case-insensitive match on every word of the query against label + detail. */
export function filterOptions(options: readonly EntityOption[], query: string, limit = 50): EntityOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length === 0 ? options : options.filter((o) => {
    const hay = `${o.label} ${o.detail ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return hits.slice(0, limit);
}

/** A searchable single-select dropdown (series / movie pickers). */
export function EntityPicker({ options, value, onChange, placeholder = 'Choose…', disabled = false, limit = 50, ...aria }: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.id === value);
  const matches = useMemo(() => filterOptions(options, query, limit), [options, query, limit]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (o: EntityOption) => {
    onChange(o.id);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="entity-picker" ref={ref}>
      <button
        type="button"
        className={cx('input', 'select', 'entity-picker-button', !selected && 'muted')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={aria['aria-label']}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
      >
        {selected ? selected.label : placeholder}
      </button>
      {open ? (
        <div className="entity-picker-pop">
          <input
            className="input"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label={`Search ${aria['aria-label']}`}
            placeholder="Search…"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const o = matches[active];
                if (o) choose(o);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <ul id={listId} role="listbox" className="entity-picker-list">
            {matches.map((o, i) => (
              <li
                key={o.id}
                role="option"
                aria-selected={o.id === value}
                className={cx('entity-picker-option', i === active && 'entity-picker-active')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
              >
                {o.label}
                {o.detail ? <span className="muted"> {o.detail}</span> : null}
              </li>
            ))}
            {matches.length === 0 ? <li className="muted entity-picker-option">No matches</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
