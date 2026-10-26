import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, type Column } from './Table.js';
import { Button } from './Button.js';
import { computeVirtualRange } from '../hooks/use-virtual-rows.js';

interface Row {
  id: number;
  title: string;
  size: number | null;
}

const ROWS: Row[] = [
  { id: 1, title: 'Severance', size: 412 },
  { id: 2, title: 'Andor', size: 388 },
  { id: 3, title: 'Foundation', size: null },
  { id: 4, title: 'Dark', size: 96 },
];

const COLUMNS: Column<Row>[] = [
  { key: 'title', header: 'Title', sortValue: (r) => r.title, cell: (r) => r.title },
  { key: 'size', header: 'Size', sortValue: (r) => r.size, mono: true, align: 'right', cell: (r) => (r.size === null ? '—' : `${r.size} GB`) },
];

function titles(): string[] {
  const body = screen.getAllByRole('rowgroup')[1]!;
  return within(body)
    .getAllByRole('row')
    .map((tr) => tr.querySelectorAll('td')[tr.querySelector('.al-table__check') ? 1 : 0]?.textContent ?? '');
}

describe('Table sorting', () => {
  it('sorts ascending then descending on header clicks and reports aria-sort', async () => {
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const header = screen.getByRole('button', { name: /Title/ });
    await userEvent.click(header);
    expect(titles()).toEqual(['Andor', 'Dark', 'Foundation', 'Severance']);
    expect(screen.getByRole('columnheader', { name: /Title/ }).getAttribute('aria-sort')).toBe('ascending');
    await userEvent.click(header);
    expect(titles()).toEqual(['Severance', 'Foundation', 'Dark', 'Andor']);
    expect(screen.getByRole('columnheader', { name: /Title/ }).getAttribute('aria-sort')).toBe('descending');
  });

  it('keeps empty values last in both directions', async () => {
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const header = screen.getByRole('button', { name: /Size/ });
    await userEvent.click(header);
    expect(titles()).toEqual(['Dark', 'Andor', 'Severance', 'Foundation']);
    await userEvent.click(header);
    expect(titles()).toEqual(['Severance', 'Andor', 'Dark', 'Foundation']);
  });

  it('controlled sort only reports the change', async () => {
    const onSortChange = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} sort={null} onSortChange={onSortChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Title/ }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'title', direction: 'asc' });
    expect(titles()).toEqual(['Severance', 'Andor', 'Foundation', 'Dark']);
  });

  it('applies density, sticky header, mono and alignment classes', () => {
    const { container } = render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} density="rich" />);
    const table = container.querySelector('table')!;
    expect(table.className).toContain('al-table--rich');
    expect(table.className).toContain('al-table--sticky');
    const sizeCell = container.querySelector('tbody td:nth-child(2)')!;
    expect(sizeCell.className).toContain('al-td--mono');
    expect(sizeCell.className).toContain('al-td--right');
  });

  it('renders the empty state when there are no rows', () => {
    render(<Table columns={COLUMNS} rows={[]} rowKey={(r) => r.id} />);
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
  });
});

describe('Table selection', () => {
  it('toggles rows, drives the header checkbox (mixed → all) and marks rows aria-selected', async () => {
    const onSelectionChange = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} selectable rowLabel={(r) => `Select ${r.title}`} onSelectionChange={onSelectionChange} />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' }) as HTMLInputElement;
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Andor' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set([2]));
    expect(all.indeterminate).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Select Andor' }).closest('tr')!.getAttribute('aria-selected')).toBe('true');
    await userEvent.click(all);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set([1, 2, 3, 4]));
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    await userEvent.click(all);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
  });

  it('shows the bulk float bar with "N selected" and Cancel clears the selection', async () => {
    const remove = vi.fn();
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        selectable
        rowLabel={(r) => `Select ${r.title}`}
        bulkActions={(keys) => (
          <Button variant="danger" onClick={() => remove([...keys])}>
            Delete
          </Button>
        )}
      />,
    );
    expect(screen.queryByRole('toolbar')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Dark' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Severance' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    await userEvent.click(within(bar).getByRole('button', { name: 'Delete' }));
    expect(remove).toHaveBeenCalledWith([1, 4]);
    await userEvent.click(within(bar).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('row clicks fire onRowClick but checkbox clicks do not', async () => {
    const onRowClick = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} selectable rowLabel={(r) => `Select ${r.title}`} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByText('Dark'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[3]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Andor' }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});

describe('Table virtualisation', () => {
  it('computes the visible range with overscan and spacer heights', () => {
    expect(computeVirtualRange(1000, 44, 0, 440, 5)).toEqual({ start: 0, end: 16, padTop: 0, padBottom: (1000 - 16) * 44 });
    const mid = computeVirtualRange(1000, 44, 4400, 440, 5);
    expect(mid.start).toBe(95);
    expect(mid.end).toBe(116);
    expect(mid.padTop).toBe(95 * 44);
    expect(computeVirtualRange(0, 44, 0, 440, 5)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it('renders only a window of a long list', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: i, title: `Row ${i}`, size: i }));
    const { container } = render(<Table columns={COLUMNS} rows={many} rowKey={(r) => r.id} virtualize maxHeight={440} />);
    const dataRows = container.querySelectorAll('tbody tr:not(.al-table__spacer)');
    expect(dataRows.length).toBeGreaterThan(0);
    expect(dataRows.length).toBeLessThan(40);
    expect(container.querySelector('table')!.getAttribute('aria-rowcount')).toBe('1001');
  });
});

describe('Table expandable rows', () => {
  it('renders a full-width detail row under each expanded row only', () => {
    const { rerender } = render(
      <Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} selectable expandedRows={new Set([2])} renderExpanded={(r) => <p>Details of {r.title}</p>} />,
    );
    const detail = screen.getByText('Details of Andor').closest('tr')!;
    expect(detail.className).toContain('al-table__detail');
    expect(detail.querySelector('td')!.getAttribute('colspan')).toBe('3');
    expect(detail.previousElementSibling!.textContent).toContain('Andor');
    expect(screen.queryByText('Details of Dark')).toBeNull();
    rerender(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} expandedRows={new Set()} renderExpanded={(r) => <p>Details of {r.title}</p>} />);
    expect(screen.queryByText('Details of Andor')).toBeNull();
  });
});
