import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Table, sortRows, type Column } from './table.js';

interface Row {
  id: number;
  name: string;
  size: number | null;
}

const rows: Row[] = [
  { id: 1, name: 'Episode 10', size: 300 },
  { id: 2, name: 'episode 2', size: null },
  { id: 3, name: 'Episode 1', size: 100 },
];

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
  { key: 'size', header: 'Size', cell: (r) => r.size ?? '—', sortValue: (r) => r.size },
  { key: 'id', header: 'Id', cell: (r) => r.id },
];

function bodyNames(): string[] {
  const body = screen.getAllByRole('rowgroup')[1]!;
  return within(body)
    .getAllByRole('row')
    .map((tr) => within(tr).getAllByRole('cell')[0]!.textContent ?? '');
}

describe('Table sorting', () => {
  it('renders rows in the given order when no sort is set', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(bodyNames()).toEqual(['Episode 10', 'episode 2', 'Episode 1']);
  });

  it('sorts ascending on first header click, using natural case-insensitive order', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole('button', { name: /name/i }));
    expect(bodyNames()).toEqual(['Episode 1', 'episode 2', 'Episode 10']);
    expect(screen.getByRole('columnheader', { name: /name/i }).getAttribute('aria-sort')).toBe('ascending');
  });

  it('toggles to descending on a second click', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const header = screen.getByRole('button', { name: /name/i });
    fireEvent.click(header);
    fireEvent.click(header);
    expect(bodyNames()).toEqual(['Episode 10', 'episode 2', 'Episode 1']);
    expect(screen.getByRole('columnheader', { name: /name/i }).getAttribute('aria-sort')).toBe('descending');
  });

  it('only makes columns with a sortValue clickable', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.queryByRole('button', { name: /^id/i })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBeNull();
  });

  it('disables all header sorting when sortable is false', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} sortable={false} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('honours defaultSort', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: 'size', direction: 'desc' }} />);
    expect(bodyNames()).toEqual(['Episode 10', 'Episode 1', 'episode 2']);
  });

  it('in controlled mode reports the next sort and renders what the parent passes', () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} sort={null} onSortChange={onSortChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /size/i }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'size', direction: 'asc' });
    // Parent has not applied it yet, so order is unchanged.
    expect(bodyNames()).toEqual(['Episode 10', 'episode 2', 'Episode 1']);

    rerender(
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} sort={{ key: 'size', direction: 'asc' }} onSortChange={onSortChange} />,
    );
    expect(bodyNames()).toEqual(['Episode 1', 'Episode 10', 'episode 2']);
  });

  it('does not reorder rows locally with manualSort', () => {
    render(
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} manualSort defaultSort={{ key: 'name', direction: 'asc' }} />,
    );
    expect(bodyNames()).toEqual(['Episode 10', 'episode 2', 'Episode 1']);
  });

  it('shows the empty state when there are no rows', () => {
    render(<Table columns={columns} rows={[]} rowKey={(r) => r.id} empty={<p>No episodes</p>} />);
    expect(screen.getByText('No episodes')).toBeTruthy();
  });
});

describe('sortRows', () => {
  it('keeps empty values last in both directions', () => {
    const asc = sortRows(rows, columns, { key: 'size', direction: 'asc' }).map((r) => r.size);
    const desc = sortRows(rows, columns, { key: 'size', direction: 'desc' }).map((r) => r.size);
    expect(asc).toEqual([100, 300, null]);
    expect(desc).toEqual([300, 100, null]);
  });

  it('returns a copy and leaves the input untouched', () => {
    const input = [...rows];
    const out = sortRows(input, columns, { key: 'name', direction: 'asc' });
    expect(out).not.toBe(input);
    expect(input.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
