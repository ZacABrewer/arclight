import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface PageHeaderProps {
  /** Mono index ("00" Dashboard, "01" Library …). */
  index?: string | undefined;
  /** Title case page title (title-l). */
  title: ReactNode;
  /** Muted line after the controls ("214 series · 38.2 TB") — numbers should be mono. */
  subtitle?: ReactNode | undefined;
  /** Page controls next to the title: segmented, tabs, sort, filter, size slider. */
  children?: ReactNode;
  /** Right-aligned actions (primary last: "Add series"). */
  actions?: ReactNode | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

/** Page header = mono index + title-l + page controls, actions right-aligned. */
export function PageHeader({ index, title, subtitle, children, actions, className, style }: PageHeaderProps) {
  return (
    <header className={cx('al-page-header', className)} style={style}>
      {index ? (
        <span className="al-index" aria-hidden="true">
          {index}
        </span>
      ) : null}
      <h1 className="al-title-l al-page-header__title">{title}</h1>
      {children ? <div className="al-page-header__controls">{children}</div> : null}
      {subtitle ? <div className="al-page-header__subtitle">{subtitle}</div> : null}
      {actions ? <div className="al-page-header__actions">{actions}</div> : null}
    </header>
  );
}
