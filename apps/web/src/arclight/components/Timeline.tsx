import type { ReactNode } from 'react';
import { cx } from '../cx.js';

export interface TimelineItem {
  id: string;
  /** Mono date/time on the left ("12 Oct", "2026-10-12 21:04"). */
  date: ReactNode;
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Node colour: warn/danger for declined or failed entries. Default cyan. */
  tone?: 'default' | 'warn' | 'danger' | undefined;
  /** Trailing content (status chip). */
  aside?: ReactNode | undefined;
}

/** My requests / history timeline: mono date left, 1px vertical trace with hollow nodes. */
export function Timeline({ items, className }: { items: readonly TimelineItem[]; className?: string | undefined }) {
  return (
    <ol className={cx('al-timeline', className)}>
      {items.map((it) => (
        <li key={it.id} className="al-timeline__item" data-tone={it.tone && it.tone !== 'default' ? it.tone : undefined}>
          <span className="al-timeline__date">{it.date}</span>
          <span className="al-timeline__rail" aria-hidden="true">
            <span className="al-timeline__node" />
          </span>
          <div className="al-timeline__content">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="al-timeline__title">{it.title}</span>
              {it.aside}
            </div>
            {it.description ? <span className="al-timeline__desc">{it.description}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
