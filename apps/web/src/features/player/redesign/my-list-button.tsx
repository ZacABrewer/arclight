import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { myListKey, useToggleMyList } from './api.js';
import { RdIcon } from './icons.js';

// The My List toggle (redesign spec §4.2): "+ My List" / "✓ In My List" in the design's
// secondary button; `square` is the phone hero's 48 px icon-only toggle, `stacked` the phone
// detail's icon-and-label action.

export interface MyListButtonProps {
  kind: 'movie' | 'series';
  id: number;
  inList: boolean;
  variant?: 'button' | 'square' | 'stacked' | undefined;
  className?: string | undefined;
}

export function MyListButton({ kind, id, inList, variant = 'button', className }: MyListButtonProps) {
  const t = useT();
  const toggle = useToggleMyList();
  // Show the new state at once; the server answer refreshes the pages.
  const shown = toggle.isPending && toggle.variables ? toggle.variables.add : inList;
  const label = shown ? t('player.redesign.myList.in') : t('player.redesign.myList.add');
  const onClick = () => toggle.mutate({ key: myListKey(kind, id), add: !shown });
  const icon = <RdIcon name={shown ? 'check' : 'plus'} size={variant === 'button' ? 20 : 22} className={cx('rd-mylist__icon', shown && 'is-on')} />;
  if (variant === 'square') {
    return (
      <button type="button" className={cx('rd-btn rd-btn--secondary rd-btn--square', className)} aria-pressed={shown} aria-label={t('player.redesign.myList.label')} onClick={onClick}>
        {icon}
      </button>
    );
  }
  if (variant === 'stacked') {
    return (
      <button type="button" className={cx('rd-action', className)} aria-pressed={shown} onClick={onClick}>
        {icon}
        <span>{label}</span>
      </button>
    );
  }
  return (
    <button type="button" className={cx('rd-btn rd-btn--secondary', className)} aria-pressed={shown} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
