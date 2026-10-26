import { useMemo, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx.js';
import { EmptyState } from './empty-state.js';
import { LoadingBlock } from './spinner.js';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  direction: SortDirection;
}

export type SortValue = string | number | boolean | null | undefined;

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Supplying a sort value makes the column's header clickable. */
  sortValue?: (row: T) => SortValue;
  align?: 'left' | 'right' | 'center';
  width?: string;
  className?: string;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string | number;
  /** Turn header sorting on/off for the whole table (columns still need `sortValue`). */
  sortable?: boolean;
  /** Controlled sort. Omit to let the table manage it internally. */
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Rows arrive pre-sorted (server-side); the table only renders the header state. */
  manualSort?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  caption?: string;
  onRowClick?: (row: T) => void;
  className?: string;
}

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by a column's sortValue. Empty values (null/undefined/'') always sort last. */
export function sortRows<T>(rows: readonly T[], columns: ReadonlyArray<Column<T>>, sort: SortState | null | undefined): T[] {
  const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
  if (!sort || !col?.sortValue) return [...rows];
  const get = col.sortValue;
  const sign = sort.direction === 'asc' ? 1 : -1;
  const isEmpty = (v: SortValue) => v === null || v === undefined || v === '';
  return [...rows].sort((ra, rb) => {
    const a = get(ra);
    const b = get(rb);
    if (isEmpty(a) && isEmpty(b)) return 0;
    if (isEmpty(a)) return 1;
    if (isEmpty(b)) return -1;
    return sign * compare(a, b);
  });
}

export function nextSort(current: SortState | null | undefined, key: string): SortState {
  if (current?.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: 'asc' };
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  sortable = true,
  sort: controlledSort,
  defaultSort = null,
  onSortChange,
  manualSort = false,
  loading = false,
  empty,
  caption,
  onRowClick,
  className,
}: TableProps<T>) {
  const [internalSort, setInternalSort] = useState<SortState | null>(defaultSort);
  const sort = controlledSort !== undefined ? controlledSort : internalSort;

  const sorted = useMemo(
    () => (rows ? (manualSort ? [...rows] : sortRows(rows, columns, sort)) : []),
    [rows, columns, sort, manualSort],
  );

  const onHeaderClick = (key: string) => {
    const next = nextSort(sort, key);
    if (controlledSort === undefined) setInternalSort(next);
    onSortChange?.(next);
  };

  if (loading && !rows) return <LoadingBlock />;

  return (
    <div className={cx('table-wrap', className)}>
      <table className="table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col) => {
              const canSort = sortable && !!col.sortValue;
              const active = sort?.key === col.key;
              const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : canSort ? 'none' : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={col.width ? { width: col.width } : undefined}
                  className={cx(col.align && `align-${col.align}`, col.className)}
                >
                  {canSort ? (
                    <button type="button" className={cx('th-sort', active && 'th-sort-active')} onClick={() => onHeaderClick(col.key)}>
                      {col.header}
                      <span className="th-sort-indicator" aria-hidden="true">
                        {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'row-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className={cx(col.align && `align-${col.align}`, col.className)}>
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 ? (empty ?? <EmptyState title="Nothing here yet" />) : null}
    </div>
  );
}
