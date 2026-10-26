import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { routeTree } from '../../../router.js';
import { SLIDER_MAX, clampLimits, gbPerHour, sizeLabel } from './quality-page.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const defs = [
  { qualityId: 3, title: 'WEBDL-1080p', source: 'web', resolution: 1080, modifier: 'none', weight: 20, mediaTypes: ['series'], minSize: 5, preferredSize: 40, maxSize: null },
  { qualityId: 4, title: 'HDTV-720p', source: 'television', resolution: 720, modifier: 'none', weight: 10, mediaTypes: ['series'], minSize: 2, preferredSize: 10, maxSize: 60 },
];

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/v1/qualitydefinition') return new Response(JSON.stringify(defs), { status: 200 });
      const m = /^\/api\/v1\/qualitydefinition\/(\d+)$/.exec(url);
      if (m && method === 'PUT') return new Response(JSON.stringify({ ...defs.find((d) => d.qualityId === Number(m[1])), ...body }), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('quality size helpers', () => {
  it('formats sizes with units and keeps min <= preferred <= max', () => {
    expect(sizeLabel(12.5, true)).toBe('12.5 MB/min');
    expect(sizeLabel(null, true)).toBe('Unlimited');
    expect(gbPerHour(17.0666)).toBe('1.0');
    expect(clampLimits({ minSize: 50, preferredSize: 10, maxSize: 20 }, 'minSize')).toEqual({ minSize: 50, preferredSize: 50, maxSize: 50 });
  });
});

describe('Settings -> Quality', () => {
  it('shows min/preferred/max sliders with mono values and saves changed rows', async () => {
    renderAt('/settings/quality');
    const slider = (await screen.findByRole('slider', { name: 'WEBDL-1080p preferred' })) as HTMLInputElement;
    const row = slider.closest('tr') as HTMLElement;
    const values = within(row).getAllByTestId('size-value').map((v) => v.textContent);
    expect(values).toEqual(['5.0 MB/min', '40.0 MB/min', 'Unlimited']);
    const valueBox = within(row).getAllByTestId('size-value')[0]!.parentElement!;
    expect(valueBox.className).toContain('al-slider__value');
    expect(Number(within(row).getByRole('slider', { name: 'WEBDL-1080p maximum' }).getAttribute('max'))).toBe(SLIDER_MAX);
    // HDTV-720p sorts first (lower weight).
    expect(screen.getAllByRole('slider')[0]!.getAttribute('aria-label')).toBe('HDTV-720p minimum');

    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.change(slider, { target: { value: '55' } });
    expect(within(row).getAllByTestId('size-value')[1]!.textContent).toBe('55.0 MB/min');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('1 quality changed');
    fireEvent.click(within(bar).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/v1/qualitydefinition/3', body: { minSize: 5, preferredSize: 55, maxSize: null } });
  });
});
