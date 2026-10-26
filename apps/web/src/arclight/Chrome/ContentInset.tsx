import type { ElementType, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface ContentInsetProps {
  children: ReactNode;
  /**
   * Details pages put the backdrop image flush under the top bar; content then manages its
   * own top offset.
   */
  flushTop?: boolean | undefined;
  as?: ElementType | undefined;
  id?: string | undefined;
  className?: string | undefined;
}

/**
 * Content area: left 124 (rail 84 + 40) / right 40 / top 96 (top bar 60 + 36). Tablet uses
 * the 64px rail; mobile is single column with 20px sides and room for the 86px tab bar.
 */
export function ContentInset({ children, flushTop, as: As = 'main', id, className }: ContentInsetProps) {
  return (
    <As id={id} className={cx('al-content', flushTop && 'al-content--flush-top', className)}>
      {children}
    </As>
  );
}
