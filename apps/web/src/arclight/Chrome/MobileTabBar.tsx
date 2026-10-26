import type { MouseEvent } from 'react';
import { cx } from '../cx.js';
import { Icon, type IconName } from '../components/Icon.js';

export interface TabBarItem {
  id: string;
  label: string;
  icon: IconName;
  href?: string | undefined;
}

/** Home / Library / Discover / Activity / More (handoff README §13). */
export const MOBILE_TABS: readonly TabBarItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'discover', label: 'Discover', icon: 'discover' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'more', label: 'More', icon: 'more' },
];

export interface MobileTabBarProps {
  active?: string | undefined;
  items?: readonly TabBarItem[] | undefined;
  onSelect?: ((id: string, e: MouseEvent<HTMLElement>) => void) | undefined;
  /** Show at every width (gallery); by default it only appears below 768px. */
  alwaysVisible?: boolean | undefined;
  className?: string | undefined;
}

/** Bottom tab bar: 86px incl. safe area, ≥44px targets, active = 2px top bar with glow. */
export function MobileTabBar({ active, items = MOBILE_TABS, onSelect, alwaysVisible, className }: MobileTabBarProps) {
  return (
    <nav className={cx('al-tabbar', alwaysVisible && 'al-tabbar--always', className)} aria-label="Main">
      {items.map((t) => {
        const common = {
          className: 'al-tabbar__item',
          'aria-current': t.id === active ? ('page' as const) : undefined,
          onClick: (e: MouseEvent<HTMLElement>) => onSelect?.(t.id, e),
        };
        const body = (
          <>
            <span className="al-tabbar__bar" aria-hidden="true" />
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </>
        );
        return t.href ? (
          <a key={t.id} href={t.href} {...common}>
            {body}
          </a>
        ) : (
          <button key={t.id} type="button" {...common}>
            {body}
          </button>
        );
      })}
    </nav>
  );
}
