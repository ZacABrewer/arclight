import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '../cx.js';
import { t } from '../../i18n/index.js';

export interface TooltipProps {
  /** Tooltip content — plain text or a short list (release rejections). */
  content: ReactNode;
  /** One focusable element (button, link); it gets aria-describedby. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: 'top' | 'bottom' | undefined;
  /** Delay before showing on hover, ms. */
  delay?: number | undefined;
}

/**
 * `.al-tooltip` — shows on hover and keyboard focus, hides on blur / mouse leave / Esc.
 * Icon-only buttons must have both an aria-label and a tooltip (Design Kit §09).
 */
export function Tooltip({ content, children, placement = 'top', delay = 300 }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (immediate: boolean) => {
    clearTimeout(timer.current);
    if (immediate || delay <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const trigger = isValidElement(children) ? cloneElement(children, { 'aria-describedby': open ? id : undefined } as { 'aria-describedby'?: string }) : children;
  return (
    <span className="al-anchor" onMouseEnter={() => show(false)} onMouseLeave={hide} onFocus={() => show(true)} onBlur={hide}>
      {trigger}
      {open ? (
        <span role="tooltip" id={id} className={cx('al-tooltip', 'al-tooltip--float', `al-tooltip--${placement}`)}>
          {content}
        </span>
      ) : null}
    </span>
  );
}

/** Rejection list content for a tooltip ("2 rejections · Quality … · Size …"). */
export function RejectionList({ reasons }: { reasons: readonly string[] }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontWeight: 600, color: 'var(--al-warn-text)' }}>
        {t('arclight.tooltip.rejections', { reasonsCount: reasons.length })}
      </span>
      {reasons.map((r) => (
        <span key={r}>· {r}</span>
      ))}
    </span>
  );
}

export interface PopoverProps {
  /** Render prop for the trigger; spread `props` onto a button. */
  trigger: (props: { 'aria-expanded': boolean; 'aria-controls': string; 'aria-haspopup': 'dialog'; onClick: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | undefined;
  /** Width in px (default 320 — calendar item popover). */
  width?: number | undefined;
  /** Controlled open state. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  label?: string | undefined;
  className?: string | undefined;
}

/**
 * Popover = the tooltip shell with 16px padding, opened by click. Closes on outside click
 * and Esc (focus returns to the trigger).
 */
export function Popover({ trigger, children, placement = 'bottom-start', width, open: controlled, onOpenChange, label, className }: PopoverProps) {
  const id = useId();
  const [internal, setInternal] = useState(false);
  const open = controlled ?? internal;
  const rootRef = useRef<HTMLSpanElement>(null);
  const setOpen = (v: boolean) => {
    if (controlled === undefined) setInternal(v);
    onOpenChange?.(v);
  };
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // close is stable enough for this effect's lifetime
    // (it only reads the latest props through setOpen).
  });

  return (
    <span ref={rootRef} className="al-anchor">
      {trigger({ 'aria-expanded': open, 'aria-controls': id, 'aria-haspopup': 'dialog', onClick: () => setOpen(!open) })}
      {open ? (
        <div id={id} role="dialog" aria-label={label} className={cx('al-popover', `al-popover--${placement}`, className)} style={width ? { width } : undefined}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      ) : null}
    </span>
  );
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect?: (() => void) | undefined;
  href?: string | undefined;
  danger?: boolean | undefined;
  separatorBefore?: boolean | undefined;
}

/** Simple action menu for a popover body (user menu, row "more" menu). */
export function Menu({ items, onDone, header }: { items: readonly MenuItem[]; onDone?: (() => void) | undefined; header?: ReactNode }) {
  return (
    <div className="al-menu" role="menu">
      {header ? <div className="al-menu__meta">{header}</div> : null}
      {items.map((item) => (
        <MenuEntry key={item.id} item={item} onDone={onDone} />
      ))}
    </div>
  );
}

function MenuEntry({ item, onDone }: { item: MenuItem; onDone?: (() => void) | undefined }) {
  const cls = cx('al-menu__item', item.danger && 'al-menu__item--danger');
  const select = () => {
    item.onSelect?.();
    onDone?.();
  };
  return (
    <>
      {item.separatorBefore ? <div className="al-menu__sep" role="separator" /> : null}
      {item.href ? (
        <a role="menuitem" className={cls} href={item.href} onClick={select}>
          {item.label}
        </a>
      ) : (
        <button type="button" role="menuitem" className={cls} onClick={select}>
          {item.label}
        </button>
      )}
    </>
  );
}
