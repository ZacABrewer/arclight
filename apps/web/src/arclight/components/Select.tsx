import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { cx } from '../cx.js';
import { t } from '../../i18n/index.js';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean | undefined;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: readonly SelectOption[] | undefined;
  /** Disabled first option shown while nothing is chosen. */
  placeholder?: string | undefined;
  invalid?: boolean | undefined;
  ref?: Ref<HTMLSelectElement> | undefined;
}

/**
 * `.al-select` — native select (works with FormData, mobile pickers, screen readers). Same
 * props as the old Select. Use SelectMenu where the open list must match the kit drawing.
 */
export function Select({ className, options, placeholder, invalid, children, ...rest }: SelectProps) {
  return (
    <select className={cx('al-select', className)} aria-invalid={invalid || undefined} {...rest}>
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}

export interface SelectMenuProps<V extends string = string> {
  options: readonly SelectOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  placeholder?: string | undefined;
  /** Accessible name when there is no visible <label htmlFor>. */
  'aria-label'?: string | undefined;
  id?: string | undefined;
  disabled?: boolean | undefined;
  /** CSS width; default 240px like the kit. */
  width?: number | string | undefined;
  className?: string | undefined;
  renderOption?: ((option: SelectOption<V>) => ReactNode) | undefined;
}

/**
 * Custom listbox select drawn as in Design Kit §08 (header row with ▴, options 9/12px,
 * selected row cyan 12%). Keyboard: ↑/↓/Home/End move, Enter/Space choose, Esc closes,
 * typing a letter jumps.
 */
export function SelectMenu<V extends string = string>({
  options,
  value,
  onChange,
  placeholder = t('arclight.select.select'),
  id,
  disabled,
  width = 240,
  className,
  renderOption,
  ...aria
}: SelectMenuProps<V>) {
  const autoId = useId();
  const buttonId = id ?? `${autoId}-button`;
  const listId = `${autoId}-list`;
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [active, setActive] = useState(Math.max(0, selectedIndex));
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const move = (from: number, dir: 1 | -1) => {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + dir * i + options.length) % options.length;
      if (!options[next]?.disabled) return next;
    }
    return from;
  };

  const choose = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    document.getElementById(buttonId)?.focus();
  };

  const openList = () => {
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openList();
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => move(a, 1));
    else if (e.key === 'ArrowUp') setActive((a) => move(a, -1));
    else if (e.key === 'Home') setActive(move(-1, 1));
    else if (e.key === 'End') setActive(move(options.length, -1));
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      if (e.key === 'Escape') document.getElementById(buttonId)?.focus();
      if (e.key === 'Tab') return;
    } else if (e.key.length === 1) {
      const ch = e.key.toLowerCase();
      const hit = options.findIndex((o, i) => i > active && !o.disabled && o.label.toLowerCase().startsWith(ch));
      const wrap = hit >= 0 ? hit : options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(ch));
      if (wrap >= 0) setActive(wrap);
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={rootRef} className={cx('al-selectmenu', className)} data-open={open} style={{ width }}>
      <button
        id={buttonId}
        type="button"
        className="al-selectmenu__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={aria['aria-label']}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onButtonKey}
      >
        <span style={current ? undefined : { color: 'var(--al-placeholder)' }}>{current ? current.label : placeholder}</span>
        <span className="al-selectmenu__caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          className="al-listbox"
          aria-labelledby={aria['aria-label'] ? undefined : buttonId}
          aria-label={aria['aria-label']}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              className="al-listbox__option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {renderOption ? renderOption(o) : o.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
