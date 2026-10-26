import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../cx.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { t, monthNames, weekdayNames } from '../../i18n/index.js';


/** 'YYYY-MM-DD' for a local date. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse 'YYYY-MM-DD' as a local date (no timezone drift). */
export function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 42 cells (6 weeks, Monday first) covering the month of `year`/`month`. */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
}

export interface DatePickerProps {
  /** 'YYYY-MM-DD' or null. */
  value: string | null;
  onChange: (value: string) => void;
  min?: string | undefined;
  max?: string | undefined;
  /** For tests / fixed "today". */
  today?: string | undefined;
  'aria-label'?: string | undefined;
  className?: string | undefined;
}

/** 7-column month grid like the Calendar; selected day = cyan fill. Arrow keys move by day/week. */
export function DatePicker({ value, onChange, min, max, today, className, ...aria }: DatePickerProps) {
  const selected = parseIsoDate(value);
  const todayIso = today ?? toIsoDate(new Date());
  const start = selected ?? parseIsoDate(todayIso) ?? new Date();
  const [view, setView] = useState({ y: start.getFullYear(), m: start.getMonth() });
  const [focusIso, setFocusIso] = useState(toIsoDate(start));
  const gridRef = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => monthGrid(view.y, view.m), [view]);

  const tabIso = cells.some((c) => toIsoDate(c) === focusIso) ? focusIso : toIsoDate(new Date(view.y, view.m, 1));
  const outOfRange = (iso: string) => (min !== undefined && iso < min) || (max !== undefined && iso > max);
  const shiftMonth = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };
  const moveFocus = (days: number) => {
    const base = parseIsoDate(focusIso) ?? start;
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
    const iso = toIsoDate(d);
    setFocusIso(iso);
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) setView({ y: d.getFullYear(), m: d.getMonth() });
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${iso}"]`)?.focus());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = map[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    moveFocus(delta);
  };

  return (
    <div className={cx('al-datepicker', className)} role="group" aria-label={aria['aria-label'] ?? t('arclight.datePicker.chooseADate')}>
      <div className="al-datepicker__head">
        <span className="al-datepicker__month" aria-live="polite">
          {monthNames()[view.m]} <span className="al-num">{view.y}</span>
        </span>
        <Button size="sm" aria-label={t('arclight.datePicker.previousMonth')} icon={<Icon name="chevronLeft" />} onClick={() => shiftMonth(-1)} style={{ width: 28, height: 28 }} />
        <Button size="sm" aria-label={t('arclight.datePicker.nextMonth')} icon={<Icon name="chevronRight" />} onClick={() => shiftMonth(1)} style={{ width: 28, height: 28 }} />
      </div>
      <div ref={gridRef} className="al-datepicker__grid" role="grid" onKeyDown={onKeyDown}>
        {weekdayNames(1, 'short').map((w) => w.replace('.', '').toUpperCase()).map((w) => (
          <div key={w} className="al-datepicker__wd" role="columnheader" aria-label={w}>
            {w.slice(0, 2)}
          </div>
        ))}
        {cells.map((d) => {
          const iso = toIsoDate(d);
          const outside = d.getMonth() !== view.m;
          const isSel = value === iso;
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              data-iso={iso}
              className="al-datepicker__day"
              data-outside={outside || undefined}
              data-today={iso === todayIso || undefined}
              aria-selected={isSel}
              aria-label={`${d.getDate()} ${monthNames()[d.getMonth()]} ${d.getFullYear()}`}
              tabIndex={iso === tabIso ? 0 : -1}
              disabled={outOfRange(iso)}
              onClick={() => {
                setFocusIso(iso);
                onChange(iso);
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
