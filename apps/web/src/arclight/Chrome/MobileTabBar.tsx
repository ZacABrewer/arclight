import type { MouseEvent } from 'react';
import { cx } from '../cx.js';
import { Icon, type IconName } from '../components/Icon.js';
import { t } from '../../i18n/index.js';

export interface TabBarItem {
  id: string;
  label: string;
  icon: IconName;
  href?: string | undefined;
}

/** Home / Library / Discover / Activity / More (handoff README §13). */
export const MOBILE_TABS: readonly TabBarItem[] = [
  { id: 'home', get label() { return t('arclight.chrome.mobileTabBar.home'); }, icon: 'home' },
  { id: 'library', get label() { return t('common.library'); }, icon: 'library' },
  { id: 'discover', get label() { return t('common.discover'); }, icon: 'discover' },
  { id: 'activity', get label() { return t('common.activity'); }, icon: 'activity' },
  { id: 'more', get label() { return t('common.more'); }, icon: 'more' },
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
    <nav className={cx('al-tabbar', alwaysVisible && 'al-tabbar--always', className)} aria-label={t('arclight.chrome.mobileTabBar.main')}>
      {items.map((tabBar) => {
        const common = {
          className: 'al-tabbar__item',
          'aria-current': tabBar.id === active ? ('page' as const) : undefined,
          onClick: (e: MouseEvent<HTMLElement>) => onSelect?.(tabBar.id, e),
        };
        const body = (
          <>
            <span className="al-tabbar__bar" aria-hidden="true" />
            <Icon name={tabBar.icon} size={20} />
            <span>{tabBar.label}</span>
          </>
        );
        return tabBar.href ? (
          <a key={tabBar.id} href={tabBar.href} {...common}>
            {body}
          </a>
        ) : (
          <button key={tabBar.id} type="button" {...common}>
            {body}
          </button>
        );
      })}
    </nav>
  );
}
