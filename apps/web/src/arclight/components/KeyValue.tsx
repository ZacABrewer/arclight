import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../cx.js';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Values are mono by default (rule 4: mono is for data); set false for prose values. */
  mono?: boolean | undefined;
  key?: string | undefined;
}

export interface KeyValueProps {
  items: readonly KeyValueItem[];
  /**
   * rows: label | value pairs (System → Status panes).
   * grid: label above value, N columns (Details meta grid: Path / Size / Episodes / Next airing).
   */
  layout?: 'rows' | 'grid' | undefined;
  /** Columns for the grid layout (default 4). */
  columns?: number | undefined;
  className?: string | undefined;
}

/** Key/value grid with mono values. Renders a <dl>. */
export function KeyValue({ items, layout = 'rows', columns = 4, className }: KeyValueProps) {
  const style = layout === 'grid' ? ({ '--al-kv-cols': columns } as CSSProperties) : undefined;
  return (
    <dl className={cx('al-kv', `al-kv--${layout}`, className)} style={style}>
      {items.map((item, i) => (
        <div className="al-kv__item" key={item.key ?? (typeof item.label === 'string' ? item.label : i)}>
          <dt className="al-kv__label">{item.label}</dt>
          <dd className={cx('al-kv__value', item.mono !== false && 'al-kv__value--mono')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
