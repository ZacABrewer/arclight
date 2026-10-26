import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Input, cx } from '../arclight/index.js';
import './pickers.css';
import { t } from '../i18n/index.js';

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

/** A searchable single-select dropdown (series / movie pickers), drawn as an Arclight select menu. */
export function EntityPicker({ options, value, onChange, placeholder = t('components.entityPicker.choose'), disabled = false, limit = 50, ...aria }: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
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

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (o: EntityOption) => {
    onChange(o.id);
    close(true);
  };

  return (
    <div className="al-selectmenu mt-entity" data-open={open} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="al-selectmenu__button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={aria['aria-label']}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
            setActive(0);
          }
        }}
      >
        <span className={selected ? undefined : 'mt-entity__placeholder'}>{selected ? selected.label : placeholder}</span>
        <span className="al-selectmenu__caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <div className="mt-entity__pop">
          <Input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={matches[active] ? `${listId}-${matches[active].id}` : undefined}
            aria-label={t('components.entityPicker.searchValue', { value: aria['aria-label'] })}
            placeholder={t('components.entityPicker.search')}
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
                close(true);
              }
            }}
          />
          <ul id={listId} role="listbox" className="al-listbox" aria-label={aria['aria-label']}>
            {matches.map((o, i) => (
              <li
                key={o.id}
                id={`${listId}-${o.id}`}
                role="option"
                aria-selected={o.id === value}
                data-active={i === active}
                className="al-listbox__option"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
              >
                {o.label}
                {o.detail ? <span className="mt-entity__detail"> {o.detail}</span> : null}
              </li>
            ))}
            {matches.length === 0 ? <li className="mt-entity__none">{t('components.entityPicker.noMatches')}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
