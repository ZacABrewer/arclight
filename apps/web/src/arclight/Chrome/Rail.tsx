import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { cx } from '../cx.js';
import { Mark } from '../components/Icon.js';

export type RailCode = 'DB' | 'LB' | 'DS' | 'RQ' | 'CL' | 'WN' | 'AC' | 'SB' | 'IX' | 'ST' | 'SY';

export interface RailItem {
  code: RailCode | (string & {});
  /** 9px label under the code (DASH, LIB …). */
  label: string;
  /** Full name — accessible name and tooltip ("Dashboard"). */
  title: string;
  href?: string | undefined;
  /** Hide for non-admin users (the caller filters; kept here for convenience). */
  adminOnly?: boolean | undefined;
}

/** The 11 rail codes from the handoff README, in order. */
export const RAIL_ITEMS: readonly RailItem[] = [
  { code: 'DB', label: 'DASH', title: 'Dashboard' },
  { code: 'LB', label: 'LIB', title: 'Library' },
  { code: 'DS', label: 'DISC', title: 'Discover' },
  { code: 'RQ', label: 'REQ', title: 'Requests' },
  { code: 'CL', label: 'CAL', title: 'Calendar' },
  { code: 'WN', label: 'WANT', title: 'Wanted' },
  { code: 'AC', label: 'ACT', title: 'Activity', adminOnly: true },
  { code: 'SB', label: 'SUBS', title: 'Subtitles', adminOnly: true },
  { code: 'IX', label: 'INDX', title: 'Indexers', adminOnly: true },
  { code: 'ST', label: 'SET', title: 'Settings', adminOnly: true },
  { code: 'SY', label: 'SYS', title: 'System', adminOnly: true },
];

export interface RailProps {
  /** Active code; none on 404. */
  active?: string | null | undefined;
  items?: readonly RailItem[] | undefined;
  /**
   * Called on activation. With an `href`, call `e.preventDefault()` and route client-side
   * (TanStack `router.navigate`) — modifier-clicks keep their native behaviour.
   */
  onSelect?: ((code: string, e: MouseEvent<HTMLElement>) => void) | undefined;
  /** Force the 64px code-only rail (it switches automatically at 768–1279px). */
  compact?: boolean | undefined;
  /** Href for the diamond mark (home). */
  homeHref?: string | undefined;
  className?: string | undefined;
}

/**
 * Nav rail: 84px, diamond mark, two-letter codes, active = 2px cyan bar with glow.
 * Keyboard: Tab enters on the active item; ↑/↓/Home/End move between items.
 */
export function Rail({ active, items = RAIL_ITEMS, onSelect, compact, homeHref, className }: RailProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.code === active),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-rail-item]') ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % els.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + els.length) % els.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = els.length - 1;
    if (next < 0) return;
    e.preventDefault();
    els.forEach((el, i) => el.setAttribute('tabindex', i === next ? '0' : '-1'));
    els[next]?.focus();
  };

  return (
    <nav className={cx('al-rail', compact && 'al-rail--compact', className)} aria-label="Main">
      {homeHref ? (
        <a className="al-rail__mark" href={homeHref} aria-label="Arclight home" onClick={(e) => onSelect?.('DB', e)}>
          <Mark size={40} />
        </a>
      ) : (
        <span className="al-rail__mark">
          <Mark size={40} label="Arclight" />
        </span>
      )}
      <ul ref={listRef} className="al-rail__list" onKeyDown={onKeyDown}>
        {items.map((item, i) => {
          const isActive = item.code === active;
          const common = {
            className: 'al-rail__item',
            'data-rail-item': item.code,
            'aria-current': isActive ? ('page' as const) : undefined,
            'aria-label': item.title,
            title: item.title,
            tabIndex: i === activeIndex ? 0 : -1,
            onClick: (e: MouseEvent<HTMLElement>) => onSelect?.(item.code, e),
          };
          const content = (
            <>
              <span className="al-rail__bar" aria-hidden="true" />
              <span className="al-rail__code" aria-hidden="true">
                {item.code}
              </span>
              <span className="al-rail__label" aria-hidden="true">
                {item.label}
              </span>
            </>
          );
          return (
            <li key={item.code}>
              {item.href ? (
                <a href={item.href} {...common}>
                  {content}
                </a>
              ) : (
                <button type="button" {...common}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
