import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { routeTree } from '../../../router.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const formats = [
  {
    id: 7,
    name: 'DV',
    includeWhenRenaming: true,
    specifications: [{ implementation: 'releaseTitle', name: 'Dolby Vision', negate: false, required: true, fields: { pattern: '\\bDV\\b' } }],
  },
  {
    id: 8,
    name: 'x265 HD',
    includeWhenRenaming: false,
    specifications: [{ implementation: 'releaseTitle', name: 'x265', negate: false, required: false, fields: { pattern: 'x265' } }],
  },
];

const profile = (id: number, name: string, formatItems: Array<{ formatId: number; score: number }>) => ({
  id,
  name,
  upgradeAllowed: true,
  cutoff: 3,
  items: [{ kind: 'quality', qualityId: 3, allowed: true }],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems,
  languages: [],
});

const responses: Record<string, unknown> = {
  '/api/v1/customformat': formats,
  '/api/v1/customformat/schema': [],
  '/api/v1/qualityprofile': [
    profile(1, 'UHD', [
      { formatId: 7, score: 150 },
      { formatId: 8, score: -10000 },
    ]),
    profile(2, 'HD', [{ formatId: 7, score: 20 }]),
  ],
};

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = responses[url];
      return body === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
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

describe('Settings -> Custom formats', () => {
  it('shows each format card with condition tags and per-profile score tags', async () => {
    renderAt('/settings/customformats');
    const dv = (await screen.findByRole('button', { name: 'DV' })).closest('.al-item-card') as HTMLElement;
    await waitFor(() => expect(within(dv).getByLabelText('Scores for DV').querySelectorAll('.al-score')).toHaveLength(2));
    const scores = Array.from(within(dv).getByLabelText('Scores for DV').querySelectorAll('.al-score'));
    expect(scores.map((s) => s.textContent)).toEqual(['UHD +150', 'HD +20']);
    expect(scores[0]!.getAttribute('data-tier')).toBe('high');
    expect(within(dv).getByLabelText('Conditions in DV').textContent).toContain('Dolby Vision');

    const x265 = screen.getByRole('button', { name: 'x265 HD' }).closest('.al-item-card') as HTMLElement;
    const neg = within(x265).getByLabelText('Scores for x265 HD').querySelector('.al-score')!;
    expect(neg.textContent).toBe('UHD −10000');
    expect(neg.getAttribute('data-tier')).toBe('neg');
  });

  it('searches formats by name and condition name with "N of M", then clears', async () => {
    renderAt('/settings/customformats?q=dolby%20vision');
    const grid = await screen.findByRole('list', { name: 'Custom formats' });
    expect(await within(grid).findByRole('button', { name: 'DV' })).toBeTruthy();
    expect(within(grid).queryByRole('button', { name: 'x265 HD' })).toBeNull();
    expect(screen.getByText('1 of 2')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search this list' });
    fireEvent.change(box, { target: { value: 'no-such-format' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('button', { name: 'x265 HD' })).toBeTruthy();
  });

  it('rejects bad JSON in the import modal and accepts a valid format', async () => {
    renderAt('/settings/customformats');
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import custom formats' });
    const textarea = within(dialog).getByLabelText('Or paste JSON') as HTMLTextAreaElement;
    expect(textarea.className).toContain('al-input--mono');

    fireEvent.change(textarea, { target: { value: '{"name": ' } });
    expect(within(dialog).getByRole('alert').textContent).toMatch(/^Not valid JSON/);
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect((within(dialog).getByRole('button', { name: /^Import/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          name: 'HDR10',
          includeCustomFormatWhenRenaming: false,
          specifications: [{ name: 'HDR10', implementation: 'ReleaseTitleSpecification', negate: false, required: true, fields: { value: 'HDR10' } }],
        }),
      },
    });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('status').textContent).toContain('1 format ready');
    expect((within(dialog).getByRole('button', { name: 'Import format' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
