import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { LogRecord } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';

afterEach(() => vi.unstubAllGlobals());

const rec = (id: number, message: string, over: Partial<LogRecord> = {}): LogRecord => ({ id, time: '2026-10-25T10:00:00.000Z', level: 'info', message, ...over });

function logRoutes() {
  const seen: URLSearchParams[] = [];
  const api = stubApi({
    '/api/v1/log': (_: RequestInit | undefined, url: URL) => {
      seen.push(url.searchParams);
      const search = url.searchParams.get('search');
      const page = Number(url.searchParams.get('page') ?? '1');
      if (search === 'nothing here') return { page: 1, pageSize: 50, totalRecords: 0, records: [] };
      if (search) return { page: 1, pageSize: 50, totalRecords: 1, records: [rec(3, 'Grab failed for Show.Name.S01E02', { component: 'download_client' })] };
      return { page, pageSize: 50, totalRecords: 120, records: [rec(page * 100 + 2, `page ${page} newest`), rec(page * 100 + 1, `page ${page} oldest`)] };
    },
    '/api/v1/log/file': [],
    '/api/v1/system/status': { paths: { logs: '/config/logs' } },
  });
  return { api, seen };
}

describe('System → Logs search', () => {
  it('sends ?q= to GET /log as search and shows the server total', async () => {
    const { seen } = logRoutes();
    renderAt('/system/logs?q=show%20name');
    expect(await screen.findByText('Grab failed for Show.Name.S01E02')).toBeTruthy();
    expect(seen.some((p) => p.get('search') === 'show name' && p.get('page') === '1')).toBe(true);
    expect(screen.getByText('1 result')).toBeTruthy();
    expect((screen.getByRole('searchbox', { name: 'Search logs' }) as HTMLInputElement).value).toBe('show name');
  });

  it('resets to page 1 when the search changes', async () => {
    const { seen } = logRoutes();
    renderAt('/system/logs');
    expect(await screen.findByText('page 1 newest')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('page 2 newest')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search logs' });
    fireEvent.change(box, { target: { value: 'grab' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Grab failed for Show.Name.S01E02')).toBeTruthy();
    const last = seen.at(-1)!;
    expect(last.get('search')).toBe('grab');
    expect(last.get('page')).toBe('1');
  });

  it('offers Clear search when nothing matches', async () => {
    logRoutes();
    renderAt('/system/logs?q=nothing%20here');
    const clear = await screen.findByRole('button', { name: 'Clear search' });
    fireEvent.click(clear);
    expect(await screen.findByText('page 1 newest')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search logs' }) as HTMLInputElement).value).toBe(''));
    expect(within(document.body).queryByText('1 result')).toBeNull();
  });
});
