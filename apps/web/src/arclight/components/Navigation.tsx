import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { t } from '../../i18n/index.js';

/* ------------------------------------------------------------------ Paginator */

export interface PaginatorProps {
  /** 1-based. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  className?: string | undefined;
}

/** Mono "Page 1 of 4" with ‹ › square buttons. */
export function Paginator({ page, pageCount, onPageChange, className }: PaginatorProps) {
  const total = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), total);
  return (
    <nav className={cx('al-paginator', className)} aria-label={t('arclight.navigation.pagination')}>
      <span aria-live="polite">
        {t('arclight.navigation.page')} <span className="al-paginator__num">{current}</span> {t('common.of')} <span className="al-paginator__num">{total}</span>
      </span>
      <Button variant="secondary" size="sm" aria-label={t('arclight.navigation.previousPage')} icon={<Icon name="chevronLeft" />} disabled={current <= 1} onClick={() => onPageChange(current - 1)} />
      <Button variant="secondary" size="sm" aria-label={t('arclight.navigation.nextPage')} icon={<Icon name="chevronRight" />} disabled={current >= total} onClick={() => onPageChange(current + 1)} />
    </nav>
  );
}

/* ------------------------------------------------------------------ FilterBar */

export interface FilterBarProps {
  /** Selects, segmented controls, search fields. */
  children: ReactNode;
  /** Shows a ghost "Clear" when filters are active. */
  onClear?: (() => void) | undefined;
  /** Number of active filters; Clear is hidden at 0. */
  activeCount?: number | undefined;
  /** Right-aligned slot (result count, view toggle). */
  end?: ReactNode | undefined;
  className?: string | undefined;
}

/** Row of selects / segmented controls + "Clear". */
export function FilterBar({ children, onClear, activeCount, end, className }: FilterBarProps) {
  const showClear = onClear && (activeCount === undefined || activeCount > 0);
  return (
    <div className={cx('al-filterbar', className)} role="group" aria-label={t('arclight.navigation.filters')}>
      {children}
      {showClear ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t('arclight.navigation.clear')}
        </Button>
      ) : null}
      {end ? (
        <>
          <span className="al-filterbar__spacer" />
          {end}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Tabs */

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Mono count after the label ("Queue 8"). */
  count?: number | undefined;
  /** Panel content. Omit for route-driven tabs (only the tab list renders). */
  content?: ReactNode;
  disabled?: boolean | undefined;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((id: string) => void) | undefined;
  /** In-header tabs (Activity: Queue / History / Blocklist / Pending) without the bottom rule. */
  compact?: boolean | undefined;
  'aria-label'?: string | undefined;
  className?: string | undefined;
}

/** `.al-tabs` — WAI-ARIA tabs, ←/→/Home/End. Same API as the old Tabs plus `count`. */
export function Tabs({ tabs, value, defaultValue, onChange, compact, className, ...aria }: TabsProps) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id ?? '');
  const active = value ?? internal;
  const enabled = tabs.filter((tab) => !tab.disabled);
  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const idx = enabled.findIndex((item) => item.id === active);
    let next: TabItem | undefined;
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  };
  const current = tabs.find((entry) => entry.id === active);
  const hasPanels = tabs.some((row) => row.content !== undefined);
  return (
    <div className={className}>
      <div role="tablist" aria-label={aria['aria-label']} className={cx('al-tabs', compact && 'al-tabs--compact')} onKeyDown={onKeyDown}>
        {tabs.map((el) => (
          <button
            key={el.id}
            id={`${baseId}-tab-${el.id}`}
            type="button"
            role="tab"
            aria-selected={el.id === active}
            aria-controls={hasPanels ? `${baseId}-panel-${el.id}` : undefined}
            tabIndex={el.id === active ? 0 : -1}
            disabled={el.disabled}
            onClick={() => select(el.id)}
          >
            {el.label}
            {el.count !== undefined ? <span className="al-tabs__count">{el.count}</span> : null}
          </button>
        ))}
      </div>
      {hasPanels && current ? (
        <div role="tabpanel" id={`${baseId}-panel-${current.id}`} aria-labelledby={`${baseId}-tab-${current.id}`} className="al-tabpanel">
          {current.content}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Accordion */

export interface AccordionItemProps {
  title: ReactNode;
  /** Text after the title ("Airing · 1 of 9 aired", "Complete"). */
  meta?: ReactNode | undefined;
  /** Controls in the header outside the toggle button (monitor toggle, meter, "Search season"). */
  aside?: ReactNode | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  children: ReactNode;
  className?: string | undefined;
}

/** Season-style accordion row (Page 03): ▸ collapsed 46px, ▾ cyan + glass when open. */
export function AccordionItem({ title, meta, aside, open: controlled, defaultOpen = false, onOpenChange, children, className }: AccordionItemProps) {
  const id = useId();
  const [internal, setInternal] = useState(defaultOpen);
  const open = controlled ?? internal;
  const toggle = () => {
    if (controlled === undefined) setInternal(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={cx('al-acc', className)} data-open={open}>
      <div className="al-acc__head">
        <button type="button" className="al-acc__trigger" aria-expanded={open} aria-controls={`${id}-panel`} onClick={toggle}>
          <span className="al-acc__chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="al-acc__title">{title}</span>
        </button>
        {meta ? <span className="al-acc__meta">{meta}</span> : null}
        {aside ? <div className="al-acc__aside">{aside}</div> : null}
      </div>
      {open ? (
        <div id={`${id}-panel`} className="al-acc__body" role="region">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Vertical stack of AccordionItems with the 10px gap. */
export function Accordion({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <div className={cx('al-acc-stack', className)}>{children}</div>;
}

/* ------------------------------------------------------------------ Stepper */

export type StepState = 'done' | 'active' | 'todo';

export interface StepperStep {
  id: string;
  label: ReactNode;
  /** Override the derived state. */
  state?: StepState | undefined;
}

export interface StepperProps {
  steps: readonly StepperStep[];
  /** 0-based index of the active step; earlier = done, later = todo. */
  current: number;
  /** Make done steps clickable (go back to a finished step). */
  onStepClick?: ((index: number) => void) | undefined;
  'aria-label'?: string | undefined;
  className?: string | undefined;
}

export function stepState(index: number, current: number): StepState {
  if (index < current) return 'done';
  if (index === current) return 'active';
  return 'todo';
}

/** Diamond stepper (Page 08): done = filled, active = glow, todo = dim. */
export function Stepper({ steps, current, onStepClick, className, ...aria }: StepperProps) {
  return (
    <ol className={cx('al-stepper', className)} aria-label={aria['aria-label'] ?? t('common.progress')}>
      {steps.map((s, i) => {
        const state = s.state ?? stepState(i, current);
        const body = (
          <>
            <span className="al-step__line" aria-hidden="true" />
            <span className="al-step__diamond" aria-hidden="true" />
            <span className="al-step__label">
              {s.label}
              <span className="al-sr-only">{state === 'done' ? t('arclight.navigation.done') : state === 'active' ? t('arclight.navigation.current') : ''}</span>
            </span>
          </>
        );
        return (
          <li key={s.id} className="al-step" data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
            {onStepClick && state === 'done' ? (
              <button type="button" className="al-step__button" onClick={() => onStepClick(i)} style={{ all: 'unset', cursor: 'pointer', display: 'contents' }}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
