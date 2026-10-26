import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { cx } from '../cx.js';
import { Mark } from '../components/Icon.js';
import { t } from '../../i18n/index.js';

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
  { code: 'DB', get label() { return t('arclight.chrome.rail.dash'); }, get title() { return t('common.dashboard'); } },
  { code: 'LB', get label() { return t('arclight.chrome.rail.lib'); }, get title() { return t('common.library'); } },
  { code: 'DS', get label() { return t('arclight.chrome.rail.disc'); }, get title() { return t('common.discover'); } },
  { code: 'RQ', get label() { return t('arclight.chrome.rail.req'); }, get title() { return t('common.requests'); } },
  { code: 'CL', get label() { return t('arclight.chrome.rail.cal'); }, get title() { return t('common.calendar'); } },
  { code: 'WN', get label() { return t('arclight.chrome.rail.want'); }, get title() { return t('common.wanted'); } },
  { code: 'AC', get label() { return t('arclight.chrome.rail.act'); }, get title() { return t('common.activity'); }, adminOnly: true },
  { code: 'SB', get label() { return t('arclight.chrome.rail.subs'); }, get title() { return t('common.subtitles'); }, adminOnly: true },
  { code: 'IX', get label() { return t('arclight.chrome.rail.indx'); }, get title() { return t('common.indexers'); }, adminOnly: true },
  { code: 'ST', get label() { return t('arclight.chrome.rail.set'); }, get title() { return t('common.settings'); }, adminOnly: true },
  { code: 'SY', get label() { return t('arclight.chrome.rail.sys'); }, get title() { return t('common.system'); }, adminOnly: true },
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
 * Nav rail: 84px, diamond mark, two-letter codes, active = 2px cyan bar with glow, and a
 * decorative light runner on the right border.
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
    <>
      <nav className={cx('al-rail', compact && 'al-rail--compact', className)} aria-label={t('arclight.chrome.rail.main')}>
        {homeHref ? (
          <a className="al-rail__mark" href={homeHref} aria-label={t('arclight.chrome.rail.arclightHome')} onClick={(e) => onSelect?.('DB', e)}>
            <Mark size={40} />
          </a>
        ) : (
          <span className="al-rail__mark">
            <Mark size={40} label={t('arclight.chrome.rail.arclight')} />
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
      {/* v1.1 ambient light: a runner travels down the rail's right border (9 s loop). */}
      <span className="al-rail__runner" aria-hidden="true">
        <i className="al-runner al-runner--v" />
      </span>
    </>
  );
}
