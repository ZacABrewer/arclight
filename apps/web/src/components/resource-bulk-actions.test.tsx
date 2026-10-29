import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Checkbox } from '../arclight/index.js';
import { createToastStore } from '../lib/toast.js';
import { createQueryClient } from '../query-client.js';
import { useSelection } from './bulk-actions.js';
import { useResourceBulk } from './resource-bulk-actions.js';
import { ToastProvider } from './toast.js';

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Bravo' },
  { id: 3, name: 'Charlie' },
];

let bulkBodies: unknown[] = [];
let answer: (body: { ids: number[] }) => unknown = (body) => ({ ok: body.ids, failed: [] });

beforeEach(() => {
  bulkBodies = [];
  answer = (body) => ({ ok: body.ids, failed: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).split('?')[0]!;
      if (path === '/api/v1/bulk' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { ids: number[] };
        bulkBodies.push(body);
        return new Response(JSON.stringify(answer(body)), { status: 200 });
      }
      if (path === '/api/v1/tag') return new Response(JSON.stringify([{ id: 5, label: 'anime' }]), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function Grid() {
  const bulk = useResourceBulk('downloadclient', ROWS, (r) => r.id, (r) => r.name);
  return (
    <>
      {ROWS.map((r) => {
        const p = bulk.cardProps(r);
        return <Checkbox key={r.id} aria-label={p.label} checked={p.checked} onChange={p.onChange} />;
      })}
      {bulk.bar}
    </>
  );
}

function renderGrid() {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <Grid />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return toasts;
}

const bar = () => screen.getByRole('toolbar', { name: 'Bulk actions' });

describe('resource bulk bar', () => {
  it('appears on selection, offers select all, and runs a plain action for the selected ids', async () => {
    const toasts = renderGrid();
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Select Alpha'));
    expect(within(bar()).getByText('1 selected')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Select all 3' }));
    expect(within(bar()).getByText('3 selected')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(bulkBodies).toEqual([{ resource: 'downloadclient', action: 'disable', ids: [1, 2, 3] }]));
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Disable · 3 done'));
    // Everything worked, so the selection is gone with the bar.
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull());
  });

  it('confirms a delete with the count and keeps the failed ids selected', async () => {
    answer = (body) => ({ ok: body.ids.filter((id) => id !== 2), failed: [{ id: 2, error: 'in use' }] });
    const toasts = renderGrid();
    fireEvent.click(screen.getByLabelText('Select Alpha'));
    fireEvent.click(screen.getByLabelText('Select Bravo'));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete 2 items?' });
    expect(within(dialog).getByText(/2 selected items/)).toBeTruthy();
    expect(bulkBodies).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2' }));
    });
    await waitFor(() => expect(bulkBodies).toEqual([{ resource: 'downloadclient', action: 'delete', ids: [1, 2] }]));
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Delete · 1 done, 1 failed'));
    expect(toasts.list().find((t) => t.title.startsWith('Delete'))?.message).toBe('Bravo: in use');
    expect(within(bar()).getByText('1 selected')).toBeTruthy();
    expect((screen.getByLabelText('Select Bravo') as HTMLInputElement).checked).toBe(true);
  });
});

describe('useSelection', () => {
  function Probe({ keys }: { keys: number[] }) {
    const s = useSelection(keys);
    return (
      <>
        <button type="button" onClick={() => s.set([1, 2, 3])}>
          all
        </button>
        <output>{[...s.selected].join(',')}</output>
      </>
    );
  }

  it('drops keys that leave the list', () => {
    const { rerender } = render(<Probe keys={[1, 2, 3]} />);
    fireEvent.click(screen.getByText('all'));
    expect(screen.getByRole('status').textContent).toBe('1,2,3');
    rerender(<Probe keys={[1, 3]} />);
    expect(screen.getByRole('status').textContent).toBe('1,3');
  });
});
