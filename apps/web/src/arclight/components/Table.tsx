import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { useVirtualRows } from '../hooks/use-virtual-rows.js';
import { SIZE } from '../tokens.js';
import { Button } from './Button.js';
import { Checkbox } from './Controls.js';
import { FloatBar } from './Pane.js';
import { EmptyState, Skeleton } from './States.js';
import { t } from '../../i18n/index.js';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  direction: SortDirection;
}
export type SortValue = string | number | boolean | null | undefined;
export type RowKey = string | number;

export interface Column<T> {
  key: string;
  /** Header text — rendered in the table's mono CAPS header style. */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Supplying a sort value makes the header clickable. */
  sortValue?: ((row: T) => SortValue) | undefined;
  align?: 'left' | 'right' | 'center' | undefined;
  width?: string | undefined;
  /** Mono 12px cell (sizes, dates, quality strings). */
  mono?: boolean | undefined;
  /** text-3 cell (secondary columns). */
  muted?: boolean | undefined;
  className?: string | undefined;
}

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by a column's sortValue; empty values always last. Same contract as the old helper. */
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

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[] | undefined;
  rowKey: (row: T) => RowKey;
  /** dense = 44px rows (default); rich = 62px rows (queue, wanted, requests). */
  density?: 'dense' | 'rich' | undefined;
  sortable?: boolean | undefined;
  sort?: SortState | null | undefined;
  defaultSort?: SortState | null | undefined;
  onSortChange?: ((sort: SortState) => void) | undefined;
  /** Rows arrive pre-sorted (server-side); the header only shows the state. */
  manualSort?: boolean | undefined;
  loading?: boolean | undefined;
  empty?: ReactNode | undefined;
  caption?: string | undefined;
  onRowClick?: ((row: T) => void) | undefined;
  /** Adds a checkbox column. Selection is controlled when `selected` is passed. */
  selectable?: boolean | undefined;
  selected?: ReadonlySet<RowKey> | undefined;
  defaultSelected?: ReadonlySet<RowKey> | undefined;
  onSelectionChange?: ((keys: Set<RowKey>) => void) | undefined;
  /** Label for a row's checkbox (default "Select row"). */
  rowLabel?: ((row: T) => string) | undefined;
  /**
   * Bulk actions for the selection; renders the bottom-centre FloatBar ("3 selected" …
   * actions … Cancel) while anything is selected.
   */
  bulkActions?: ((keys: Set<RowKey>, clear: () => void) => ReactNode) | undefined;
  /** Where the bulk bar renders (default fixed bottom-centre). */
  bulkPosition?: 'fixed' | 'inline' | undefined;
  /** Sticky header (default true). Give the table a `maxHeight` to scroll inside it. */
  stickyHeader?: boolean | undefined;
  maxHeight?: number | string | undefined;
  /**
   * Virtualise rows (fixed row height). Needs `maxHeight` (the scroll viewport). Use for
   * logs, history and release lists that run to thousands of rows.
   */
  virtualize?: boolean | undefined;
  className?: string | undefined;
}

