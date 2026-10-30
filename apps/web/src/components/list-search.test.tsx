import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ListSearchBar, ListSearchEmpty, useClientListSearch } from './list-search.js';

const ROWS = [
  { id: 1, title: 'The.Office.S01E01.1080p.WEB-DL', indexer: 'Nyaa' },
  { id: 2, title: 'Andor.S01E01.2160p', indexer: 'TorrentLeech' },
  { id: 3, title: 'Severance.S02E03', indexer: 'Nyaa' },
];

function Harness() {
  const s = useClientListSearch(ROWS, (r) => [r.title, r.indexer]);
  return (
    <div>
      <ListSearchBar value={s.q} onChange={s.setQ} shown={s.shown} total={s.total} />
      {s.rows && s.rows.length === 0 ? (
        <ListSearchEmpty query={s.q} onClear={s.clear} />
      ) : (
        <ul>
          {s.rows?.map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function renderAt(path: string) {
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: '/list', component: Harness });
  const router = createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => vi.useRealTimers());

describe('list search', () => {
  it('reads the query from the URL and shows "N of M"', async () => {
    renderAt('/list?q=nyaa');
    expect(await screen.findByText('The.Office.S01E01.1080p.WEB-DL')).toBeTruthy();
    expect(screen.getByText('Severance.S02E03')).toBeTruthy();
    expect(screen.queryByText('Andor.S01E01.2160p')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('2 of 3');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('nyaa');
  });

  it('debounces typing into the URL, forgiving separators', async () => {
    const router = renderAt('/list');
    const box = await screen.findByRole('searchbox');
    vi.useFakeTimers();
    fireEvent.change(box, { target: { value: 'the office web dl' } });
    // Nothing yet: the list still shows everything.
    expect(screen.getByText('Andor.S01E01.2160p')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByText('Andor.S01E01.2160p')).toBeNull();
    expect((router.state.location.search as Record<string, unknown>)['q']).toBe('the office web dl');
  });

  it('empty state clears the search', async () => {
    const router = renderAt('/list?q=nothing-like-this');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Andor.S01E01.2160p')).toBeTruthy();
    expect((router.state.location.search as Record<string, unknown>)['q']).toBeUndefined();
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('Enter commits at once and Escape clears', async () => {
    const router = renderAt('/list');
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'andor' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('1 of 3')).toBeTruthy();
    expect((router.state.location.search as Record<string, unknown>)['q']).toBe('andor');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(await screen.findByText('Severance.S02E03')).toBeTruthy();
    expect((router.state.location.search as Record<string, unknown>)['q']).toBeUndefined();
  });
});
