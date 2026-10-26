import type { ElementType, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface SectionLabelProps {
  children: ReactNode;
  /** Appended as " · N" in mono ("ISSUES · 2"). */
  count?: number | undefined;
  /** warn: e.g. ISSUES when issues exist. */
  tone?: 'default' | 'warn' | 'danger' | 'accent' | undefined;
  as?: ElementType | undefined;
  className?: string | undefined;
  id?: string | undefined;
}

/** `.al-label` — the spaced mono CAPS section label. The only place letter-spaced caps are allowed. */
export function SectionLabel({ children, count, tone = 'default', as: As = 'div', className, id }: SectionLabelProps) {
  return (
    <As id={id} className={cx('al-label', className)} data-tone={tone === 'default' ? undefined : tone} style={As === 'div' ? undefined : { margin: 0 }}>
      {children}
      {count !== undefined ? ` · ${count}` : null}
    </As>
  );
}

/** Label on the left, an action (link/button) on the right — pane and section headers. */
export function SectionHead({ label, action, className }: { label: ReactNode; action?: ReactNode; className?: string | undefined }) {
  return (
    <div className={cx('al-section-head', className)}>
      {typeof label === 'string' ? <SectionLabel>{label}</SectionLabel> : label}
      {action}
    </div>
  );
}

/** Mono index + title, e.g. "01 Library" — use PageHeader for full page headers. */
export function Index({ children }: { children: ReactNode }) {
  return <span className="al-index">{children}</span>;
}