/** `.al-table` — sortable, selectable, sticky header, optional virtualisation. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  density = 'dense',
  sortable = true,
  sort: controlledSort,
  defaultSort = null,
  onSortChange,
  manualSort = false,
  loading = false,
  empty,
  caption,
  onRowClick,
  selectable = false,
  selected: controlledSelected,
  defaultSelected,
  onSelectionChange,
  rowLabel,
  bulkActions,
  bulkPosition = 'fixed',
  stickyHeader = true,
  maxHeight,
  virtualize = false,
  className,
}: TableProps<T>) {
  const [internalSort, setInternalSort] = useState<SortState | null>(defaultSort);
  const sort = controlledSort !== undefined ? controlledSort : internalSort;
  const [internalSel, setInternalSel] = useState<ReadonlySet<RowKey>>(defaultSelected ?? new Set());
  const selected = controlledSelected ?? internalSel;
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => (rows ? (manualSort ? [...rows] : sortRows(rows, columns, sort)) : []), [rows, columns, sort, manualSort]);
  const rowHeight = density === 'rich' ? SIZE.rowRich : SIZE.rowDense;
  const range = useVirtualRows({
    count: sorted.length,
    rowHeight,
    scrollRef,
    enabled: virtualize,
    initialHeight: typeof maxHeight === 'number' ? maxHeight : 600,
  });
  const visible = virtualize ? sorted.slice(range.start, range.end) : sorted;

  const setSelection = (next: Set<RowKey>) => {
    if (controlledSelected === undefined) setInternalSel(next);
    onSelectionChange?.(next);
  };
  const allKeys = sorted.map(rowKey);
  const selectedCount = allKeys.filter((k) => selected.has(k)).length;
  const allSelected = allKeys.length > 0 && selectedCount === allKeys.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const toggleAll = () => setSelection(allSelected ? new Set() : new Set(allKeys));
  const toggleRow = (key: RowKey) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelection(next);
  };
  const clear = () => setSelection(new Set());

  const onHeaderClick = (key: string) => {
    const next = nextSort(sort, key);
    if (controlledSort === undefined) setInternalSort(next);
    onSortChange?.(next);
  };

  const colCount = columns.length + (selectable ? 1 : 0);

  if (loading && !rows) {
    return (
      <div className="al-skeleton-lines" aria-busy="true" aria-label={t('common.loading')} style={{ padding: 16 }}>
        {[70, 90, 60, 80].map((w) => (
          <Skeleton key={w} width={`${w}%`} height={12} />
        ))}
      </div>
    );
  }

  const wrapStyle: CSSProperties | undefined = maxHeight !== undefined ? { maxHeight } : undefined;

  return (
    <>
      <div ref={scrollRef} className={cx('al-table-wrap', className)} style={wrapStyle}>
        <table className={cx('al-table', density === 'rich' && 'al-table--rich', stickyHeader && 'al-table--sticky')} aria-rowcount={virtualize ? sorted.length + 1 : undefined}>
          {caption ? <caption className="al-sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {selectable ? (
                <th scope="col" className="al-table__check">
                  <Checkbox aria-label={t('arclight.table.selectAllRows')} checked={allSelected} indeterminate={someSelected} onChange={toggleAll} disabled={allKeys.length === 0} />
                </th>
              ) : null}
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
                    className={cx(col.align && col.align !== 'left' && `al-th--${col.align}`, col.className)}
                  >
                    {canSort ? (
                      <button type="button" className="al-table__sort" data-active={active} onClick={() => onHeaderClick(col.key)}>
                        {col.header}
                        <span aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</span>
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
            {virtualize && range.padTop > 0 ? (
              <tr className="al-table__spacer" aria-hidden="true">
                <td colSpan={colCount} style={{ height: range.padTop }} />
              </tr>
            ) : null}
            {visible.map((row, i) => {
              const key = rowKey(row);
              const isSel = selectable && selected.has(key);
              return (
                <tr
                  key={key}
                  aria-selected={selectable ? isSel : undefined}
                  aria-rowindex={virtualize ? range.start + i + 2 : undefined}
                  data-clickable={onRowClick ? true : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {selectable ? (
                    <td className="al-table__check" onClick={(e) => e.stopPropagation()}>
                      <Checkbox aria-label={rowLabel ? rowLabel(row) : t('arclight.table.selectRow')} checked={isSel} onChange={() => toggleRow(key)} />
                    </td>
                  ) : null}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cx(col.align && col.align !== 'left' && `al-td--${col.align}`, col.mono && 'al-td--mono', col.muted && 'al-td--muted', col.className)}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {virtualize && range.padBottom > 0 ? (
              <tr className="al-table__spacer" aria-hidden="true">
                <td colSpan={colCount} style={{ height: range.padBottom }} />
              </tr>
            ) : null}
          </tbody>
        </table>
        {sorted.length === 0 ? <div className="al-table__empty">{empty ?? <EmptyState title={t('arclight.table.nothingHereYet')} />}</div> : null}
      </div>
      {selectable && bulkActions && selectedCount > 0 ? (
        <FloatBar count={selectedCount} position={bulkPosition}>
          {bulkActions(new Set(allKeys.filter((k) => selected.has(k))), clear)}
          <Button variant="ghost" className="al-floatbar__cancel" onClick={clear}>
            {t('common.cancel')}
          </Button>
        </FloatBar>
      ) : null}
    </>
  );
}
